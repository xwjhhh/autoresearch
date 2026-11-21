import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export function gitHubEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"].includes(key.toUpperCase())) delete env[key];
  }
  if (process.platform === "win32") {
    const directories = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "GitHubCLI"), process.env.ProgramFiles && join(process.env.ProgramFiles, "GitHub CLI")].filter(Boolean);
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
    env[pathKey] = [env[pathKey], ...directories.filter((directory) => existsSync(join(directory, "gh.exe")))].filter(Boolean).join(delimiter);
  }
  return env;
}

export function runCommand(file, args, { cwd, input, env = process.env, signal, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, env, signal, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || stdout).trim().slice(-3500);
        reject(new Error(error.code === "ENOENT" ? `找不到 ${file}，请安装并加入 PATH。` : detail || `${file} 执行中断或失败。`));
      } else resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function githubRepository(remote) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim())?.[1] ?? null;
}

export const iterationLabels = {
  "app-iteration": "0e7b70",
  "iter:draft": "d4e4de",
  "iter:spec": "ba8c2a",
  "iter:implementing": "2479b5",
  "iter:review": "774fba",
  "iter:approved": "238443",
  "iter:abandoned": "899396",
  "iter:anomaly": "b60205",
};

export class IterationGitHub {
  constructor(repository, run = runCommand) {
    this.repository = repository;
    this.run = run;
  }

  gh(args, options) {
    return this.run("gh", args, { ...options, env: { ...gitHubEnvironment(), GH_PROMPT_DISABLED: "1" } });
  }

  async api(path = "", { method = "GET", body, paginate = false } = {}) {
    const args = ["api", "--hostname", "github.com", "--method", method, `repos/${this.repository}${path}`];
    if (body) args.push("--input", "-");
    if (paginate) args.push("--paginate", "--slurp");
    const stdout = await this.gh(args, { input: body ? JSON.stringify(body) : undefined });
    const value = stdout.trim() ? JSON.parse(stdout) : null;
    return paginate ? value.flat() : value;
  }

  async connect() {
    await this.gh(["auth", "status", "--hostname", "github.com"]);
    const repo = await this.api();
    if (!repo.permissions?.push || !repo.has_issues) throw new Error("GitHub 仓库需要写权限，并启用 Issues。");
    const existing = await this.api("/labels?per_page=100", { paginate: true });
    for (const [name, color] of Object.entries(iterationLabels)) {
      if (!existing.some((label) => label.name === name)) await this.api("/labels", { method: "POST", body: { name, color } });
    }
    return repo.default_branch;
  }

  async issue(title, body, marker) {
    const issues = await this.api("/issues?state=all&labels=app-iteration&per_page=100", { paginate: true });
    return issues.find((issue) => !issue.pull_request && issue.body?.includes(marker)) ??
      this.api("/issues", { method: "POST", body: { title, body, labels: ["app-iteration", "iter:draft"] } });
  }

  async pull(task, body) {
    const head = encodeURIComponent(`${this.repository.split("/")[0]}:${task.branch}`);
    const existing = await this.api(`/pulls?state=open&head=${head}`);
    return existing[0] ?? this.api("/pulls", { method: "POST", body: { title: task.title, body, head: task.branch, base: task.main } });
  }

  async comment(number, text, marker) {
    const comments = await this.api(`/issues/${number}/comments?per_page=100`, { paginate: true });
    if (!comments.some((comment) => comment.body?.includes(marker))) {
      await this.api(`/issues/${number}/comments`, { method: "POST", body: { body: `[AutoResearch] ${text}\n\n${marker}` } });
    }
  }

  async label(number, status) {
    const path = `/issues/${number}/labels`;
    const labels = await this.api(`${path}?per_page=100`, { paginate: true });
    const managed = Object.keys(iterationLabels).filter((name) => name.startsWith("iter:"));
    const names = labels.map(({ name }) => name).filter((name) => !managed.includes(name));
    if (status) names.push(status);
    if (!names.includes("app-iteration")) names.push("app-iteration");
    await this.api(path, { method: "PUT", body: { labels: names } });
  }

  status(sha, state, description) {
    return this.api(`/statuses/${sha}`, { method: "POST", body: { state, description, context: "autoresearch/verify" } });
  }

  async verified(sha) {
    const { statuses } = await this.api(`/commits/${sha}/status`);
    return statuses.find(({ context }) => context === "autoresearch/verify")?.state === "success";
  }

  merge(number, sha) {
    return this.api(`/pulls/${number}/merge`, { method: "PUT", body: { sha, merge_method: "squash" } });
  }
}
