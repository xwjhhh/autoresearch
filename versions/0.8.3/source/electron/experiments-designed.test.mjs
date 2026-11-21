import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentLab, copyBaseline, normalizeBudget } from "./experiments/service.mjs";
import { WorkspaceGit } from "./experiments/git.mjs";

const projectId = "44444444-4444-4444-8444-444444444444";
const posix = process.platform !== "win32";
const hasGit = (() => { try { execFileSync("git", ["--version"]); return true; } catch { return false; } })();

async function waitFor(check, timeout = 10_000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error("等待超时");
    await new Promise((done) => setTimeout(done, 40));
  }
}

const idea = {
  id: "idea_001", title: "用轨迹定位校验模型反思", mechanism: "过滤掉和轨迹定位不一致的反思后再微调。",
  experiment: "过滤后 HumanEval pass@1 比基线高至少 1 个点。", difference: "ReflexTune 不校验反思。", evidence: "paper_001 p.4", status: "candidate",
};

async function setup({ turns = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-designed-"));
  const pdfPath = join(root, "source.pdf");
  await writeFile(pdfPath, "%PDF-1.4 test");
  const calls = [];
  const links = [];
  const lab = new ExperimentLab({
    projectRoot: () => join(root, "project"),
    loadPaper: async (_projectId, paperId) => ({ id: paperId, title: `${paperId} 标题：副标题`, pdfPath, analysisScript: "", chunks: [{ page: 1, text: `${paperId} 正文` }] }),
    loadIdea: async (_projectId, ideaId) => { if (ideaId !== "idea_001") throw new Error("设想不存在"); return idea; },
    linkIdea: async (...args) => { links.push(args); },
    runAgent: async (prompt, options) => {
      const index = calls.length;
      calls.push({ prompt, options });
      return (turns[index] ?? (async () => ({ finalResponse: `第 ${index + 1} 轮` })))(options, prompt);
    },
    pollMs: 40,
    autoWakeLimit: 3,
  });
  return { root, lab, calls, links };
}

const idle = async (lab, id) => waitFor(async () => (await lab.get(projectId, id)).experiment.agent === "idle");

test("预算：只接受正数，个数取整", () => {
  assert.deepEqual(normalizeBudget({ maxJobs: "3", maxHours: "1.25" }), { maxJobs: 3, maxHours: 1.3 });
  assert.deepEqual(normalizeBudget({ maxJobs: 0, maxHours: -1 }), { maxJobs: null, maxHours: null });
  assert.deepEqual(normalizeBudget(undefined), { maxJobs: null, maxHours: null });
});

test("复制基线时跳过环境、缓存、运行产物、平台文件和大文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-copy-"));
  try {
    const source = join(root, "source");
    for (const dir of ["src", ".venv/lib", "runs/r1", ".ar/logs", "repo/.git", "paper"]) await mkdir(join(source, dir), { recursive: true });
    await writeFile(join(source, "src", "train.py"), "print(1)");
    await writeFile(join(source, "paper", "paper.md"), "# 论文");
    await writeFile(join(source, ".venv", "lib", "x.py"), "x");
    await writeFile(join(source, "runs", "r1", "eval.json"), "{}");
    await writeFile(join(source, ".ar", "logs", "a.log"), "log");
    await writeFile(join(source, "repo", ".git", "HEAD"), "ref");
    await writeFile(join(source, "REPRO.md"), "# 复现");
    await writeFile(join(source, "big.bin"), Buffer.alloc(2048));
    const target = join(root, "target");
    const result = await copyBaseline(source, target, { maxFileBytes: 1024 });
    assert.ok(existsSync(join(target, "src", "train.py")));
    assert.ok(existsSync(join(target, "paper", "paper.md")));
    for (const missing of [".venv", "runs", ".ar", "repo/.git", "REPRO.md", "big.bin"]) assert.equal(existsSync(join(target, missing)), false, missing);
    assert.deepEqual(result.skipped.map((item) => item.path), ["big.bin"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("设计实验：从复现复制代码、建版本、第一轮只出方案，并记下设想与基线", { skip: !hasGit && "需要 Git" }, async () => {
  const ctx = await setup();
  try {
    await ctx.lab.create(projectId, { paperId: "paper_001", goal: "复现 Table 2" });
    await idle(ctx.lab, "exp_001");
    const baselineWorkspace = join(ctx.root, "project", "Experiments", "PaperReproductions", "exp_001", "workspace");
    await mkdir(join(baselineWorkspace, "reflextune"), { recursive: true });
    await writeFile(join(baselineWorkspace, "reflextune", "train.py"), "lr = 2e-5\n");
    await writeFile(join(baselineWorkspace, "REPRO.md"), "# 复现记录\n\nHumanEval 61.9");

    await assert.rejects(ctx.lab.create(projectId, { kind: "designed", ideaId: "idea_001" }), /至少关联一篇论文/);
    const snapshot = await ctx.lab.create(projectId, { kind: "designed", ideaId: "idea_001", baselineId: "exp_001", paperIds: ["paper_002"], goal: "先只做 HumanEval", settings: { budget: { maxJobs: 2 } } });
    const experiment = snapshot.experiment;
    assert.equal(experiment.id, "exp_002");
    assert.equal(experiment.kind, "designed");
    assert.equal(experiment.baselineId, "exp_001");
    assert.equal(experiment.git, true);
    assert.deepEqual(experiment.paperIds, ["paper_001", "paper_002"]);
    assert.deepEqual(experiment.settings.budget, { maxJobs: 2, maxHours: null });
    assert.deepEqual(ctx.links, [[projectId, "idea_001", "exp_002"]]);

    const workspace = join(ctx.root, "project", "Experiments", "DesignedExperiments", "exp_002", "workspace");
    assert.equal(await readFile(join(workspace, "reflextune", "train.py"), "utf8"), "lr = 2e-5\n");
    assert.match(await readFile(join(workspace, "BASELINE.md"), "utf8"), /HumanEval 61\.9/);
    assert.match(await readFile(join(workspace, "idea.md"), "utf8"), /过滤后 HumanEval/);
    assert.match(await readFile(join(workspace, "AGENTS.md"), "utf8"), /设计实验说明[\s\S]*BASELINE\.md/);
    assert.match(await readFile(join(workspace, "EXPERIMENT.md"), "utf8"), /## 假设与预期\n过滤后 HumanEval/);
    assert.ok(existsSync(join(workspace, ".ar", "conclude.mjs")));
    assert.ok(existsSync(join(workspace, "papers", "paper_002", "paper.md")));
    assert.equal(JSON.parse(await readFile(join(workspace, ".ar", "baseline.json"), "utf8")).experimentId, "exp_001");
    assert.match(execFileSync("git", ["-C", workspace, "tag"], { encoding: "utf8" }), /ar-baseline/);

    await idle(ctx.lab, "exp_002");
    assert.match(ctx.calls[1].prompt, /这一轮只做方案[\s\S]*请研究者确认/);
    assert.match(ctx.calls[1].prompt, /最多 2 个后台任务/);
    const list = await ctx.lab.list(projectId);
    const designed = list.find((item) => item.id === "exp_002");
    assert.equal(designed.type, "designed");
    assert.equal(designed.kind, "设计实验");
    assert.equal(designed.ideaId, "idea_001");
    assert.equal(list.find((item) => item.id === "exp_001").type, "reproduction");
    assert.match((await ctx.lab.get(projectId, "exp_002")).record, /实验记录/);
    await assert.rejects(ctx.lab.diff(projectId, "exp_001"), /只有设计实验/);
  } finally {
    await ctx.lab.stopAll();
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("设计实验：任务启动前记录代码版本，预算用完不再自动运行，结论记到实验上，能看到相对基线的改动", { skip: (!posix || !hasGit) && "需要 /bin/sh 和 Git" }, async () => {
  const ctx = await setup({
    turns: [
      async () => ({ finalResponse: "复现计划" }),
      async (options) => {
        await writeFile(join(options.workingDirectory, "filter.py"), "def keep(x):\n    return True\n");
        execFileSync(process.execPath, [".ar/run.mjs", "first", "--", "echo first-run"], { cwd: options.workingDirectory });
        execFileSync(process.execPath, [".ar/run.mjs", "second", "--", "echo second-run"], { cwd: options.workingDirectory });
        return { finalResponse: "提交了两个任务" };
      },
      async (options) => {
        execFileSync(process.execPath, [".ar/conclude.mjs", "--verdict", "refuted", "--summary", "过滤后没有提升（61.8 对 61.9）。"], { cwd: options.workingDirectory });
        return { finalResponse: "结论已提交" };
      },
    ],
  });
  try {
    await ctx.lab.create(projectId, { paperId: "paper_001", goal: "复现" });
    await idle(ctx.lab, "exp_001");
    await ctx.lab.create(projectId, { kind: "designed", ideaId: "idea_001", baselineId: "exp_001", settings: { approveJobs: false, budget: { maxJobs: 1 } } });
    const jobs = await waitFor(async () => {
      const snapshot = await ctx.lab.get(projectId, "exp_002");
      return snapshot.jobs.length === 2 && snapshot.jobs[0].status !== "running" && snapshot.jobs[0].status !== "pending" ? snapshot.jobs : null;
    });
    assert.equal(jobs[0].status, "done");
    assert.match(jobs[0].codeVersion, /^[0-9a-f]{7,12}$/);
    assert.equal(jobs[1].status, "pending");
    const snapshot = await ctx.lab.get(projectId, "exp_002");
    assert.ok(snapshot.events.some((event) => event.type === "system" && /预算已用完/.test(event.text ?? "")));

    await waitFor(() => ctx.calls.length >= 3);
    await idle(ctx.lab, "exp_002");
    const done = await ctx.lab.get(projectId, "exp_002");
    assert.equal(done.experiment.outcome.verdict, "refuted");
    assert.match(done.experiment.outcome.summary, /没有提升/);
    assert.equal((await ctx.lab.list(projectId)).find((item) => item.id === "exp_002").outcome, "refuted");

    const diff = await ctx.lab.diff(projectId, "exp_002");
    assert.equal(diff.available, true);
    assert.ok(diff.files.some((file) => file.path === "filter.py" && file.added === 2));
    assert.match(diff.patch, /\+def keep/);

    const workspace = join(ctx.root, "project", "Experiments", "DesignedExperiments", "exp_002", "workspace");
    assert.match(execFileSync("git", ["-C", workspace, "show", "--stat", jobs[0].codeVersion], { encoding: "utf8" }), /filter\.py/);

    await ctx.lab.updateSettings(projectId, "exp_002", { budget: { maxJobs: 3 } });
    await waitFor(async () => (await ctx.lab.get(projectId, "exp_002")).jobs[1].status === "done");
  } finally {
    await ctx.lab.stopAll();
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("Git：大文件不进版本库，没有 Git 时安静地跳过", { skip: !hasGit && "需要 Git" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-git-"));
  try {
    const git = new WorkspaceGit({ maxFileBytes: 100 });
    await writeFile(join(root, "a.py"), "print(1)\n");
    const base = await git.init(root);
    assert.match(base, /^[0-9a-f]+$/);
    await writeFile(join(root, "huge.npy"), Buffer.alloc(500));
    await writeFile(join(root, "a.py"), "print(2)\n");
    const commit = await git.snapshot(root, "改动");
    const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
    assert.match(tracked, /a\.py/);
    assert.doesNotMatch(tracked, /huge\.npy/);
    assert.notEqual(commit, base);
    const missing = new WorkspaceGit({ gitPath: join(root, "no-such-git") });
    assert.equal(await missing.init(root), null);
    assert.equal(await missing.snapshot(root, "x"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
