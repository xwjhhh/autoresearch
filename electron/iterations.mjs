import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { IterationGitHub, gitHubEnvironment, githubRepository, runCommand } from "./iteration-github.mjs";
import { acceptanceFiles, launchCandidate, stopProcess, validateCandidate, withIterationEnvironment } from "./iteration-runtime.mjs";
import { applyLocalUpdate, prepareUpdateHelper, restoreLocalUpdate, startUpdateHelper } from "./iteration-update.mjs";
import { attachmentMetadata, localAttachmentPrompt } from "./chat-attachments.mjs";
import { assertWorkspaceSourcesUnchanged, createWorkspaceCommit, readWorkspaceLog, removeWorkspaceBranch, removeWorkspaceWorktree, scanWorkspaceChanges, validateWorkspaceCandidate, workspaceDiff, workspacePatch } from "./iteration-workspace.mjs";

const terminal = new Set(["merged", "abandoned", "anomaly"]);
const labelFor = { draft: "iter:draft", spec: "iter:spec", implementing: "iter:implementing", verifying: "iter:implementing", review: "iter:review", approved: "iter:approved", merging: "iter:approved", abandoned: "iter:abandoned", anomaly: "iter:anomaly" };
const freezeSupport = ["tests/e2e/electron-fixture.mjs", "scripts/iteration-fixture.mjs", "playwright.config.mjs"];
const now = () => new Date().toISOString();
const message = (text, max = 6000) => typeof text === "string" ? text.trim().slice(0, max) : "";
const commitPattern = /^[a-f0-9]{40}$/;
const within = (parent, child) => {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
};

export class AppIterations {
  constructor({ profile, agent, getDataRoot, appRoot, restart, resolveAttachments = async () => [], run = runCommand, verify = validateCandidate, validateWorkspace = validateWorkspaceCandidate, launch = launchCandidate, github = (repository) => new IterationGitHub(repository, run) }) {
    this.profile = profile;
    this.root = join(profile, "iterations");
    this.agent = agent;
    this.resolveAttachments = resolveAttachments;
    this.getDataRoot = getDataRoot;
    this.appRoot = appRoot;
    this.restart = restart;
    this.run = run;
    this.verify = verify;
    this.validateWorkspace = validateWorkspace;
    this.launch = launch;
    this.github = github;
    this.state = { binding: null, tasks: [], retryLimit: 5, organizer: null, organizerHistory: [] };
    this.writes = Promise.resolve();
    this.ready = this.load();
    this.active = null;
    this.preview = null;
    this.approvals = new Map();
    this.stream = null;
  }

  async load() {
    try { this.state = JSON.parse(await readFile(join(this.root, "state.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    this.state.binding ??= null;
    this.state.tasks ??= [];
    this.state.retryLimit ??= 5;
    this.state.organizerHistory ??= [];
    if (["preparing", "validating"].includes(this.state.organizer?.status)) {
      this.state.organizer.status = "failed";
      this.state.organizer.error = "应用在候选验证过程中关闭；可查看保留的日志并放弃候选。";
    } else if (this.state.organizer?.status === "publishing") {
      this.state.organizer.status = "tested";
      this.state.organizer.error = "推送或创建 PR 时应用关闭；请重新审阅并批准当前候选以安全重试。";
    }
    for (const task of this.state.tasks) {
      if (!["verifying", "merging"].includes(task.status)) continue;
      task.status = "review";
      task.approval = null;
      task.error = "上次操作已中断，可以检查远程状态并继续。";
      const record = task.verifications.at(-1);
      if (record?.result === "pending") {
        record.result = "interrupted";
        record.finishedAt = now();
        this.queue(task, "status", { sha: record.sha, state: "error", description: "本地验证已中断" });
        this.audit(task, `验证 #${record.id} · ${record.sha} · 中断`);
      }
      this.labels(task);
    }
    await this.save();
  }

  save() {
    const contents = JSON.stringify(this.state, null, 2);
    const write = this.writes.then(async () => {
      await mkdir(this.root, { recursive: true });
      const temporary = join(this.root, `state-${randomUUID()}.tmp`);
      await writeFile(temporary, contents);
      await rename(temporary, join(this.root, "state.json"));
    });
    this.writes = write.catch(() => {});
    return write;
  }

  git(cwd, ...args) {
    return this.run("git", ["-c", "core.longpaths=true", "-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"), ...args], { cwd, env: { ...gitHubEnvironment(), GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }, timeout: 180_000 }).then((result) => result.trimEnd());
  }

  task(id) {
    const task = this.state.tasks.find((item) => item.id === id);
    if (!task) throw new Error("找不到迭代任务。");
    return task;
  }

  directory(task) { return join(this.root, String(task.number || task.id)); }
  workspace(task) { return join(this.directory(task), "worktree"); }
  organizerRoot(candidate = this.state.organizer) {
    if (!candidate || !/^[a-f0-9-]{36}$/i.test(candidate.id)) throw new Error("整理候选标识无效。");
    return join(this.root, "workspace-organizer", candidate.id);
  }
  organizerWorktree(candidate = this.state.organizer) { return join(this.organizerRoot(candidate), "candidate"); }
  acceptance(task) { return `tests/acceptance/iter-${task.number}`; }
  hub(task) { return this.github(task.repository); }
  head(task) { return this.git(this.workspace(task), "rev-parse", "HEAD"); }
  frozenPaths(task) { return [this.acceptance(task), ...freezeSupport]; }
  async tree(task, sha) {
    const files = await this.git(this.workspace(task), "ls-tree", "-r", "-z", sha, "--", ...this.frozenPaths(task));
    return createHash("sha256").update(files).digest("hex");
  }

  async localUpdateMode(binding) {
    if (!this.appRoot || !this.restart) return "packaged";
    return await realpath(binding.path) === await realpath(this.appRoot) ? "source" : "other";
  }

  async snapshot() {
    await this.ready;
    if (!this.active) await this.collectUpdate();
    const { binding } = this.state;
    let repository = null;
    if (binding) {
      try {
        const [head, changes, mainHead, commits] = await Promise.all([
          this.git(binding.path, "rev-parse", "HEAD"), this.git(binding.path, "status", "--porcelain"),
          this.git(binding.path, "rev-parse", `refs/remotes/${binding.remote}/${binding.main}`).catch(() => null),
          this.git(binding.path, "log", "--all", "-20", "--format=%H%x09%s"),
        ]);
        repository = { ...binding, head, dirty: Boolean(changes), mainHead, updateMode: await this.localUpdateMode(binding), commits: commits.split("\n").filter(Boolean).map((line) => ({ sha: line.slice(0, 40), title: line.slice(41) })) };
      } catch (error) { repository = { ...binding, error: error.message }; }
    }
    return { repository, localUpdate: this.state.localUpdate, updatePending: Boolean(this.state.updatePending), updateError: this.state.updateError, retryLimit: this.state.retryLimit, runtime: this.state.runtime ?? "app-server", access: this.state.access ?? "full", approvals: [...this.approvals.values()].map(({ card }) => card), stream: this.stream, tasks: this.state.tasks.map(({ outbox, ...task }) => ({ ...task, pendingSync: outbox.length, trialItems: this.trialItems(task) })), active: this.active?.name ?? null, preview: this.preview ? { id: this.preview.id, sha: this.preview.sha } : null, organizer: this.state.organizer ?? null };
  }

  async perform(action, input = {}) {
    await this.ready;
    if (action === "stop") { if (!["update", "restore"].includes(this.active?.name)) this.active?.controller.abort(); return; }
    if (action === "stopPreview") { await this.stopPreview(); return; }
    if (action === "feedback") return this.addFeedback(input.id, input.text, input.attachmentIds);
    if (action === "decideAgentApproval") return this.decideAgentApproval(input);
    const handlers = {
      bind: () => this.bind(input.path), settings: () => this.updateSettings(input),
      create: () => this.create(input), sync: () => this.refresh(task), draft: () => this.draft(task, input.text, input.attachmentIds),
      confirm: () => this.confirm(task, input.sha), implement: () => this.implement(task, input.text, input.attachmentIds),
      validate: () => this.validateOnly(task), approve: () => this.approve(task, input.sha),
      merge: () => this.merge(task), abandon: () => this.abandon(task, input.text), preview: () => this.startPreview(task, input),
      trial: () => this.recordTrial(task, input),
      revert: () => this.revert(task), update: () => this.update(task), restore: () => this.restore(),
      workspaceScan: () => this.scanWorkspace(), workspacePrepare: () => this.prepareWorkspaceCandidate(input.files),
      workspaceApprove: () => this.approveWorkspaceCandidate(input), workspacePublish: () => this.publishWorkspaceCandidate(),
      workspaceAbandon: () => this.abandonWorkspaceCandidate(), workspaceCleanup: () => this.cleanupPublishedWorkspaceCandidate(),
    };
    if (!Object.hasOwn(handlers, action)) throw new Error("未知的迭代操作。");
    if (this.active || this.state.updatePending) throw new Error("已有迭代操作或本地更新正在运行。");
    const organizerAction = action.startsWith("workspace");
    if (this.preview && (organizerAction || ["draft", "implement", "validate", "merge", "update", "restore"].includes(action))) throw new Error("请先停止候选预览。");
    const globalAction = ["bind", "settings", "create", "restore", "workspaceScan", "workspacePrepare", "workspaceApprove", "workspacePublish", "workspaceAbandon", "workspaceCleanup"].includes(action);
    const task = !globalAction && input.id ? this.task(input.id) : null;
    if (!task && !globalAction) throw new Error("请先选择一个迭代任务。");
    const controller = new AbortController();
    this.active = { name: action, controller };
    const job = Promise.resolve().then(async () => {
      if (task) task.error = null;
      try { await handlers[action](); }
      catch (error) {
        if (task) task.error = controller.signal.aborted ? "操作已停止，可以继续。" : error.message;
        if (organizerAction && this.state.organizer) this.state.organizer.error = controller.signal.aborted ? "操作已停止；候选保留供检查或放弃。" : error.message;
        throw error;
      } finally { await this.save(); }
    });
    this.active.promise = job;
    try { await job; } finally { this.active = null; }
  }

  async shutdown() {
    this.active?.controller.abort();
    await this.active?.promise.catch(() => {});
    await this.stopPreview();
  }

  async checkDrift() {
    await this.ready;
    if (this.active || this.preview) return;
    const task = this.state.tasks.find((item) => item.pr && !terminal.has(item.status));
    if (!task) return;
    const prior = task.sha;
    const cwd = this.workspace(task);
    const remote = await this.hub(task).api("/pulls/" + task.pr);
    const [local, changes] = remote.state === "open" && !remote.merged ? await Promise.all([
      this.head(task), task.freeze && this.git(cwd, "status", "--porcelain", "--", ...this.frozenPaths(task)),
    ]) : [null, null];
    if (this.active || this.preview || task.sha !== prior || terminal.has(task.status)) return;
    if (changes || local !== prior || remote.head?.sha !== prior || remote.state !== "open" || remote.merged) await this.perform("sync", { id: task.id });
  }

  async bind(path) {
    if (this.state.tasks.some((task) => !terminal.has(task.status) || task.outbox.length)) throw new Error("请先完成当前任务及其 GitHub 同步。");
    if (this.state.organizer && !["published", "abandoned"].includes(this.state.organizer.status)) throw new Error("请先完成或放弃当前工作区整理候选，再更换源码仓库。");
    const location = await realpath(message(path, 2000));
    const root = await realpath(await this.git(location, "rev-parse", "--show-toplevel"));
    const remoteNames = (await this.git(root, "remote")).split(/\r?\n/).filter(Boolean).sort((left, right) => Number(right === "origin") - Number(left === "origin"));
    for (const remote of remoteNames) {
      const url = await this.git(root, "remote", "get-url", remote);
      const repository = githubRepository(url);
      if (!repository) continue;
      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (pkg.name !== "autoresearch-desktop") throw new Error("请选择包含 AutoResearch 桌面应用的仓库根目录。");
      const main = await this.github(repository).connect();
      const binding = { path: root, repository, remote, main, https: url.startsWith("https:") };
      await this.fetch(binding);
      this.state.binding = binding;
      return;
    }
    throw new Error("仓库未配置 github.com 远程地址。");
  }

  updateSettings({ limit = this.state.retryLimit, runtime = this.state.runtime ?? "app-server", access = this.state.access ?? "full" }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !["app-server", "sdk"].includes(runtime) || !["full", "restricted"].includes(access)) throw new Error("验证失败上限须为 1 到 20 次，并选择有效的运行时和 Agent 权限。");
    this.state.retryLimit = limit;
    this.state.runtime = runtime;
    this.state.access = access;
  }

  async assertOrganizerIdle() {
    if (!this.state.binding) throw new Error("请先绑定 AutoResearch 源码仓库。");
    if (this.state.tasks.some((task) => !terminal.has(task.status) || task.outbox.length)) throw new Error("请先完成所有应用迭代任务及 GitHub 同步，再整理当前工作区。");
    if (this.preview) throw new Error("请先停止正在运行的候选预览。");
  }

  async scanWorkspace() {
    await this.assertOrganizerIdle();
    const prior = this.state.organizer;
    if (prior && !["published", "abandoned"].includes(prior.status)) throw new Error("已有整理候选，请先审阅或放弃后再重新盘点。");
    if (prior?.status === "published") {
      await this.removeOrganizerWorktree(prior);
      if (prior.ownsBranch) await removeWorkspaceBranch(prior.repositoryPath, prior.branch, this.run);
      await this.removeOrganizerFiles(prior);
      this.state.organizerHistory.unshift({ id: prior.id, status: prior.status, sha: prior.sha, prUrl: prior.prUrl, title: prior.title, createdAt: prior.createdAt });
      this.state.organizerHistory = this.state.organizerHistory.slice(0, 20);
    }
    const remoteHead = await this.fetch(this.state.binding);
    const inventory = await scanWorkspaceChanges(this.state.binding.path, this.run);
    if (remoteHead !== inventory.baseSha) throw new Error("本地 HEAD 与 GitHub 主线不一致。请先同步到远程主线，再扫描未提交工作区，避免候选夹带未审阅提交。");
    this.state.organizer = {
      id: randomUUID(), status: "scanned", repositoryPath: this.state.binding.path, repository: this.state.binding.repository,
      remote: this.state.binding.remote, main: this.state.binding.main, https: this.state.binding.https,
      title: `整理当前工作区 ${inventory.files.filter((file) => file.eligible).length} 个候选文件`,
      inventory, selected: [], steps: [], createdAt: now(), error: null,
    };
    await this.save();
  }

  async prepareWorkspaceCandidate(selected) {
    await this.assertOrganizerIdle();
    const candidate = this.state.organizer;
    if (!candidate || candidate.status !== "scanned") throw new Error("请先盘点工作区，并选择准备纳入的文件。");
    if (!Array.isArray(selected) || !selected.length) throw new Error("请至少勾选一个文件。");
    const unique = [...new Set(selected)];
    if (unique.length !== selected.length) throw new Error("文件清单中有重复项，请重新选择。");
    await assertWorkspaceSourcesUnchanged(candidate.repositoryPath, candidate.inventory, unique, this.run);
    const branch = `organize/workspace-${candidate.id}`;
    candidate.selected = unique;
    candidate.branch = branch;
    candidate.status = "preparing";
    candidate.steps = [];
    candidate.currentStep = null;
    candidate.error = null;
    await this.save();
    const worktree = this.organizerWorktree(candidate);
    const root = this.organizerRoot(candidate);
    try {
      const commit = await createWorkspaceCommit({ repository: candidate.repositoryPath, inventory: candidate.inventory, selected: unique, worktree, branch, run: this.run });
      candidate.sha = commit.sha;
      candidate.ownsBranch = true;
      candidate.status = "validating";
      await this.save();
      const validation = await this.validateWorkspace({
        repository: candidate.repositoryPath, worktree, tempDirectory: root, sha: commit.sha, branch,
        run: this.run, signal: this.active.controller.signal,
        onStep: async (step) => {
          candidate.currentStep = step.started ? step.name : null;
          const position = candidate.steps.findIndex((existing) => existing.logFile === step.logFile);
          const saved = { name: step.name, command: step.command, durationMs: step.durationMs, exitCode: step.exitCode, logFile: step.logFile };
          if (position < 0) candidate.steps.push(saved);
          else candidate.steps[position] = saved;
          await this.save();
        },
      });
      candidate.steps = validation.steps;
      candidate.currentStep = null;
      candidate.status = validation.result === "success" ? "tested" : "failed";
      candidate.error = validation.result === "failure" ? "自动验证未全部通过；检查日志后放弃候选或重新盘点。" : null;
      candidate.testedAt = now();
      await this.save();
      if (validation.result !== "success") throw new Error(candidate.error);
    } catch (error) {
      candidate.status = "failed";
      candidate.currentStep = null;
      candidate.error = error.message;
      await this.save();
      throw error;
    }
  }

  async pushApprovedWorkspaceCandidate() {
    await this.assertOrganizerIdle();
    const candidate = this.state.organizer;
    if (!candidate || candidate.status !== "tested" || candidate.approval?.sha !== candidate.sha || JSON.stringify(candidate.approval?.files) !== JSON.stringify(candidate.selected) || !candidate.steps.length || candidate.steps.some((step) => step.exitCode !== 0)) throw new Error("推送前必须先由你批准当前这一份候选差异。");
    await assertWorkspaceSourcesUnchanged(candidate.repositoryPath, candidate.inventory, candidate.selected, this.run);
    const diff = await workspaceDiff(candidate.repositoryPath, candidate.inventory.baseSha, candidate.sha, this.run);
    if (diff.files.length !== candidate.selected.length || diff.files.some((file) => !candidate.selected.includes(file))) throw new Error("候选差异与已选文件清单不完全一致；已阻止发布。");
    const head = (await this.git(this.organizerWorktree(candidate), "rev-parse", "HEAD")).trim();
    const changes = await this.git(this.organizerWorktree(candidate), "status", "--porcelain");
    if (head !== candidate.sha || changes) throw new Error("候选工作树的提交或内容已变化；请重新盘点和验证。");
    const binding = { path: candidate.repositoryPath, repository: candidate.repository, remote: candidate.remote, main: candidate.main, https: candidate.https };
    const remoteHead = await this.fetch(binding);
    if (remoteHead !== candidate.inventory.baseSha) {
      candidate.approval = null;
      candidate.error = "远程主线已变化；请放弃候选、重新盘点和验证后再审阅。";
      await this.save();
      throw new Error(candidate.error);
    }
    candidate.status = "publishing";
    candidate.error = null;
    await this.save();
    try {
      const remoteRef = await this.git(binding.path, ...this.credentials(binding), "ls-remote", "--heads", binding.remote, `refs/heads/${candidate.branch}`);
      const remoteSha = remoteRef.trim().split(/\s+/)[0] || null;
      if (remoteSha && remoteSha !== candidate.sha) throw new Error("远程已有不同提交的同名候选分支；为避免覆盖，已停止发布。");
      if (!remoteSha) await this.git(binding.path, ...this.credentials(binding), "push", `--force-with-lease=refs/heads/${candidate.branch}:`, binding.remote, `${candidate.sha}:refs/heads/${candidate.branch}`);
      candidate.status = "pushed";
      await this.save();
    } catch (error) {
      candidate.status = "tested";
      candidate.error = error.message;
      await this.save();
      throw error;
    }
    await this.publishWorkspaceCandidate();
  }

  async publishWorkspaceCandidate() {
    await this.assertOrganizerIdle();
    const candidate = this.state.organizer;
    if (!candidate || candidate.status !== "pushed" || candidate.approval?.sha !== candidate.sha || JSON.stringify(candidate.approval?.files) !== JSON.stringify(candidate.selected)) throw new Error("推送前必须先由你批准当前这一份候选差异。");
    await assertWorkspaceSourcesUnchanged(candidate.repositoryPath, candidate.inventory, candidate.selected, this.run);
    if (!candidate.steps.length || candidate.steps.some((step) => step.exitCode !== 0)) throw new Error("只有全部自动验证通过的候选可以发布供审阅。");
    const diff = await workspaceDiff(candidate.repositoryPath, candidate.inventory.baseSha, candidate.sha, this.run);
    if (diff.files.length !== candidate.selected.length || diff.files.some((file) => !candidate.selected.includes(file))) throw new Error("候选差异与已批准的文件清单不一致；已阻止创建 Pull Request。");
    const head = (await this.git(this.organizerWorktree(candidate), "rev-parse", "HEAD")).trim();
    const changes = await this.git(this.organizerWorktree(candidate), "status", "--porcelain");
    if (head !== candidate.sha || changes) throw new Error("候选工作树的提交或内容已变化；已阻止创建 Pull Request。");
    const binding = { path: candidate.repositoryPath, remote: candidate.remote, main: candidate.main, https: candidate.https };
    if (await this.fetch(binding) !== candidate.inventory.baseSha) throw new Error("远程主线已变化；已阻止创建基于旧主线的 Pull Request。");
    const remoteSha = await this.organizerRemoteBranchSha(candidate);
    if (remoteSha && remoteSha !== candidate.sha) throw new Error("远程候选分支已变化；已阻止创建 Pull Request。");
    if (!remoteSha) await this.git(binding.path, ...this.credentials(binding), "push", `--force-with-lease=refs/heads/${candidate.branch}:`, binding.remote, `${candidate.sha}:refs/heads/${candidate.branch}`);
    const files = candidate.selected.map((file) => `- \`${file}\``).join("\n");
    const checks = candidate.steps.map((step) => `- ${step.name}: passed`).join("\n");
    const body = ["## 整理范围", files, "", "## 自动验证", checks, "", "此候选由 AutoResearch 工作区整理器生成。此操作仅推送分支并创建 Pull Request；不会自动合并。请在审阅差异后由维护者决定是否合并。"].join("\n");
    const pull = await this.hub({ repository: candidate.repository }).pull({ title: candidate.title, branch: candidate.branch, main: candidate.main }, body);
    candidate.pr = pull.number;
    candidate.prUrl = pull.html_url;
    candidate.status = "published";
    candidate.publishedAt = now();
    candidate.error = null;
    await this.save();
    await this.removeOrganizerWorktree(candidate);
  }

  async approveWorkspaceCandidate({ sha, reviewed }) {
    await this.assertOrganizerIdle();
    const candidate = this.state.organizer;
    if (!candidate || candidate.status !== "tested" || reviewed !== true || sha !== candidate.sha || !candidate.steps.length || candidate.steps.some((step) => step.exitCode !== 0)) throw new Error("请先审阅并批准全部验证通过的当前候选差异。");
    await assertWorkspaceSourcesUnchanged(candidate.repositoryPath, candidate.inventory, candidate.selected, this.run);
    const diff = await workspaceDiff(candidate.repositoryPath, candidate.inventory.baseSha, candidate.sha, this.run);
    if (diff.files.length !== candidate.selected.length || diff.files.some((file) => !candidate.selected.includes(file))) throw new Error("候选差异与已选文件清单不完全一致；已阻止批准。");
    const head = (await this.git(this.organizerWorktree(candidate), "rev-parse", "HEAD")).trim();
    const changes = await this.git(this.organizerWorktree(candidate), "status", "--porcelain");
    if (head !== sha || changes) throw new Error("候选工作树的提交或内容已变化；已阻止批准。");
    candidate.approval = { sha, files: [...candidate.selected], at: now() };
    candidate.reviewedAt = now();
    await this.save();
    await this.pushApprovedWorkspaceCandidate();
  }

  organizerRemoteBranchSha(candidate) {
    const binding = { path: candidate.repositoryPath, remote: candidate.remote, https: candidate.https };
    return this.git(binding.path, ...this.credentials(binding), "ls-remote", "--heads", binding.remote, `refs/heads/${candidate.branch}`).then((value) => value.trim().split(/\s+/)[0] || null);
  }

  async removeOrganizerWorktree(candidate) {
    const root = this.organizerRoot(candidate);
    await removeWorkspaceWorktree({ repository: candidate.repositoryPath, worktree: this.organizerWorktree(candidate), ownedRoot: root, ownerParent: join(this.root, "workspace-organizer"), run: this.run });
  }

  async removeOrganizerFiles(candidate) {
    const parent = await realpath(join(this.root, "workspace-organizer")).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!parent) return;
    let target;
    try { target = await realpath(this.organizerRoot(candidate)); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!target) return;
    if (!within(parent, target) || target === parent) throw new Error("整理候选目录越界；已保留现场供检查。");
    await rm(target, { recursive: true, force: true });
  }

  async abandonWorkspaceCandidate() {
    const candidate = this.state.organizer;
    if (!candidate || ["published", "abandoned", "publishing"].includes(candidate.status)) throw new Error("此候选状态不能放弃；已创建 PR 的候选请在 PR 中处理。");
    if (candidate.status === "pushed") {
      const remoteSha = await this.organizerRemoteBranchSha(candidate);
      if (remoteSha && remoteSha !== candidate.sha) throw new Error("远程同名分支已经变化；为避免删除他人提交，已保留候选。");
      if (remoteSha) await this.hub({ repository: candidate.repository }).api(`/git/refs/heads/${encodeURIComponent(candidate.branch)}`, { method: "DELETE" });
    }
    if (candidate.branch) await this.removeOrganizerWorktree(candidate);
    if (candidate.ownsBranch) await removeWorkspaceBranch(candidate.repositoryPath, candidate.branch, this.run);
    await this.removeOrganizerFiles(candidate);
    candidate.status = "abandoned";
    candidate.error = null;
    candidate.currentStep = null;
    candidate.abandonedAt = now();
    await this.save();
  }

  async cleanupPublishedWorkspaceCandidate() {
    const candidate = this.state.organizer;
    if (!candidate || candidate.status !== "published") throw new Error("只有已发布候选可以清理本地工作树。");
    await this.removeOrganizerWorktree(candidate);
    const root = await realpath(this.organizerRoot(candidate)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (root) {
      const target = await realpath(join(root, "test-tree")).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (target && within(root, target) && target !== root) await rm(target, { recursive: true, force: true });
    }
    if (candidate.ownsBranch) await removeWorkspaceBranch(candidate.repositoryPath, candidate.branch, this.run);
    await this.removeOrganizerFiles(candidate);
    candidate.cleanedAt = now();
    await this.save();
  }

  async organizerDiff() {
    const candidate = this.state.organizer;
    if (!candidate?.sha || !candidate?.inventory?.baseSha) return { sha: candidate?.sha ?? null, files: [] };
    const diff = await workspaceDiff(candidate.repositoryPath, candidate.inventory.baseSha, candidate.sha, this.run);
    if (candidate.selected?.length && diff.files.some((file) => !candidate.selected.includes(file))) throw new Error("候选差异包含未选择的文件；已阻止审阅和发布。");
    return diff;
  }

  async organizerPatch(file) {
    const candidate = this.state.organizer;
    if (!candidate?.sha || !candidate?.inventory?.baseSha) throw new Error("当前没有可审阅的整理候选。");
    return workspacePatch(candidate.repositoryPath, candidate.inventory.baseSha, candidate.sha, file, this.run);
  }

  async organizerLog(file) {
    const candidate = this.state.organizer;
    if (!candidate) throw new Error("当前没有整理候选。");
    return readWorkspaceLog(this.organizerRoot(candidate), file);
  }

  credentials(binding) {
    return binding.https ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : [];
  }

  async fetch(binding, branch = binding.main) {
    const ref = `refs/remotes/${binding.remote}/${branch}`;
    await this.git(binding.path, ...this.credentials(binding), "fetch", "--no-tags", binding.remote, `+refs/heads/${branch}:${ref}`);
    return this.git(binding.path, "rev-parse", ref);
  }

  async create(input, revertTarget) {
    const binding = this.state.binding;
    if (!binding) throw new Error("请先绑定源码仓库。");
    if (this.state.tasks.some((task) => !terminal.has(task.status) || task.outbox.length)) throw new Error("V1 同一时间只处理一个任务，请先完成当前任务。");
    const attachments = attachmentMetadata(await this.resolveAttachments(input.attachmentIds));
    const title = message(input.title, 180), description = message(input.description) || (attachments.length ? "请参考需求附件。" : ""), criteria = message(input.criteria);
    if (!title || !description) throw new Error("请填写标题和需求描述。");
    const dirty = await this.git(binding.path, "status", "--porcelain");
    if (dirty && !input.base) throw new Error("源码仓库有未提交改动，请明确选择一个基线提交。");
    const base = input.base === "remote" || !input.base ? null : input.base;
    if (base !== null && !commitPattern.test(base)) throw new Error("基线必须是有效的提交号。");
    if (base) await this.git(binding.path, "cat-file", "-e", `${base}^{commit}`);
    const task = { ...binding, id: randomUUID(), title, description, criteria, base, sha: base, status: "draft", createdAt: now(), messages: [], verifications: [], outbox: [], failures: 0, ...(revertTarget ? { revertTarget } : {}) };
    if (attachments.length) task.attachments = attachments;
    this.state.tasks.unshift(task);
    await this.save();
    try { await this.setup(task); } catch (error) { task.error = error.message; throw error; }
  }

  async setup(task) {
    if (!task.base) {
      task.base = await this.fetch(task);
      task.sha = task.base;
      await this.save();
    }
    if (!task.number) {
      await this.git(task.path, "cat-file", "-e", `${task.base}:playwright.config.mjs`).catch(() => { throw new Error("这个基线没有 V1 场景测试底座。请先将应用迭代底座提交到 Git，再选择包含它的基线。可以放弃此草稿后重新选择。"); });
      const marker = `<!-- autoresearch-task:${task.id} -->`;
      const conditions = task.criteria.split(/\r?\n/).filter(Boolean).map((line) => `- [ ] ${line}`).join("\n") || "待整理";
      const issue = await this.hub(task).issue(task.title, `## 需求\n${task.description}\n\n## 验收条件\n${conditions}\n\n## 基线\n${task.base}\n\n由 AutoResearch 应用迭代创建\n${marker}`, marker);
      task.number = issue.number;
      task.issueUrl = issue.html_url;
      const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 45) || "app-change";
      task.branch = `iterate/${task.number}-${slug}`;
      await this.save();
    }
    if (!task.worktreeReady) {
      const target = this.workspace(task);
      await mkdir(this.directory(task), { recursive: true });
      const checkedOut = await this.git(target, "branch", "--show-current").catch(() => null);
      if (checkedOut !== task.branch) await this.git(task.path, "worktree", "add", "-b", task.branch, target, task.base);
      task.worktreeReady = true;
      await this.save();
    }
  }

  async revert(task) {
    this.require(task, "merged", "anomaly");
    const binding = this.state.binding;
    if (!binding || binding.path !== task.path || binding.repository !== task.repository || !commitPattern.test(task.mergedSha ?? "")) throw new Error("当前绑定仓库没有可回退的合并。 ");
    const base = await this.fetch(binding);
    await this.git(binding.path, "merge-base", "--is-ancestor", task.mergedSha, base);
    await this.create({ base, title: `回退 #${task.number}：${task.title}`.slice(0, 180), description: `回退合并提交 ${task.mergedSha}（${task.prUrl}）。不改变远程主线，直到这次回退通过验证并获批准。`, criteria: "验证被回退的行为已恢复，保留之后的无关改动。" }, task.mergedSha);
  }

  async applyRevert(task) {
    if (!task.revertTarget || task.revertApplied) return;
    const cwd = this.workspace(task);
    const parents = (await this.git(cwd, "rev-list", "--parents", "-n", "1", task.revertTarget)).split(" ");
    try { await this.git(cwd, "revert", "--no-edit", ...(parents.length > 2 ? ["-m", "1"] : []), task.revertTarget); }
    catch (error) {
      await this.git(cwd, "revert", "--abort").catch(() => {});
      throw new Error(`无法自动回退，请先处理冲突或检查是否已回退：${error.message}`);
    }
    task.revertApplied = await this.head(task);
    await this.save();
  }

  queue(task, type, payload) { task.outbox.push({ id: randomUUID(), type, ...payload }); }
  audit(task, text) { if (task.pr) this.queue(task, "comment", { number: task.pr, text }); }
  labels(task) {
    for (const number of [task.number, task.pr].filter(Boolean)) this.queue(task, "label", { number, value: labelFor[task.status] ?? null });
  }

  async flush(task) {
    await this.save();
    const hub = this.hub(task);
    while (task.outbox.length) {
      const event = task.outbox[0];
      if (event.type === "comment") await hub.comment(event.number, event.text, `<!-- autoresearch-event:${event.id} -->`);
      if (event.type === "label") await hub.label(event.number, event.value);
      if (event.type === "status") await hub.status(event.sha, event.state, event.description);
      if (event.type === "body") await hub.api(`/pulls/${task.pr}`, { method: "PATCH", body: { body: event.body } });
      if (event.type === "close") await hub.api(event.path, { method: "PATCH", body: { state: "closed", ...(event.reason ? { state_reason: event.reason } : {}) } });
      task.outbox.shift();
      await this.save();
    }
  }

  async push(task, sha) {
    await this.git(this.workspace(task), ...this.credentials(task), "push", task.remote, `${sha}:refs/heads/${task.branch}`);
  }

  prBody(task) {
    const latest = task.verifications.at(-1);
    const trial = task.trial?.sha === task.sha ? this.trialSummary(task.trial) : "等待人工试用当前候选提交";
    return `Closes #${task.number}\n\n## 改了什么\n${task.summary || task.description}\n\n## 验收测试\n${this.acceptance(task)} · ${task.freeze ? `${task.freeze.hash}（确认于 ${task.freeze.at}）` : "待确认"}\n\n## 最近一次验证\n${latest ? this.verificationSummary(task, latest) : "等待验证"}\n\n## 人工试用\n${trial}`;
  }

  trialItems(task) {
    const items = (task.criteria ?? "").split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*]\s*(?:\[[ xX]\]\s*)?|\d+[.)、]\s*)/, "").trim()).filter(Boolean);
    return items.length ? items : [`需求已实现：${task.title}`];
  }

  trialSummary(trial) {
    const lines = trial.items.map(({ criterion, result, note }) => `- ${result === "pass" ? "✓" : "✗"} ${criterion}${note ? `\n  ${note}` : ""}`).join("\n");
    const summary = `${trial.passed ? "通过" : "未通过"} · ${trial.sha} · ${trial.at}\n预览：${trial.preview.realData ? "正式数据临时快照" : "示例数据"}，打开于 ${trial.preview.startedAt}\n${lines}${trial.note ? `\n\n备注：${trial.note}` : ""}`;
    return summary.length <= 24_000 ? summary : `${summary.slice(0, 24_000)}\n\n试用说明过长，完整记录可在本地任务中查看。`;
  }

  setCandidateSha(task, sha) {
    task.sha = sha;
    if (!task.trial || task.trial.sha === sha) return;
    this.audit(task, `人工试用已失效 · ${task.trial.sha} → ${sha}，请在预览中重新试用。`);
    task.trial = null;
    if (task.pr) this.queue(task, "body", { body: this.prBody(task) });
  }

  async recordTrial(task, { sha, results, note }) {
    await this.sync(task);
    this.require(task, "review");
    if (sha !== task.sha) throw new Error("候选提交已变化，请刷新后在预览中重新试用。");
    if (task.verifications.findLast((item) => item.sha === sha)?.result !== "success") throw new Error("请先让当前提交通过自动验证，再进行人工试用。");
    const session = (task.previews ?? []).findLast((item) => item.sha === sha);
    if (!session) throw new Error("请先打开预览，实际试用当前候选提交后再提交结果。只计入自动验证通过后打开的预览。");
    const criteria = this.trialItems(task);
    if (!Array.isArray(results) || results.length !== criteria.length) throw new Error("请为每一条验收条件填写试用结果。");
    const items = criteria.map((criterion, index) => {
      const entry = results[index] ?? {};
      const result = entry.result;
      const detail = message(entry.note, 1000);
      if (!["pass", "fail"].includes(result)) throw new Error(`请填写第 ${index + 1} 条的试用结果。`);
      if (result === "fail" && !detail) throw new Error(`第 ${index + 1} 条未通过，请写明实际看到的问题。`);
      return { criterion, result, note: detail };
    });
    const passed = items.every((item) => item.result === "pass");
    const trial = { sha, at: now(), passed, items, note: message(note, 2000), preview: { startedAt: session.startedAt, realData: session.realData } };
    task.trial = trial;
    task.trials = [...(task.trials ?? []).slice(-19), trial];
    this.audit(task, `人工试用${passed ? "通过" : "未通过"}\n\n${this.trialSummary(trial)}`);
    if (!passed) {
      const problems = items.filter((item) => item.result === "fail").map((item) => `- 条件：${item.criterion}\n  实际：${item.note}`).join("\n");
      const feedback = `人工试用未通过（提交 ${sha.slice(0, 10)}）。请修复以下问题，修复后仍需重新试用：\n${problems}${trial.note ? `\n备注：${trial.note}` : ""}`;
      this.addMessage(task, "user", feedback);
      task.pendingFeedback = [...(task.pendingFeedback ?? []), feedback];
    }
    this.queue(task, "body", { body: this.prBody(task) });
    await this.flush(task);
  }

  async publish(task) {
    await this.push(task, task.sha);
    if (!task.pr) {
      const pr = await this.hub(task).pull(task, this.prBody(task));
      task.pr = pr.number;
      task.prUrl = pr.html_url;
      await this.save();
    }
    this.queue(task, "body", { body: this.prBody(task) });
    this.labels(task);
    await this.flush(task);
  }

  require(task, ...states) {
    if (!states.includes(task.status)) throw new Error("当前任务状态不支持此操作，请刷新后重试。");
  }

  addMessage(task, role, text, attachments = []) { task.messages.push({ role, text, at: now(), ...(attachments.length ? { attachments } : {}) }); }

  async activity(task, kind, text) {
    if (!text) return;
    task.events = [...(task.events ?? []).slice(-119), { kind, text: message(text, 800), at: now() }];
    await this.save();
  }

  requestAgentApproval(task, card, signal) {
    if (signal.aborted) return false;
    return new Promise((resolve) => {
      const key = card.id;
      const abort = () => finish(false);
      const timer = setTimeout(abort, 5 * 60_000);
      const finish = (approve) => {
        if (!this.approvals.delete(key)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(approve);
      };
      this.approvals.set(key, { card: { ...card, taskId: task.id }, finish });
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async decideAgentApproval({ id, approvalId, approve }) {
    const entry = this.approvals.get(approvalId);
    if (!entry || entry.card.taskId !== id || typeof approve !== "boolean") throw new Error("此审批已结束或不属于当前任务。");
    entry.finish(approve);
    const operation = { command: "命令", patch: "文件补丁", permissions: "本回合附加权限" }[entry.card.kind];
    await this.activity(this.task(id), "agent", `${approve ? "用户批准" : "用户拒绝"} · ${operation}`);
  }

  async addFeedback(id, text, attachmentIds) {
    const task = this.task(id);
    const acceptsFeedback = () => !this.state.updatePending && ["draft", "spec", "implementing", "verifying", "review"].includes(task.status)
      && (!this.active || ["draft", "implement"].includes(this.active.name));
    if (!acceptsFeedback()) throw new Error("当前任务状态无法添加意见。");
    const attachments = attachmentMetadata(await this.resolveAttachments(attachmentIds));
    if (!acceptsFeedback()) throw new Error("任务状态已变化，请刷新后再添加意见。");
    const feedback = message(text) || (attachments.length ? "请参考我补充的附件。" : "");
    if (!feedback) throw new Error("请填写补充要求。");
    this.addMessage(task, "user", feedback, attachments);
    task.pendingFeedback = [...(task.pendingFeedback ?? []), feedback];
    await this.save();
  }

  consumeFeedback(task, text) {
    const feedback = [text, ...(task.pendingFeedback ?? [])].filter(Boolean).join("\n\n");
    task.pendingFeedback = [];
    return feedback;
  }

  prompt(task, phase, { history = "", feedback = "", access = "full" } = {}) {
    const dir = this.acceptance(task);
    const check = `node scripts/iteration-check.mjs ${dir}`;
    const head = `你在 AutoResearch 应用迭代任务 #${task.number} 的 worktree 中。先读仓库根目录的 AGENTS.md（项目结构、测试约定、以往经验），需要时使用 .agents/skills 里的技能。不要执行 git commit、push 或 GitHub 操作，这些由平台完成。\n标题：${task.title}\n需求：${task.description}\n验收条件：${task.criteria || "请根据需求明确"}\n`;
    const spec = `本阶段只将验收条件写成测试，只能改 ${dir}/ 下的文件（不要改 AGENTS.md 或其他代码）。按技能 write-acceptance-test 写：单元测试以 .test.mjs 结尾，Playwright 场景以 .spec.mjs 或 .spec.ts 结尾，复用 tests/e2e 的示例数据和启动辅助工具。` +
      (access === "full" ? `写完后运行 \`${check} --expect-fail\`，确认测试在功能实现前会失败，且失败原因是断言不成立，而不是语法、导入或选择器写错。如果测试已经通过，说明它没测到新需求，要改测试。` : "");
    const implement = `实现改动并修复验证问题。不要修改这些已冻结的路径：${this.frozenPaths(task).join("、")}。` +
      (access === "full" ? `结束前运行 \`${check}\`，直到通过；改了界面就按技能 check-ui-change 查看截图。平台之后还会做完整验证（单元测试、构建、全部场景测试含历次验收），验证失败时按技能 fix-validation-failure 处理。如果这轮踩到了以后值得记住的坑，在 AGENTS.md「经验记录」末尾按格式追加一条。` : "");
    return head + (phase === "spec" ? spec : implement) + `\n近期讨论：\n${history}\n本轮补充：\n${feedback || "无"}\n完成后简要说明文件改动、你运行过的检查和结果。`;
  }

  async agentTurn(task, phase, feedback) {
    const signal = this.active.controller.signal;
    const runtime = this.state.runtime ?? "app-server";
    const history = task.messages.slice(-8).map((item) => `${item.role}：${item.text}`).join("\n");
    const access = this.state.access ?? "full";
    const groups = [task.attachments, ...task.messages.slice(-8).map((entry) => entry.attachments)].filter((group) => group?.length);
    const files = new Map();
    for (const group of groups) {
      for (const file of await this.resolveAttachments(group.map(({ id }) => id))) files.set(file.id, file);
    }
    const attachments = [...files.values()];
    const prompt = this.prompt(task, phase, { history, feedback, access }) + localAttachmentPrompt(attachments);
    await this.activity(task, "agent", `开始 ${runtime === "app-server" ? "App Server" : "旧 SDK"} 回合`);
    const result = await withIterationEnvironment((env) => this.agent(prompt, { runtime, access, env, workingDirectory: this.workspace(task), signal, threadId: runtime === "app-server" ? task.appServerThreadId : task.threadId,
      imagePaths: attachments.filter((file) => file.mediaType).map((file) => file.path),
      onThread: async (threadId) => { task[runtime === "app-server" ? "appServerThreadId" : "threadId"] = threadId; await this.save(); },
      onApproval: (card, signal) => this.requestAgentApproval(task, card, signal),
      dismissApproval: (id) => this.approvals.get(id)?.finish(false),
      onDelta: (text) => { this.stream = text ? { taskId: task.id, text } : null; },
      onEvent: async ({ type, item }) => {
        if (item?.type === "command_execution" && ["item.started", "item.completed"].includes(type)) await this.activity(task, "agent", `${type === "item.started" ? "开始" : `结束（${item.exit_code ?? "—"}）`} · ${item.command}`);
        if (item?.type === "file_change" && type === "item.completed") await this.activity(task, "agent", item.changes.map(({ kind, path }) => `${kind} ${path}`).join("\n"));
      },
    }));
    if (signal.aborted) throw new Error("操作已停止。");
    const summary = message(result?.finalResponse ?? result, 4000) || "已完成本轮改动。";
    this.addMessage(task, "agent", summary);
    task.summary = summary;
  }

  async commit(task, phase) {
    const cwd = this.workspace(task);
    await this.git(cwd, "add", "-A");
    const changes = (await this.git(cwd, "diff", "--cached", "--name-only", "--no-renames", "-z")).split("\0").filter(Boolean);
    if (phase === "spec" && changes.some((file) => !file.startsWith(`${this.acceptance(task)}/`))) {
      await this.git(cwd, "restore", "--staged", "--", ".");
      throw new Error("验收阶段只能提交验收测试目录。请让 Agent 整理越界改动后重试。");
    }
    if (changes.length) {
      const summary = task.summary.split(/\r?\n/).find((line) => line.trim())?.slice(0, 80) || task.title;
      await this.git(cwd, "commit", "-m", `iter #${task.number}: ${summary}`);
    }
    this.setCandidateSha(task, await this.head(task));
    await this.save();
  }

  async draft(task, text, attachmentIds) {
    this.require(task, "draft", "spec");
    await this.sync(task);
    this.require(task, "draft", "spec");
    const attachments = attachmentMetadata(await this.resolveAttachments(attachmentIds));
    const userText = message(text) || (attachments.length ? "请参考我补充的附件。" : "");
    if (userText) this.addMessage(task, "user", userText, attachments);
    const feedback = this.consumeFeedback(task, userText);
    const before = await this.head(task);
    await this.save();
    await this.agentTurn(task, "spec", feedback);
    const directChanges = await this.git(this.workspace(task), "diff", "--name-only", "--no-renames", "-z", before, "HEAD");
    if (directChanges.split("\0").filter(Boolean).some((file) => !file.startsWith(`${this.acceptance(task)}/`))) throw new Error("验收阶段检测到测试目录外的提交。请整理这些改动后继续。");
    if (!(await acceptanceFiles(join(this.workspace(task), this.acceptance(task)))).length) throw new Error("Agent 尚未生成验收测试。");
    await this.commit(task, "spec");
    if (task.sha === task.base) throw new Error("验收测试需要提交到任务分支。");
    task.freeze = null;
    task.status = "spec";
    if (feedback) this.audit(task, `验收测试修改意见\n\n${feedback}`);
    await this.publish(task);
  }

  async synchronizeHead(task) {
    if (!(await this.checkRemote(task))) return false;
    const sha = await this.head(task);
    if (sha !== task.approval?.sha && task.approval) {
      this.audit(task, `批准已失效 · ${task.approval.sha} → ${sha}`);
      task.approval = null;
      task.status = "review";
      this.labels(task);
    }
    this.setCandidateSha(task, sha);
    if (task.freeze && (await this.tree(task, sha)) !== task.freeze.hash) {
      const changed = await this.git(this.workspace(task), "diff", "--name-status", task.freeze.sha, sha, "--", ...this.frozenPaths(task));
      this.audit(task, `验收冻结已失效 · ${task.freeze.sha} → ${sha}\n\n${changed}`);
      task.freeze = null;
      task.approval = null;
      task.status = "spec";
      this.queue(task, "body", { body: this.prBody(task) });
      this.labels(task);
    }
    if (task.freeze) {
      const cwd = this.workspace(task);
      const changed = await this.git(cwd, "status", "--porcelain", "--", ...this.frozenPaths(task));
      if (changed) {
        this.audit(task, `验收冻结已失效 · worktree 中的验收文件已变化\n\n${changed}`);
        if (task.approval) this.audit(task, "批准已失效 · 冻结验收文件已变化。");
        task.freeze = null;
        task.approval = null;
        task.status = "spec";
        this.queue(task, "body", { body: this.prBody(task) });
        this.labels(task);
      }
    }
    return true;
  }

  async checkRemote(task, pull) {
    if (!task.pr) return true;
    const pr = pull ?? await this.hub(task).api(`/pulls/${task.pr}`);
    if (pr.merged) {
      if (task.mergeReceipt && task.mergeReceipt.head === pr.head?.sha && task.mergeReceipt.sha === pr.merge_commit_sha) await this.finishMerged(task, pr.merge_commit_sha);
      else {
        task.status = "anomaly";
        task.mergedSha = pr.merge_commit_sha;
        task.approval = null;
        task.error = "远程 PR 已合并，但没有与该提交匹配的平台批准和合并回执。请人工检查。";
        this.audit(task, task.error);
        this.labels(task);
      }
      return false;
    }
    if (pr.state !== "open") {
      task.status = "abandoned";
      task.approval = null;
      this.labels(task);
      return false;
    }
    const local = await this.head(task);
    if (pr.head.sha === local) return true;
    const remote = await this.fetch(task, task.branch);
    const cwd = this.workspace(task);
    try { await this.git(cwd, "merge-base", "--is-ancestor", remote, local); return true; }
    catch {
      if (task.approval) {
        this.audit(task, `批准已失效 · 远程分支更新至 ${remote}`);
        task.approval = null;
        task.status = "review";
        this.labels(task);
      }
      if (await this.git(cwd, "status", "--porcelain")) throw new Error("远程分支已更新，且任务 worktree 有未提交改动。请保留并处理本地改动后同步。");
      await this.git(cwd, "merge", "--ff-only", remote).catch(() => { throw new Error("本地和远程任务分支已分叉，请处理分叉后同步。"); });
      return true;
    }
  }

  async sync(task) {
    if (!terminal.has(task.status)) {
      await this.setup(task);
      try { await this.synchronizeHead(task); } finally { await this.flush(task); }
      if (!terminal.has(task.status) && task.sha !== task.base && !task.pr) await this.publish(task);
    }
    if (task.status === "abandoned" && task.pr) await this.checkClosedMerge(task);
    await this.flush(task);
    if (["merged", "abandoned"].includes(task.status)) await this.cleanup(task);
  }

  async refresh(task) {
    const prior = task.sha;
    await this.sync(task);
    if (task.sha !== prior && ["review", "implementing"].includes(task.status) && task.freeze && !this.preview && !await this.git(this.workspace(task), "status", "--porcelain")) {
      await this.push(task, task.sha);
      await this.validate(task);
    }
  }

  async confirm(task, sha) {
    await this.sync(task);
    this.require(task, "spec");
    if (!task.pr || sha !== task.sha || await this.git(this.workspace(task), "status", "--porcelain")) throw new Error("候选测试已变化，请刷新并重新审阅。");
    const hash = await this.tree(task, sha);
    if (!hash || !(await acceptanceFiles(join(this.workspace(task), this.acceptance(task)))).length) throw new Error("此提交没有可确认的验收测试。");
    await this.push(task, sha);
    task.freeze = { sha, hash, at: now() };
    task.status = "implementing";
    task.failures = 0;
    this.audit(task, `确认验收 · ${sha} · 冻结哈希 ${hash}`);
    this.queue(task, "body", { body: this.prBody(task) });
    this.labels(task);
    await this.flush(task);
  }

  async implement(task, text, attachmentIds) {
    await this.sync(task);
    this.require(task, "implementing", "review");
    if (!task.freeze) throw new Error("请先确认验收测试。");
    if (task.revertTarget && !task.revertApplied) {
      if (await this.git(this.workspace(task), "status", "--porcelain")) throw new Error("回退要求干净的候选工作目录。");
      await this.applyRevert(task);
      this.setCandidateSha(task, await this.head(task));
      await this.publish(task);
      if (await this.synchronizeHead(task) && task.status !== "spec") await this.validate(task);
      else await this.flush(task);
      return;
    }
    const attachments = attachmentMetadata(await this.resolveAttachments(attachmentIds));
    const userText = message(text) || (attachments.length ? "请参考我补充的附件。" : "");
    if (userText) this.addMessage(task, "user", userText, attachments);
    const feedback = this.consumeFeedback(task, userText);
    if (task.status === "review" && !feedback) throw new Error("请输入返工意见。");
    if (feedback) this.audit(task, `修改意见\n\n${feedback}`);
    task.status = "implementing";
    task.failures = 0;
    this.labels(task);
    await this.flush(task);
    let instruction = feedback;
    while (task.failures < this.state.retryLimit) {
      await this.agentTurn(task, "implement", instruction);
      await this.commit(task, "implement");
      await this.publish(task);
      if (!(await this.synchronizeHead(task)) || task.status === "spec") { await this.flush(task); return; }
      const result = await this.validate(task);
      if (result.result === "interrupted" || task.failures >= this.state.retryLimit) return;
      if (result.result === "success" && !task.pendingFeedback?.length) return;
      const log = result.steps.at(-1)?.logFile;
      const snippet = log && result.result === "failure" ? (await readFile(join(this.directory(task), "verify", result.folder, log), "utf8")).slice(-14_000) : result.error;
      const feedback = this.consumeFeedback(task);
      if (feedback) this.audit(task, `修改意见\n\n${feedback}`);
      task.status = "implementing";
      this.labels(task);
      await this.flush(task);
      const failed = result.steps.at(-1);
      const failure = result.result === "failure" ? `平台验证失败 #${result.id}，提交 ${result.sha}，失败步骤：${failed?.name ?? "未知"}（${failed?.command ?? ""}）。请修复。\n完整日志和截图目录：${join(this.directory(task), "verify", result.folder)}\n日志末尾：\n${snippet ?? ""}` : "";
      instruction = [feedback, failure].filter(Boolean).join("\n\n");
    }
  }

  verificationSummary(task, record) {
    const resultName = { success: "通过", failure: "失败", pending: "进行中", interrupted: "中断" }[record.result];
    return `验证 #${record.id} · ${record.sha} · ${resultName}\n${record.steps.map((step) => `${step.name} ${step.exitCode === 0 ? "✓" : `失败 (${step.exitCode})`} · ${(step.durationMs / 1000).toFixed(1)}s`).join("\n")}\n${record.error || ""}\n完整日志与截图：userData/iterations/${task.number}/verify/${record.folder}/`;
  }

  async validate(task) {
    if (task.sha !== await this.head(task)) throw new Error("候选提交已变化，请先同步。");
    if (!task.freeze || await this.tree(task, task.sha) !== task.freeze.hash) throw new Error("验收冻结已失效，请重新确认。");
    if (await this.git(this.workspace(task), "status", "--porcelain")) throw new Error("验证要求候选 worktree 没有未提交改动。");
    const id = task.verifications.length + 1;
    const record = { id, sha: task.sha, folder: String(id).padStart(3, "0"), result: "pending", steps: [], screenshots: [], startedAt: now() };
    const output = join(this.directory(task), "verify", record.folder);
    await mkdir(output, { recursive: true });
    task.status = "verifying";
    task.verifications.push(record);
    this.queue(task, "status", { sha: record.sha, state: "pending", description: `AutoResearch 验证 #${id}` });
    const signal = this.active.controller.signal;
    try {
      await this.flush(task);
    } catch (error) {
      record.result = "interrupted";
      record.finishedAt = now();
      task.status = "review";
      this.queue(task, "status", { sha: record.sha, state: "error", description: "验证未启动，可重试" });
      this.audit(task, this.verificationSummary(task, record));
      this.labels(task);
      throw error;
    }
    try {
      record.result = await this.verify({ workspace: this.workspace(task), source: task.path, acceptance: this.acceptance(task), output, signal, onProgress: (step) => this.activity(task, "verify", step), onStep: async (step) => { record.steps.push(step); await this.save(); } });
      if (record.sha !== await this.head(task) || await this.git(this.workspace(task), "status", "--porcelain")) throw new Error("验证期间候选代码发生变化，结果无效。");
    } catch (error) {
      record.result = signal.aborted ? "interrupted" : "failure";
      record.error = error.message;
    }
    record.finishedAt = now();
    record.screenshots = (await readdir(join(output, "screenshots"), { recursive: true }).catch(() => [])).filter((name) => /\.png$/i.test(name));
    task.failures = record.result === "failure" ? task.failures + 1 : 0;
    task.status = "review";
    this.queue(task, "status", { sha: record.sha, state: record.result === "interrupted" ? "error" : record.result, description: `AutoResearch 验证 #${id}` });
    this.audit(task, this.verificationSummary(task, record));
    this.queue(task, "body", { body: this.prBody(task) });
    this.labels(task);
    await this.flush(task);
    return record;
  }

  async validateOnly(task) {
    await this.sync(task);
    this.require(task, "implementing", "review");
    await this.push(task, task.sha);
    await this.validate(task);
  }

  async approve(task, sha) {
    await this.sync(task);
    this.require(task, "review");
    const record = task.verifications.findLast((item) => item.sha === task.sha);
    const remote = await this.hub(task).api(`/pulls/${task.pr}`);
    if (remote.merged) { await this.checkRemote(task, remote); await this.flush(task); return; }
    if (!task.freeze || remote.state !== "open" || sha !== task.sha || remote.head.sha !== sha || record?.result !== "success" || !(await this.hub(task).verified(sha)) || await this.git(this.workspace(task), "status", "--porcelain")) throw new Error("当前 PR 提交必须通过验证，且与已确认的验收测试一致。");
    if (task.trial?.sha !== sha || !task.trial.passed) throw new Error("请先在预览中试用当前提交，并提交全部通过的人工试用结果。");
    task.approval = { sha, record: record.id, trial: task.trial.at, at: now() };
    task.status = "approved";
    this.audit(task, `批准合并 ${sha}，验证记录 #${record.id}，人工试用 ${task.trial.at}`);
    this.labels(task);
    await this.flush(task);
  }

  async merge(task) {
    await this.sync(task);
    this.require(task, "approved");
    if (this.preview?.id === task.id) throw new Error("请先停止预览版。");
    const cwd = this.workspace(task);
    if (await this.git(cwd, "status", "--porcelain")) throw new Error("候选 worktree 存在未提交改动。");
    task.status = "merging";
    await this.save();
    try {
      const approval = task.approval;
      const record = task.verifications.findLast((entry) => entry.sha === approval.sha);
      if (record?.id !== approval.record || record.result !== "success") throw new Error("找不到获批准的成功验证记录。");
      if (task.trial?.sha !== approval.sha || !task.trial.passed || task.trial.at !== approval.trial) throw new Error("找不到与批准提交匹配的人工试用记录。请重新试用后批准。");
      const mainHead = await this.fetch(task);
      try { await this.git(cwd, "merge", "--no-edit", mainHead); }
      catch (error) {
        const files = await this.git(cwd, "diff", "--name-only", "--diff-filter=U");
        if (files) await this.git(cwd, "merge", "--abort");
        throw new Error(files ? `更新主线时发生冲突：\n${files}` : error.message);
      }
      const sha = await this.head(task);
      if (sha !== approval.sha) {
        this.setCandidateSha(task, sha);
        this.audit(task, `批准已失效 · 更新主线后提交变为 ${sha}，验证通过后请重新试用并批准。`);
        task.approval = null;
        task.status = "review";
        await this.publish(task);
        if (!(await this.synchronizeHead(task)) || task.status === "spec") { await this.flush(task); return; }
        await this.validate(task);
        return;
      }
      if (mainHead !== await this.fetch(task)) throw new Error("主线已更新，请重新审阅后再合并。");
      const hub = this.hub(task);
      const pr = await hub.api(`/pulls/${task.pr}`);
      if (pr.merged) { await this.checkRemote(task, pr); await this.flush(task); return; }
      if (pr.state !== "open" || pr.head.sha !== approval.sha || await this.head(task) !== approval.sha || await this.tree(task, approval.sha) !== task.freeze.hash || await this.git(cwd, "status", "--porcelain") || !(await hub.verified(approval.sha))) throw new Error("合并前提交、验收冻结或验证状态已变化。");
      if (this.active.controller.signal.aborted) throw new Error("操作已停止。");
      const merged = await hub.merge(task.pr, approval.sha);
      if (!merged?.merged || !commitPattern.test(merged.sha)) throw new Error("GitHub 尚未确认合并，请同步任务检查状态。");
      task.mergeReceipt = { head: approval.sha, sha: merged.sha, approval };
      await this.save();
      await this.finishMerged(task, merged.sha);
    } catch (error) {
      if (!terminal.has(task.status) && task.status !== "spec" && !task.mergeReceipt) {
        if (task.approval) this.audit(task, `批准已失效 · 合并中止 · ${error.message}`);
        task.status = "review";
        task.approval = null;
        this.labels(task);
        await this.save();
        await this.flush(task).catch(() => {});
      }
      throw error;
    }
  }

  async finishMerged(task, sha) {
    task.status = "merged";
    task.mergedSha = sha;
    this.audit(task, `已合并 · ${sha}`);
    this.queue(task, "close", { path: `/issues/${task.number}`, reason: "completed" });
    this.labels(task);
    await this.flush(task);
    await this.cleanup(task);
  }

  async cleanup(task) {
    if (this.preview?.id === task.id) await this.stopPreview();
    if (task.number) {
      const folders = await readdir(this.directory(task)).catch((error) => { if (error.code !== "ENOENT") throw error; return []; });
      for (const folder of folders.filter((name) => /^(?:preview|preview-[a-f0-9-]{36})$/.test(name))) await this.removePreview(task, folder);
    }
    if (!task.branch) return;
    if (!/^iterate\/\d+-[a-z0-9-]+$/.test(task.branch)) throw new Error("任务分支名称无效，已保留供检查。");
    const cwd = this.workspace(task);
    if (await realpath(cwd).catch(() => null)) {
      const root = await this.checkedDirectory(task);
      const target = await realpath(cwd);
      if (target !== join(root, "worktree")) throw new Error("任务工作目录越界，已保留供检查。");
      await this.git(task.path, "worktree", "remove", cwd);
    }
    task.worktreeReady = false;
    const ref = `refs/heads/${task.branch}`;
    const expected = task.mergeReceipt?.head ?? task.sha;
    if (task.pr && !task.remoteBranchCleaned) {
      const refs = await this.git(task.path, ...this.credentials(task), "ls-remote", "--heads", task.remote, ref);
      if (refs) {
        if (refs.split(/\s/)[0] !== expected) throw new Error("远程任务分支已变化，已保留供检查。");
        await this.git(task.path, ...this.credentials(task), "push", `--force-with-lease=${ref}:${expected}`, task.remote, `:${ref}`);
      }
      task.remoteBranchCleaned = true;
      await this.save();
    }
    const local = await this.git(task.path, "rev-parse", "--verify", ref).catch(() => null);
    if (local && local !== expected) throw new Error("本地任务分支已变化，已保留供检查。");
    if (local) await this.git(task.path, "branch", "-D", "--", task.branch);
    await this.save();
  }

  async abandon(task, text) {
    if (terminal.has(task.status)) throw new Error("任务已结束。");
    const reason = message(text);
    if (!reason) throw new Error("请填写放弃理由。");
    if (this.preview?.id === task.id) await this.stopPreview();
    await this.checkClosedMerge(task);
    if (task.status === "anomaly" || task.status === "merged") { await this.flush(task); return; }
    task.status = "abandoned";
    task.approval = null;
    if (task.number) this.queue(task, "comment", { number: task.number, text: `已放弃\n\n${reason}` });
    this.audit(task, `已放弃\n\n${reason}`);
    this.labels(task);
    if (task.pr) this.queue(task, "close", { path: `/pulls/${task.pr}` });
    if (task.number) this.queue(task, "close", { path: `/issues/${task.number}`, reason: "not_planned" });
    await this.flush(task);
    await this.checkClosedMerge(task);
    await this.flush(task);
    if (task.status === "abandoned") await this.cleanup(task);
  }

  async checkClosedMerge(task) {
    if (!task.pr) return;
    const pr = await this.hub(task).api(`/pulls/${task.pr}`);
    if (pr.merged) await this.checkRemote(task, pr);
  }

  async update(task) {
    this.require(task, "merged");
    const binding = this.state.binding;
    if (!binding || binding.path !== task.path || binding.repository !== task.repository || await this.localUpdateMode(binding) !== "source") throw new Error("仅可更新当前运行的源码仓库；安装版需要另行构建安装包。");
    const remote = await this.fetch(binding);
    if (!commitPattern.test(task.mergedSha ?? "")) throw new Error("没有可更新的合并提交。");
    await this.git(binding.path, "merge-base", "--is-ancestor", task.mergedSha, remote);
    const restart = await this.restart("check");
    this.state.updateError = null;
    if (process.platform === "win32" && restart && await this.git(binding.path, "diff", "--name-only", "HEAD", task.mergedSha, "--", "package-lock.json")) {
      await this.scheduleUpdate({ binding, target: task.mergedSha, restart });
      return;
    }
    this.state.localUpdate = await applyLocalUpdate({ binding, target: task.mergedSha, git: this.git.bind(this), run: this.run });
    await this.save();
    await this.restart("relaunch");
  }

  async restore() {
    const binding = this.state.binding;
    if (!binding || await this.localUpdateMode(binding) !== "source" || this.state.localUpdate?.path !== binding.path) throw new Error("当前源码仓库没有可恢复的本地构建。");
    const restart = await this.restart("check");
    this.state.updateError = null;
    if (process.platform === "win32" && restart && this.state.localUpdate.install) {
      await this.scheduleUpdate({ binding, update: this.state.localUpdate, restart });
      return;
    }
    await restoreLocalUpdate({ update: this.state.localUpdate, binding, git: this.git.bind(this) });
    this.state.localUpdate = null;
    await this.save();
    await this.restart("relaunch");
  }

  async scheduleUpdate(input) {
    const folder = await prepareUpdateHelper({ ...input, git: this.git.bind(this) });
    this.state.updatePending = folder;
    await this.save();
    try { await startUpdateHelper(folder); }
    catch (error) { this.state.updatePending = null; throw error; }
    await this.restart("close");
  }

  async collectUpdate() {
    const folder = this.state.updatePending;
    if (!folder) return;
    const result = await readFile(join(folder, "result.json"), "utf8").then(JSON.parse).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (!result || this.state.updatePending !== folder) return;
    if (result.ok) this.state.localUpdate = result.localUpdate;
    else this.state.updateError = result.error;
    this.state.updatePending = null;
    await this.save();
  }

  async diff(id) {
    await this.ready;
    const task = this.task(id);
    if ((!task.worktreeReady && !task.mergedSha) || !task.sha || !task.base || task.sha === task.base) return { sha: task.sha, files: [] };
    const cwd = task.worktreeReady ? this.workspace(task) : task.path;
    const names = (await this.git(cwd, "diff", "--no-renames", "--name-only", "-z", task.base, task.sha)).split("\0").filter(Boolean);
    const weight = (file) => /^(tests\/|package(?:-lock)?\.json$|playwright\.config\.mjs$|electron\/(?:iteration|launch-profile)|scripts\/iteration|src\/screens\/app-iteration)/.test(file) ? 0 : 1;
    return { sha: task.sha, files: names.sort((left, right) => weight(left) - weight(right) || left.localeCompare(right)) };
  }

  async patch(id, file) {
    const { files } = await this.diff(id);
    if (!files.includes(file)) throw new Error("此文件不在候选差异中。");
    const task = this.task(id);
    const patch = await this.git(task.worktreeReady ? this.workspace(task) : task.path, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", task.base, task.sha, "--", file);
    return { text: patch.slice(0, 400_000), truncated: patch.length > 400_000 };
  }

  async artifact(id, verifyId, kind, file) {
    await this.ready;
    const task = this.task(id);
    const record = task.verifications.find((item) => item.id === verifyId);
    const valid = kind === "screenshot" ? record?.screenshots.includes(file) : record?.steps.some((step) => step.logFile === file);
    if (!valid) throw new Error("找不到验证产物。");
    const directory = await realpath(join(this.directory(task), "verify", record.folder));
    const path = await realpath(join(directory, kind === "screenshot" ? "screenshots" : "", file));
    if (!within(directory, path)) throw new Error("验证产物目录越界。");
    const bytes = await readFile(path);
    return kind === "screenshot" ? `data:image/png;base64,${bytes.toString("base64")}` : bytes.toString("utf8").slice(-90_000);
  }

  async startPreview(task, { realData, confirmed, sha }) {
    await this.sync(task);
    this.require(task, "review", "approved");
    if (this.preview) throw new Error("请先停止正在运行的预览版。");
    const record = task.verifications.findLast((item) => item.sha === task.sha);
    if (sha !== task.sha || !record?.steps.some((step) => step.name === "构建" && step.exitCode === 0) || await this.git(this.workspace(task), "status", "--porcelain")) throw new Error("请先构建并验证当前候选提交。");
    if (realData && !confirmed) throw new Error("请确认使用正式数据的临时副本。");
    const folder = `preview-${randomUUID()}`;
    const root = await this.checkedDirectory(task);
    const preview = { id: task.id, sha };
    this.preview = preview;
    const controller = new AbortController();
    let session = null;
    const exited = async () => {
      controller.abort();
      if (session) { session.endedAt = now(); await this.save().catch(() => {}); }
      try { await this.removePreview(task, folder); }
      catch (error) { task.error = error.message; await this.save(); }
      finally { if (this.preview === preview) this.preview = null; }
    };
    try {
      let started;
      const ready = new Promise((resolve, reject) => { started = { resolve, reject }; });
      preview.done = withIterationEnvironment(async (env) => {
        try {
          preview.child = await this.launch({ workspace: this.workspace(task), directory: join(root, folder), env, data: realData ? this.getDataRoot() : null, onExit: () => controller.abort() });
          if (controller.signal.aborted) throw new Error("候选预览启动后立即退出。");
          if (record.result === "success") {
            session = { sha, startedAt: now(), realData: Boolean(realData) };
            task.previews = [...(task.previews ?? []).slice(-19), session];
            await this.save();
          }
          started.resolve();
          if (!controller.signal.aborted) await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
        } catch (error) { started.reject(error); }
        finally { await exited(); }
      });
      void preview.done.catch((error) => { task.error = error.message; });
      await Promise.race([ready, preview.done]);
    } catch (error) { await preview.done?.catch(() => {}); if (this.preview === preview) this.preview = null; throw error; }
  }

  async stopPreview() {
    const preview = this.preview;
    if (!preview?.child) return;
    stopProcess(preview.child);
    await preview.done;
  }

  async checkedDirectory(task) {
    const root = await realpath(this.root);
    if (root !== join(await realpath(this.profile), "iterations")) throw new Error("迭代根目录越界。 ");
    const directory = await realpath(this.directory(task));
    if (!within(root, directory) || directory !== join(root, String(task.number || task.id))) throw new Error("任务目录越界，已保留供检查。");
    return directory;
  }

  async removePreview(task, folder) {
    if (!/^(?:preview|preview-[a-f0-9-]{36})$/.test(folder)) throw new Error("无效的预览目录。");
    const requested = join(this.directory(task), folder);
    const info = await lstat(requested).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (!info) return;
    const root = await this.checkedDirectory(task);
    const target = await realpath(requested);
    if (!info.isDirectory() || target !== join(root, folder)) throw new Error("预览目录越界，已保留供检查。");
    await rm(target, { recursive: true, force: true });
  }
}
