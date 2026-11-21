import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runCommand } from "./iteration-github.mjs";

export function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    void runCommand("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { timeout: 5000 }).catch(() => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
  }
}

function validationProcess(file, args, { cwd, env, log, signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("验证已中断。"));
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", log.fd, log.fd], windowsHide: true, detached: process.platform !== "win32" });
    const stop = () => stopProcess(child);
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 10 * 60_000);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code) => { cleanup(); resolve(code ?? -1); });
  });
}

export async function acceptanceFiles(directory) {
  const names = await readdir(directory, { recursive: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names.map((name) => name.replaceAll("\\", "/")).filter((name) => /\.(?:test\.mjs|spec\.(?:mjs|ts))$/.test(name)).sort();
}

export async function unitTestFiles(workspace) {
  return (await Promise.all(["electron", "scripts", "tests/acceptance"].map(async (dir) =>
    (await acceptanceFiles(join(workspace, dir))).filter((name) => name.endsWith(".test.mjs") && (dir === "tests/acceptance" || !name.includes("/"))).map((name) => `${dir}/${name}`)))).flat();
}

const inherited = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|LOCALAPPDATA|APPDATA|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|TEMP|TMP|TMPDIR|LANG|LC_ALL|ELECTRON_CACHE|AUTORESEARCH_CODEX_PATH|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|ELECTRON_MIRROR|PLAYWRIGHT_BROWSERS_PATH)$/i;

export async function withIterationEnvironment(operation) {
  const temporary = await mkdtemp(join(await realpath(tmpdir()), "ar-isolated-"));
  try {
    const gitConfig = join(temporary, "gitconfig");
    const ghConfig = join(temporary, "gh");
    await mkdir(ghConfig);
    await writeFile(gitConfig, "");
    return await operation({
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.test(key))),
      GH_CONFIG_DIR: ghConfig, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never", NPM_CONFIG_USERCONFIG: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "core.sshCommand", GIT_CONFIG_VALUE_1: "ssh -F none -o BatchMode=yes -o IdentityAgent=none -o IdentityFile=none",
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function npmCommand(args) {
  return process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "npm.cmd", ...args]] : ["npm", args];
}

export async function validateCandidate(options) {
  return withIterationEnvironment((env) => runValidation({ ...options, env }));
}

const contained = (root, target) => {
  const suffix = relative(root, target);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
};

export async function seedDependencies(workspace, source, lock) {
  if (!source) return false;
  const lockBytes = await readFile(join(source, "package-lock.json")).catch(() => null);
  if (!lockBytes || createHash("sha256").update(lockBytes).digest("hex") !== lock) return false;
  const modules = await realpath(join(source, "node_modules")).catch(() => null);
  if (!modules || modules !== join(await realpath(source), "node_modules")) return false;
  const installed = await readFile(join(modules, ".package-lock.json"), "utf8").then(JSON.parse).catch(() => null);
  if (!installed?.packages || !await lstat(join(modules, "electron", "dist", "version")).catch(() => null)) return false;
  const locked = JSON.parse(lockBytes).packages;
  if (!Object.entries(installed.packages).every(([name, value]) => locked?.[name] && locked[name].version === value.version && locked[name].integrity === value.integrity)) return false;
  const stage = await mkdtemp(join(await realpath(workspace), ".ar-deps-"));
  try {
    const target = join(stage, "node_modules");
    await cp(modules, target, { recursive: true, verbatimSymlinks: true, filter: async (path) => {
      if ((await lstat(path)).isSymbolicLink()) {
        const link = await readlink(path);
        if (isAbsolute(link) || !contained(modules, resolve(dirname(path), link))) throw new Error("依赖目录包含外部链接。");
      }
      return true;
    } });
    await writeFile(join(target, ".autoresearch-iteration-lock"), lock);
    await rename(target, join(workspace, "node_modules"));
    return true;
  } catch { return false; }
  finally { await rm(stage, { recursive: true, force: true }); }
}

async function runValidation({ workspace, source, acceptance, output, signal, onStep, onProgress = () => {}, env }) {
  const lock = createHash("sha256").update(await readFile(join(workspace, "package-lock.json"))).digest("hex");
  const stamp = join(workspace, "node_modules", ".autoresearch-iteration-lock");
  const tests = await acceptanceFiles(join(workspace, acceptance));
  if (!tests.length) throw new Error("当前提交没有可运行的验收测试。");
  const steps = [];
  const installed = await lstat(join(workspace, "node_modules")).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (installed && !installed.isDirectory()) throw new Error("拒绝在链接的 node_modules 中验证，请使用独立依赖目录。");
  if ((await readFile(stamp, "utf8").catch(() => "")) !== lock) {
    if (!installed && source) await onProgress("准备依赖 · 检查可复用的本地安装");
    if (installed || !await seedDependencies(workspace, source, lock)) steps.push(["安装依赖", ...npmCommand(["ci", "--prefer-offline"])]);
  }
  steps.push(["单元测试（含历次验收）", "node", ["--test", ...await unitTestFiles(workspace)]], ["构建", ...npmCommand(["run", "build"])], ["全部场景测试（含历次验收）", "node", ["node_modules/playwright/cli.js", "test", "--config", "playwright.config.mjs"]]);
  const { open } = await import("node:fs/promises");
  for (const [index, [name, file, args]] of steps.entries()) {
    await onProgress(`${index + 1}/${steps.length} · ${name}`);
    const started = Date.now();
    const logFile = `${String(index + 1).padStart(2, "0")}.log`;
    const log = await open(join(output, logFile), "w");
    let exitCode;
    try {
      await log.writeFile(`${file} ${args.join(" ")}\n`);
      exitCode = await validationProcess(file, args, { cwd: workspace, env: { ...env, AUTORESEARCH_E2E_HIDDEN: "1", AUTORESEARCH_E2E_OUTPUT: join(output, "screenshots", String(index + 1)) }, log, signal });
    } catch (error) {
      await log.writeFile(`\n${error.message}\n`);
      exitCode = -1;
    } finally {
      await log.close();
    }
    await onStep({ name, command: [file, ...args].join(" "), exitCode, durationMs: Date.now() - started, logFile });
    if (signal.aborted) return "interrupted";
    if (exitCode !== 0) return "failure";
    if (name === "安装依赖") await writeFile(stamp, lock);
  }
  return "success";
}

const omitted = new Set([".git", ".ar", ".venv", "venv", "env", "envs", "environments", "conda", "node_modules", "__pycache__", ".cache", "wandb", "runs", "outputs", "checkpoints", "jobs", "provider-keys", "api-key.bin"]);

export async function copyPreviewData(source, destination) {
  const root = await realpath(source);
  const target = join(await realpath(dirname(destination)), basename(destination));
  if (contained(root, target)) throw new Error("候选快照不能写入正式数据目录。");
  await cp(root, target, { recursive: true, force: false, errorOnExist: true, filter: async (path) => {
    if (path === root) return true;
    const name = basename(path).toLowerCase();
    if (omitted.has(name) || /^\.(?:env(?:\.|$)|npmrc$)/.test(name) || /\.(?:ckpt|safetensors|pth|pem|key)$/.test(name)) return false;
    try { const info = await lstat(path); return info.isDirectory() || info.isFile(); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  } });
}

export async function launchCandidate({ workspace, directory, env, data, onExit }) {
  const profile = join(directory, "profile");
  await mkdir(profile, { recursive: true });
  const target = join(directory, "data");
  if (data) await copyPreviewData(data, target);
  else await runCommand("node", ["scripts/iteration-fixture.mjs", target], { cwd: workspace, env });
  const executable = join(workspace, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron");
  const child = spawn(executable, [workspace, "--profile", profile, "--data-dir", target, "--iteration-preview"], { cwd: workspace, env, stdio: "ignore", detached: process.platform !== "win32" });
  child.once("exit", onExit);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}
