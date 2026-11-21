// 设计实验的代码版本：工作目录建一个本地 Git 仓库，基线提交打上 ar-baseline 标签；
// 每个后台任务启动前提交一次，任务记录里保存提交号，结果就能对应到具体代码。
// 机器上没有 Git 时所有方法安静地返回 null / false，实验照常运行，只是没有版本记录。
import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const BASELINE_TAG = "ar-baseline";

const defaultIgnore = `# AutoResearch：这些目录体积大或会频繁变化，不纳入代码版本
.ar/
.cache/
.venv/
venv/
__pycache__/
*.pyc
node_modules/
wandb/
runs/
outputs/
checkpoints/
*.ckpt
*.pt
*.pth
*.safetensors
*.bin
`;

export class WorkspaceGit {
  constructor({ gitPath = "git", env = process.env, maxFileBytes = 20 * 1024 * 1024 } = {}) {
    this.gitPath = gitPath;
    this.env = env;
    this.maxFileBytes = maxFileBytes;
    this.availability = null;
  }

  run(cwd, args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
    return new Promise((resolvePromise, reject) => {
      execFile(this.gitPath, ["-C", cwd, "-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args], {
        windowsHide: true,
        maxBuffer,
        env: { ...this.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      }, (error, stdout, stderr) => {
        if (error) {
          error.message = `${error.message}\n${String(stderr ?? "").slice(0, 2000)}`;
          reject(error);
        } else resolvePromise(String(stdout));
      });
    });
  }

  async available() {
    if (this.availability === null) {
      this.availability = await new Promise((done) => execFile(this.gitPath, ["--version"], { windowsHide: true }, (error) => done(!error)));
    }
    return this.availability;
  }

  async isRepo(workspace) {
    try { return (await lstat(join(workspace, ".git"))).isDirectory(); }
    catch { return false; }
  }

  /** 新建仓库并提交基线。返回基线提交号；没有 Git 时返回 null。 */
  async init(workspace) {
    if (!(await this.available())) return null;
    if (!(await this.isRepo(workspace))) await this.run(workspace, ["init", "-q"]);
    const ignore = join(workspace, ".gitignore");
    try { await lstat(ignore); }
    catch { await writeFile(ignore, defaultIgnore, "utf8"); }
    const commit = await this.snapshot(workspace, "基线：从复现实验复制的代码");
    await this.run(workspace, ["tag", "-f", BASELINE_TAG]);
    return commit;
  }

  /** 超过上限的文件不进版本库（写进 .git/info/exclude；已跟踪的移出索引，文件本身不动）。 */
  async excludeLarge(workspace) {
    const output = await this.run(workspace, ["status", "--porcelain", "-uall", "-z"]);
    const parts = output.split("\0");
    const large = [];
    for (let index = 0; index < parts.length; index += 1) {
      const entry = parts[index];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      if (code[0] === "R" || code[0] === "C") index += 1;
      if (code.includes("D")) continue;
      try {
        const info = await lstat(join(workspace, path));
        if (info.isFile() && info.size > this.maxFileBytes) large.push({ path, tracked: code !== "??" });
      } catch { /* 文件已经不在了。 */ }
    }
    if (!large.length) return [];
    const excludeFile = join(workspace, ".git", "info", "exclude");
    await mkdir(join(workspace, ".git", "info"), { recursive: true });
    const existing = await readFile(excludeFile, "utf8").catch(() => "");
    const lines = large.map((item) => `/${item.path.replace(/([\\*?[\]!#])/g, "\\$1")}`).filter((line) => !existing.split(/\r?\n/).includes(line));
    if (lines.length) await appendFile(excludeFile, `${existing && !existing.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`, "utf8");
    const tracked = large.filter((item) => item.tracked).map((item) => item.path);
    if (tracked.length) await this.run(workspace, ["rm", "--cached", "-q", "--", ...tracked]);
    return large.map((item) => item.path);
  }

  /** 提交当前工作目录（没有改动也会提交，保证每个任务都有自己的提交号）。返回短提交号。 */
  async snapshot(workspace, message) {
    if (!(await this.available()) || !(await this.isRepo(workspace))) return null;
    await this.excludeLarge(workspace);
    await this.run(workspace, ["add", "-A"]);
    await this.run(workspace, ["-c", "user.name=AutoResearch", "-c", "user.email=autoresearch@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", message]);
    return (await this.run(workspace, ["rev-parse", "--short=12", "HEAD"])).trim();
  }

  /** 当前工作目录（含未提交的改动和新文件）相对基线的差异。 */
  async diff(workspace, { base = BASELINE_TAG, maxBytes = 400_000 } = {}) {
    if (!(await this.available()) || !(await this.isRepo(workspace))) return null;
    await this.excludeLarge(workspace);
    await this.run(workspace, ["add", "-A", "--intent-to-add"]);
    const numstat = await this.run(workspace, ["diff", "--numstat", base]);
    const files = numstat.split(/\r?\n/).filter(Boolean).map((line) => {
      const [added, removed, ...rest] = line.split("\t");
      return { path: rest.join("\t"), added: added === "-" ? null : Number(added), removed: removed === "-" ? null : Number(removed) };
    });
    const patch = await this.run(workspace, ["diff", "--no-color", base], { maxBuffer: 64 * 1024 * 1024 });
    const head = (await this.run(workspace, ["rev-parse", "--short=12", "HEAD"])).trim();
    return { base, head, files, patch: patch.length > maxBytes ? patch.slice(0, maxBytes) : patch, truncated: patch.length > maxBytes };
  }
}
