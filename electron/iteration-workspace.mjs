import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { mkdir, lstat, readFile, open, appendFile, rm, realpath, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { runCommand } from "./iteration-github.mjs";

const safeDirectories = [".agents", ".github", "assets", "docs", "electron", "scripts", "src", "tests"];
const safeRootFiles = new Set([
  ".autoresearch-root", ".gitignore", "AGENTS.md", "INTEGRATION.md", "README.md", "codex-sdk.mjs", "index.html", "main.mjs", "package-lock.json", "package.json",
  "playwright.config.mjs", "tsconfig.json", "vite.config.ts",
]);
const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".sh", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"]);
const protectedSegments = new Set([".git", ".ar", ".cache", ".next", ".vite", "archive", "archives", "build", "coverage", "data", "dist", "node_modules", "playwright-report", "test-results", "target", "versions"]);
const sensitiveName = /api[-_.]?key|credential|password|secret|token|private[-_.]?key|^\.env(?:\.|$)/i;
const maximumFileSize = 3 * 1024 * 1024;
const maximumSelectedSize = 40 * 1024 * 1024;
const maximumInventory = 3000;
const contentSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{35,}|sk-proj-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/,
  /^\s*(?:OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|API_KEY|ACCESS_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY)\s*[:=]\s*["']?[^\s"'#]{12,}/im,
];
const relativeTo = (parent, child) => {
  const value = relative(parent, child);
  return value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(value);
};
const splitNul = (value) => value.split("\0").filter(Boolean);
const hash = (contents) => createHash("sha256").update(contents).digest("hex");

function pathspec(path) {
  return `:(literal)${path}`;
}

function allowedRoot(path) {
  if (safeRootFiles.has(path)) return true;
  return safeDirectories.some((directory) => path.startsWith(`${directory}/`));
}

export function workspacePathExclusion(path) {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === ".")) return "路径不安全";
  if (!allowedRoot(normalized)) return "不在源码纳入白名单内";
  const segments = normalized.split("/").map((part) => part.toLowerCase());
  if (segments.some((part) => protectedSegments.has(part))) return "归档、数据、依赖或构建目录";
  if (segments.some((part) => sensitiveName.test(part))) return "疑似凭据或本地密钥文件";
  const basename = segments.at(-1);
  if ([".env", ".env.local", ".npmrc", ".netrc", "credentials", "id_rsa", "id_ed25519"].includes(basename)) return "疑似本机凭据配置";
  const extension = normalized.slice(normalized.lastIndexOf("/") + 1).includes(".")
    ? normalized.slice(normalized.lastIndexOf(".")).toLowerCase()
    : "";
  if (!textExtensions.has(extension) && ![".autoresearch-root", ".gitignore", ".gitattributes", ".editorconfig"].includes(basename)) return "仅纳入可审阅的文本源码文件";
  if (/[\u0000-\u001f\u007f]/.test(normalized)) return "文件名包含控制字符";
  return null;
}

async function git(run, repository, args, options = {}) {
  return run("git", ["-c", "core.longpaths=true", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args], { cwd: repository, timeout: 180_000, ...options });
}

async function fileFingerprint(repository, path) {
  const parts = path.split("/");
  let absolute = repository;
  let fileStat;
  try {
    for (const [index, part] of parts.entries()) {
      absolute = join(absolute, part);
      fileStat = await lstat(absolute);
      if (fileStat.isSymbolicLink()) return { fingerprint: null, size: 0, reason: "文件路径经过符号链接" };
      if (index < parts.length - 1 && !fileStat.isDirectory()) return { fingerprint: null, size: 0, reason: "文件的上级路径不是普通目录" };
    }
    if (!fileStat.isFile()) return { fingerprint: null, size: 0, reason: "不是普通文件" };
    if (fileStat.size > maximumFileSize) return { fingerprint: null, size: fileStat.size, reason: "单文件超过 3 MiB 限制" };
    const contents = await readFile(absolute);
    if (contents.includes(0)) return { fingerprint: null, size: fileStat.size, reason: "二进制文件不纳入候选" };
    if (contentSecretPatterns.some((pattern) => pattern.test(contents.toString("utf8")))) return { fingerprint: `${fileStat.mode}:${hash(contents)}`, size: fileStat.size, reason: "内容疑似包含密钥或访问凭据" };
    return { fingerprint: `${fileStat.mode}:${hash(contents)}`, size: fileStat.size, reason: null };
  } catch (error) {
    if (error.code === "ENOENT") return { fingerprint: "deleted", size: 0, reason: null };
    throw error;
  }
}

export async function scanWorkspaceChanges(repository, run) {
  const baseSha = (await git(run, repository, ["rev-parse", "HEAD"])).trim();
  const roots = [...safeDirectories, ...[...safeRootFiles].filter((path) => !path.includes("/"))];
  const specs = roots.map(pathspec);
  const [tracked, untracked, baseFiles] = await Promise.all([
    git(run, repository, ["diff", "--name-only", "-z", "--no-renames", "HEAD", "--", ...specs]),
    git(run, repository, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...specs]),
    git(run, repository, ["ls-tree", "-r", "-z", "--name-only", baseSha, "--", ...specs]),
  ]);
  const trackedPaths = new Set(splitNul(tracked).map((path) => path.replaceAll("\\", "/")));
  const untrackedPaths = new Set(splitNul(untracked).map((path) => path.replaceAll("\\", "/")));
  const basePathSet = new Set(splitNul(baseFiles).map((path) => path.replaceAll("\\", "/")));
  const paths = [...new Set([...trackedPaths, ...untrackedPaths])].sort((left, right) => left.localeCompare(right));
  if (paths.length > maximumInventory) throw new Error(`源码白名单中有 ${paths.length} 个改动文件，超过 ${maximumInventory} 个的盘点上限；请先拆分或缩小改动范围。`);
  const files = [];
  for (const path of paths) {
    let reason = workspacePathExclusion(path);
    const state = await fileFingerprint(repository, path);
    reason ??= state.reason;
    const status = !basePathSet.has(path) ? "added" : state.fingerprint === "deleted" ? "deleted" : "modified";
    files.push({ path, status, eligible: !reason, reason, size: state.size, fingerprint: state.fingerprint });
  }
  return {
    baseSha,
    scannedAt: new Date().toISOString(),
    files,
    policy: "仅盘点明确源码目录和少数根配置文件；versions、data、凭据、依赖、构建产物、符号链接、二进制与大文件不会进入候选。",
  };
}

export async function assertWorkspaceSourcesUnchanged(repository, inventory, selected, run) {
  if (!Array.isArray(selected) || !selected.length || selected.length > maximumInventory || selected.some((path) => typeof path !== "string")) throw new Error("所选文件列表无效或为空。");
  const currentHead = (await git(run, repository, ["rev-parse", "HEAD"])).trim();
  if (currentHead !== inventory.baseSha) throw new Error("仓库 HEAD 已变化，请重新盘点后再生成或发布候选。");
  const byPath = new Map(inventory.files.map((file) => [file.path, file]));
  for (const path of selected) {
    const file = byPath.get(path);
    if (!file?.eligible) throw new Error(`文件不在本次盘点的可纳入清单中：${path}`);
    const current = await fileFingerprint(repository, path);
    if (current.reason || current.fingerprint !== file.fingerprint) throw new Error(`盘点后文件发生变化或不再符合纳入条件：${path}`);
  }
}

export async function createWorkspaceCommit({ repository, inventory, selected, worktree, branch, run }) {
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length) throw new Error("请明确选择至少一个不重复的纳入文件。");
  await assertWorkspaceSourcesUnchanged(repository, inventory, selected, run);
  const totalSize = selected.reduce((sum, path) => sum + (inventory.files.find((file) => file.path === path)?.size ?? 0), 0);
  if (totalSize > maximumSelectedSize) throw new Error("所选文件总大小超过 40 MiB 限制。");
  if (!/^organize\/workspace-[a-f0-9-]{36}$/.test(branch ?? "")) throw new Error("候选分支名不符合整理器约定。");
  await mkdir(join(worktree, ".."), { recursive: true });
  const index = join(worktree, "..", "candidate.index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  await git(run, repository, ["read-tree", inventory.baseSha], { env });
  try {
    const indexRecords = [];
    for (const path of selected) {
      const file = inventory.files.find((entry) => entry.path === path);
      if (file.status === "deleted") {
        const current = await fileFingerprint(repository, path);
        if (current.reason || current.fingerprint !== file.fingerprint) throw new Error(`删除状态在生成候选期间发生变化：${path}`);
        indexRecords.push(`0 ${"0".repeat(40)}\t${path}\0`);
        continue;
      }
      const contents = await readFile(join(repository, ...path.split("/")));
      if (hash(contents) !== file.fingerprint?.split(":").at(-1)) throw new Error(`读取期间文件内容发生变化，候选已停止：${path}`);
      const current = await fileFingerprint(repository, path);
      if (current.reason || current.fingerprint !== file.fingerprint) throw new Error(`读取期间文件不再符合纳入条件，候选已停止：${path}`);
      const blob = (await git(run, repository, ["hash-object", "-w", "--stdin", "--no-filters"], { env, input: contents })).trim();
      const details = await lstat(join(repository, ...path.split("/")));
      const mode = details.mode & 0o111 ? "100755" : "100644";
      indexRecords.push(`${mode} ${blob}\t${path}\0`);
    }
    await git(run, repository, ["update-index", "-z", "--index-info"], { env, input: indexRecords.join("") });
    const tree = (await git(run, repository, ["write-tree"], { env })).trim();
    const baseTree = (await git(run, repository, ["rev-parse", `${inventory.baseSha}^{tree}`])).trim();
    if (tree === baseTree) throw new Error("所选文件与基线提交相比没有可提交改动。");
    const sha = (await git(run, repository, ["commit-tree", tree, "-p", inventory.baseSha, "-m", `整理当前工作区 ${new Date().toISOString()}`])).trim();
    await git(run, repository, ["update-ref", `refs/heads/${branch}`, sha, "0".repeat(40)]);
    try {
      await git(run, repository, ["worktree", "add", worktree, branch]);
    } catch (error) {
      await git(run, repository, ["update-ref", "-d", `refs/heads/${branch}`, sha]).catch(() => {});
      throw error;
    }
    return { sha, branch, worktree };
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

function safeValidationEnvironment(tempDirectory) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:TOKEN|API_KEY|ACCESS_KEY|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH|PRIVATE_KEY|SIGNING|CERTIFICATE|PROXY_(?:USER|USERNAME)|^AWS_|^AZURE_|^ARM_|^GCP_|^GOOGLE_|^GCLOUD_|^CLOUDSDK_|^KUBECONFIG$|^DOCKER_CONFIG$)/i.test(key) || ["GH_HOST", "GH_CONFIG_DIR", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_AUTH_SOCK", "ELECTRON_RUN_AS_NODE", "CODEX_HOME", "NODE_OPTIONS", "NODE_PATH", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"].includes(key.toUpperCase()) || key.toUpperCase().startsWith("NPM_CONFIG_") || key.toUpperCase().startsWith("GIT_CONFIG_")) delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (!key.toUpperCase().endsWith("_PROXY")) continue;
    try {
      const proxy = new URL(env[key]);
      proxy.username = "";
      proxy.password = "";
      env[key] = proxy.toString();
    } catch { delete env[key]; }
  }
  const home = join(tempDirectory, "test-home");
  env.HOME = home;
  env.USERPROFILE = home;
  env.HOMEDRIVE = home.slice(0, 2);
  env.HOMEPATH = home.slice(2);
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
  env.GH_CONFIG_DIR = join(home, ".config", "gh");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(tempDirectory, "empty-gitconfig");
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  env.NPM_CONFIG_USERCONFIG = join(tempDirectory, "empty-npmrc");
  env.NPM_CONFIG_IGNORE_SCRIPTS = "false";
  env.NPM_CONFIG_GLOBALCONFIG = join(tempDirectory, "empty-global-npmrc");
  env.NPM_CONFIG_CACHE = join(tempDirectory, "npm-cache");
  env.AUTORESEARCH_HEADLESS_E2E = "1";
  env.NODE_ENV = "development";
  return env;
}

function stopValidation(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
  }
}

async function runNpmStep(worktree, args, environment, log, signal) {
  if (signal?.aborted) throw new Error("验证已停止。");
  const file = process.platform === "win32" ? "cmd.exe" : "npm";
  const commandArgs = process.platform === "win32" ? ["/d", "/c", "npm.cmd", ...args] : args;
  const output = await open(log, "w");
  const child = spawn(file, commandArgs, { cwd: worktree, env: environment, stdio: ["ignore", output.fd, output.fd], windowsHide: true, detached: process.platform !== "win32" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stopValidation(child); }, 10 * 60_000);
  const abort = () => stopValidation(child);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? -1));
    });
    if (signal?.aborted) throw new Error("验证已停止。");
    if (timedOut) return -1;
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await output.close();
  }
}

async function clearNpmrcFiles(directory, run) {
  const roots = [".agents", ".github", "assets", "docs", "electron", "scripts", "src", "tests"];
  const files = splitNul(await git(run, directory, ["ls-files", "-z", "--", ".npmrc", ...roots.map(pathspec), ...roots.map((path) => pathspec(`${path}/.npmrc`))]));
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    if (normalized === ".npmrc" || roots.some((root) => normalized.startsWith(`${root}/`) && normalized.split("/").at(-1).toLowerCase() === ".npmrc")) {
      await rm(join(directory, ...normalized.split("/")), { force: true });
    }
  }
}

async function configureValidationCheckout(testTree, run, env) {
  const files = [...safeRootFiles].filter((path) => !path.includes("/"));
  const directories = [".agents", ".github", "assets", "docs", "electron", "scripts", "src", "tests"];
  await git(run, testTree, ["sparse-checkout", "init", "--no-cone"], { env });
  await git(run, testTree, ["sparse-checkout", "set", "--no-cone", ...files.map((file) => `/${file}`), ...directories.map((directory) => `/${directory}/`)], { env });
}

export async function validateWorkspaceCandidate({ worktree, tempDirectory, repository, sha, branch, run = runCommand, signal, onStep = async () => {} }) {
  const pkg = JSON.parse(await readFile(join(worktree, "package.json"), "utf8"));
  if (pkg.name !== "autoresearch-desktop") throw new Error("候选工作树的 package.json 不再是 AutoResearch 桌面应用。");
  const testTree = join(tempDirectory, "test-tree");
  const env = safeValidationEnvironment(tempDirectory);
  await mkdir(join(env.HOME, ".config", "gh"), { recursive: true });
  await writeFile(join(tempDirectory, "empty-gitconfig"), "");
  await writeFile(join(tempDirectory, "empty-npmrc"), "");
  await writeFile(join(tempDirectory, "empty-global-npmrc"), "");
  const cloneArgs = ["clone", "--depth=1", "--no-hardlinks", "--no-local", "--no-checkout", "--single-branch", "--branch", branch, repository, testTree];
  await run("git", cloneArgs, { cwd: repository, env, timeout: 180_000 });
  await configureValidationCheckout(testTree, run, env);
  await git(run, testTree, ["checkout", "--detach", sha], { env });
  await git(run, testTree, ["remote", "remove", "origin"], { env });
  await git(run, testTree, ["config", "--local", "credential.helper", ""] , { env });
  await clearNpmrcFiles(testTree, run);
  await rm(join(testTree, "node_modules"), { recursive: true, force: true });
  const plan = [{ name: "安装依赖", args: ["ci"] }, { name: "单元测试", args: ["test"] }, { name: "构建", args: ["run", "build"] }];
  if (typeof pkg.scripts?.["test:e2e"] === "string") plan.push({ name: "端到端测试", args: ["run", "test:e2e"] });
  await mkdir(join(tempDirectory, "logs"), { recursive: true });
  const completedSteps = [];
  for (const [index, step] of plan.entries()) {
    const logFile = `${String(index + 1).padStart(2, "0")}.log`;
    const record = { name: step.name, command: `npm ${step.args.join(" ")}`, durationMs: 0, exitCode: null, logFile };
    const startedAt = Date.now();
    await onStep({ ...record, started: true });
    try { record.exitCode = await runNpmStep(testTree, step.args, env, join(tempDirectory, "logs", logFile), signal); }
    catch (error) {
      record.exitCode = -1;
      await appendFile(join(tempDirectory, "logs", logFile), `\n${error.message}\n`);
    }
    record.durationMs = Date.now() - startedAt;
    await onStep({ ...record, started: false });
    const { started, ...completed } = record;
    completedSteps.push(completed);
    if (record.exitCode !== 0) return { result: "failure", steps: completedSteps };
  }
  const dirty = await git(run, testTree, ["status", "--porcelain"], { env });
  if (dirty.trim()) throw new Error("验证脚本修改了候选源码；为避免测试脚本产生未审阅改动，候选不能发布。请查看测试日志并放弃本次候选。");
  return { result: "success", steps: completedSteps };
}

export async function workspaceDiff(repository, baseSha, candidateSha, run) {
  if (!baseSha || !candidateSha) return { sha: candidateSha ?? null, files: [] };
  const names = await git(run, repository, ["diff", "--no-renames", "--name-only", "-z", baseSha, candidateSha]);
  return { sha: candidateSha, files: splitNul(names).sort((left, right) => left.localeCompare(right)) };
}

export async function workspacePatch(repository, baseSha, candidateSha, file, run) {
  const { files } = await workspaceDiff(repository, baseSha, candidateSha, run);
  if (!files.includes(file)) throw new Error("此文件不在整理候选差异中。");
  const text = await git(run, repository, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", baseSha, candidateSha, "--", file]);
  return { text: text.slice(0, 400_000), truncated: text.length > 400_000 };
}

export async function readWorkspaceLog(tempDirectory, file) {
  if (!/^\d{2}\.log$/.test(file)) throw new Error("验证日志文件名无效。");
  const path = join(tempDirectory, "logs", file);
  const resolved = await realpath(path);
  if (!relativeTo(join(tempDirectory, "logs"), resolved)) throw new Error("验证日志路径越界。");
  return (await readFile(resolved, "utf8")).slice(-90_000);
}

export async function removeWorkspaceWorktree({ repository, worktree, ownedRoot, ownerParent, run }) {
  let target;
  try { target = await realpath(worktree); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!target) return;
  const root = await realpath(ownedRoot);
  if (!relativeTo(root, target) || root === target) throw new Error("候选工作树路径越界；已保留现场供检查。");
  if (ownerParent) {
    const parent = await realpath(ownerParent);
    if (!relativeTo(parent, root) || parent === root) throw new Error("候选目录不在应用管理的整理目录下；已保留现场供检查。");
  }
  await git(run, repository, ["worktree", "remove", "--force", target]);
}

export async function removeWorkspaceBranch(repository, branch, run) {
  if (!/^organize\/workspace-[a-f0-9-]{36}$/.test(branch ?? "")) throw new Error("候选分支名不符合整理器约定；已保留。");
  await git(run, repository, ["branch", "-D", branch]).catch((error) => {
    if (!/not found|not exist|cannot delete/i.test(error.message)) throw error;
  });
}
