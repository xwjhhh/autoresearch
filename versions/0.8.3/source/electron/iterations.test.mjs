import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { AppIterations } from "./iterations.mjs";
import { githubRepository, runCommand } from "./iteration-github.mjs";

const git = (cwd, ...args) => runCommand("git", args, { cwd }).then((value) => value.trim());

async function setup(context, { validation = "success", offline = false } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "ar-iterations-"));
  context.after(async () => {
    if (!relative(tmpdir(), resolve(temp)).startsWith("ar-iterations-")) throw new Error("临时目录越界");
    await rm(temp, { recursive: true, force: true });
  });
  const source = join(temp, "source");
  const remote = join(temp, "remote");
  const profile = join(temp, "profile");
  await mkdir(source);
  await mkdir(remote);
  await git(remote, "init", "--bare", "-b", "main");
  await git(source, "init", "-b", "main");
  await git(source, "config", "core.autocrlf", "false");
  await git(source, "config", "user.name", "Iteration Test");
  await git(source, "config", "user.email", "iteration@example.invalid");
  await writeFile(join(source, "package.json"), '{"name":"autoresearch-desktop"}');
  await writeFile(join(source, "playwright.config.mjs"), "export default {};\n");
  await mkdir(join(source, "scripts"));
  await writeFile(join(source, "scripts", "iteration-fixture.mjs"), "export const fixture = 'original';\n");
  await writeFile(join(source, "app.txt"), "base\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "base");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "origin", "main");

  const history = [];
  const statuses = new Map();
  let offlineNow = offline;
  let mode = "source";
  const pulls = new Map();
  let issues = 0;
  let turns = 0;
  const hub = {
    connect: async () => "main",
    issue: async () => { const number = 12 + issues++; return { number, html_url: `https://github.com/test/app/issues/${number}` }; },
    pull: async (task) => { const number = task.number + 19; pulls.set(number, { branch: task.branch }); return { number, html_url: `https://github.com/test/app/pull/${number}` }; },
    label: async (number, value) => { history.push(["label", number, value]); },
    comment: async (number, text) => { history.push(["comment", number, text]); },
    status: async (sha, state) => { history.push(["status", sha, state]); statuses.set(sha, state); },
    verified: async (sha) => statuses.get(sha) === "success",
    api: async (path, options) => {
      const pull = pulls.get(Number(path.split("/").at(-1)));
      if (options) {
        if (pull && options.body.state === "closed") pull.closed = true;
        history.push([options.method, path, options.body]); return {};
      }
      return { state: pull.closed || pull.merged ? "closed" : "open", head: { sha: pull.head ?? await git(remote, "rev-parse", `refs/heads/${pull.branch}`) }, merged: Boolean(pull.merged), merge_commit_sha: pull.merged };
    },
    merge: async (number, sha) => {
      const pull = pulls.get(number);
      assert.equal(await git(remote, "rev-parse", `refs/heads/${pull.branch}`), sha);
      const parent = await git(remote, "rev-parse", "refs/heads/main");
      const squash = await git(source, "commit-tree", `${sha}^{tree}`, "-p", parent, "-m", `Squash #${number}`);
      await git(source, "push", "origin", `${squash}:refs/heads/main`);
      pull.merged = squash;
      pull.head = sha;
      history.push(["squash", number, sha]);
      return { merged: true, sha: squash };
    },
  };
  const config = {
    profile,
    getDataRoot: () => join(temp, "data"),
    github: () => hub,
    run: async (file, args, options) => {
      if (args.includes("get-url")) return "git@github.com:test/app.git\n";
      if (offlineNow && args.includes("fetch")) throw new Error("模拟网络断开");
      return runCommand(file, args, options);
    },
    agent: async (prompt, { workingDirectory, env, onEvent }) => {
      assert.ok(env.GH_CONFIG_DIR);
      assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
      assert.equal(env.GH_TOKEN, undefined);
      await onEvent({ type: "item.started", item: { type: "command_execution", command: "test command" } });
      turns++;
      const acceptance = join(workingDirectory, "tests", "acceptance", `iter-${/任务 #(\d+)/.exec(prompt)[1]}`);
      if (prompt.includes("只将验收条件写成测试")) {
        await mkdir(acceptance, { recursive: true });
        await writeFile(join(acceptance, "scenario.test.mjs"), 'import "node:test";\n');
      } else if (mode === "acceptance") {
        await writeFile(join(acceptance, "scenario.test.mjs"), 'import "node:assert/strict";\n');
      } else if (mode === "fixture") await writeFile(join(workingDirectory, "scripts", "iteration-fixture.mjs"), "export const fixture = 'tampered';\n");
      else await writeFile(join(workingDirectory, "app.txt"), `turn ${turns}\n`);
      return { finalResponse: `完成轮次 ${turns}` };
    },
    launch: async ({ onExit }) => { setTimeout(onExit, 5); return {}; },
    verify: async ({ output, onProgress, onStep }) => {
      await onProgress("1/1 · 构建");
      await writeFile(join(output, "01.log"), `模拟验证 ${validation}\n`);
      await onStep({ name: "构建", command: "npm run build", durationMs: 1, exitCode: validation === "success" ? 0 : 1, logFile: "01.log" });
      return validation;
    },
  };
  const service = new AppIterations(config);
  const task = async () => (await service.snapshot()).tasks[0];
  const action = async (name, input) => service.perform(name, { id: (await task())?.id, sha: (await task())?.sha, ...input });
  offlineNow = false;
  await service.perform("bind", { path: source });
  offlineNow = offline;
  return { service, task, action, source, remote, profile, config, history, externalMerge: hub.merge, setOnline: () => { offlineNow = false; }, changeAcceptance: () => { mode = "acceptance"; }, changeFixture: () => { mode = "fixture"; }, issueCount: () => issues };
}

const proposal = { title: "改进失败任务", description: "显示失败原因", criteria: "显示日志摘要", base: "remote" };
async function start(harness) {
  await harness.action("create", proposal);
  await harness.action("draft");
  await harness.action("confirm");
}

async function openPreview(harness) {
  await harness.action("preview", { realData: false });
  for (let waited = 0; (await harness.service.snapshot()).preview; waited += 10) {
    if (waited > 5000) throw new Error("预览没有结束");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function tryOut(harness, results) {
  await openPreview(harness);
  const { trialItems } = await harness.task();
  await harness.action("trial", { results: results ?? trialItems.map(() => ({ result: "pass" })) });
}

test("GitHub 地址解析同时支持 HTTPS 和 SSH", () => {
  assert.equal(githubRepository("https://github.com/org/app.git"), "org/app");
  assert.equal(githubRepository("git@github.com:org/app.git"), "org/app");
  assert.equal(githubRepository("https://github.com.other.test/org/app.git"), null);
});

test("迭代运行时隔离线程，审批仅属于当前任务且只能应答一次", async (context) => {
  const harness = await setup(context);
  await harness.action("create", proposal);
  const task = await harness.task();
  const inCard = Promise.withResolvers();
  harness.service.agent = async (prompt, options) => {
    assert.equal(options.runtime, "app-server");
    assert.equal(options.threadId, undefined);
    await options.onThread("app-server-thread");
    options.onDelta("正在准备验收");
    const answer = options.onApproval({ id: "approval", kind: "command", title: "批准一次只读命令", detail: "pwd" }, options.signal);
    inCard.resolve();
    assert.equal(await answer, true);
    options.onDelta("");
    return harness.config.agent(prompt, options);
  };
  const draft = harness.action("draft");
  const snapshot = await Promise.race([inCard.promise.then(() => harness.service.snapshot()), draft.then(() => { throw new Error("缺少审批"); })]);
  assert.equal(snapshot.approvals[0].taskId, task.id);
  assert.equal(snapshot.stream?.text, "正在准备验收");
  const decision = { approvalId: "approval", approve: true };
  await assert.rejects(harness.action("decideAgentApproval", { ...decision, id: "another-task" }), /不属于/);
  await harness.action("decideAgentApproval", decision);
  await assert.rejects(harness.action("decideAgentApproval", decision), /已结束/);
  await draft;
  assert.deepEqual((await harness.service.snapshot()).approvals, []);
  assert.ok((await harness.task()).events.some(({ text }) => text === "用户批准 · 命令"));

  await harness.service.perform("settings", { runtime: "sdk" });
  harness.service.agent = (prompt, options) => {
    assert.equal(options.runtime, "sdk");
    assert.equal(options.threadId, undefined);
    return harness.config.agent(prompt, options);
  };
  await harness.action("draft");
  assert.equal((await harness.task()).appServerThreadId, "app-server-thread");
});

test("冻结验收、验证候选、批准后再次验证并合并", async (context) => {
  const harness = await setup(context);
  await start(harness);
  const frozen = (await harness.task()).freeze;
  await harness.action("implement");
  const changed = await harness.task();
  assert.equal(changed.status, "review");
  assert.equal(changed.freeze.hash, frozen.hash);
  assert.equal(changed.verifications[0].sha, changed.sha);
  const diff = await harness.service.diff(changed.id);
  assert.deepEqual(diff.files, ["tests/acceptance/iter-12/scenario.test.mjs", "app.txt"]);
  assert.match(await harness.service.artifact(changed.id, 1, "log", "01.log"), /success/);
  await tryOut(harness);
  await harness.action("approve");
  assert.equal((await harness.task()).approval.sha, changed.sha);
  await harness.action("merge");
  assert.equal((await harness.task()).status, "merged");
  assert.equal((await harness.task()).verifications.length, 1);
  assert.equal((await harness.task()).worktreeReady, false);
  assert.ok(harness.history.some(([event, number, sha]) => event === "squash" && number === 31 && sha === changed.sha));
  await assert.rejects(git(harness.remote, "show-ref", "--verify", `refs/heads/${changed.branch}`));
  await assert.rejects(git(harness.source, "show-ref", "--verify", `refs/heads/${changed.branch}`));
  assert.ok((await harness.task()).events.some(({ kind }) => kind === "verify"));
});

test("外部合并即使有本地批准也标记异常，保留候选并留言", async (context) => {
  const harness = await setup(context);
  await start(harness);
  await harness.action("implement");
  await tryOut(harness);
  await harness.action("approve");
  const { sha } = await harness.task();
  await harness.externalMerge(31, sha);
  await harness.action("sync");
  const task = await harness.task();
  assert.equal(task.status, "anomaly");
  assert.equal(task.approval, null);
  assert.equal(task.worktreeReady, true);
  assert.ok(harness.history.some(([event, number, text]) => event === "comment" && number === 31 && text.includes("没有与该提交匹配的平台批准")));
});

test("回退通过独立任务验证，不直接修改远程主线", async (context) => {
  const harness = await setup(context);
  await start(harness);
  await harness.action("implement");
  await tryOut(harness);
  await harness.action("approve");
  await harness.action("merge");
  const original = (await harness.task()).mergedSha;
  await harness.action("revert");
  assert.equal((await harness.task()).revertTarget, original);
  await harness.action("draft");
  await harness.action("confirm");
  await harness.action("implement");
  const revert = await harness.task();
  assert.equal(revert.status, "review");
  assert.equal(revert.verifications.at(-1).result, "success");
  assert.equal(await git(harness.remote, "rev-parse", "main"), original);
  assert.equal(await readFile(join(harness.profile, "iterations", "13", "worktree", "app.txt"), "utf8"), "base\n");
  await tryOut(harness);
  await harness.action("approve");
  await harness.action("merge");
  assert.equal((await harness.task()).status, "merged");
});

test("放弃后清理旧预览目录和候选，移除本地与远程分支", async (context) => {
  const harness = await setup(context);
  await start(harness);
  const task = await harness.task();
  const preview = join(harness.profile, "iterations", "12", "preview", "profile");
  await mkdir(preview, { recursive: true });
  await writeFile(join(preview, "api-key.bin"), "synthetic");
  await harness.action("abandon", { text: "不再需要" });
  assert.equal((await harness.task()).status, "abandoned");
  await assert.rejects(access(preview));
  await assert.rejects(access(join(harness.profile, "iterations", "12", "worktree")));
  await assert.rejects(git(harness.remote, "show-ref", "--verify", `refs/heads/${task.branch}`));
  await assert.rejects(git(harness.source, "show-ref", "--verify", `refs/heads/${task.branch}`));
});

test("冻结同时覆盖测试辅助数据脚本", async (context) => {
  const harness = await setup(context);
  await start(harness);
  harness.changeFixture();
  await harness.action("implement");
  assert.equal((await harness.task()).status, "spec");
  assert.equal((await harness.task()).freeze, null);
  assert.equal((await harness.task()).verifications.length, 0);
});

test("验收文件被修改时平台撤销确认并记录差异", async (context) => {
  const harness = await setup(context);
  await start(harness);
  harness.changeAcceptance();
  await harness.action("implement");
  const task = await harness.task();
  assert.equal(task.status, "spec");
  assert.equal(task.freeze, null);
  assert.equal(task.verifications.length, 0);
  assert.ok(harness.history.some(([event, , text]) => event === "comment" && text.includes("验收冻结已失效") && text.includes("scenario.test.mjs")));
});

test("批准后的新提交使批准失效，重新验证并等待再次批准", async (context) => {
  const harness = await setup(context);
  await start(harness);
  await harness.action("implement");
  await tryOut(harness);
  await harness.action("approve");
  const worktree = join(harness.profile, "iterations", "12", "worktree");
  await writeFile(join(worktree, "app.txt"), "later change\n");
  await git(worktree, "commit", "-am", "later change");
  await harness.service.checkDrift();
  const task = await harness.task();
  assert.equal(task.status, "review");
  assert.equal(task.approval, null);
  assert.equal(task.verifications.at(-1).sha, task.sha);
  assert.equal(task.verifications.length, 2);
  assert.ok(harness.history.some(([event, , text]) => event === "comment" && text.includes("批准已失效")));
});

test("远程主线前进后重新验证，新提交需要再次批准", async (context) => {
  const harness = await setup(context);
  await start(harness);
  await harness.action("implement");
  await tryOut(harness);
  await harness.action("approve");
  const approved = (await harness.task()).sha;
  await writeFile(join(harness.source, "from-main.txt"), "remote main\n");
  await git(harness.source, "add", "from-main.txt");
  await git(harness.source, "commit", "-m", "advance main");
  await git(harness.source, "push", "origin", "main");
  await harness.action("merge");
  const updated = await harness.task();
  assert.equal(updated.status, "review");
  assert.notEqual(updated.sha, approved);
  assert.equal(updated.approval, null);
  assert.equal(updated.trial, null);
  assert.ok(harness.history.some(([event, , text]) => event === "comment" && text.includes("人工试用已失效")));
  assert.equal(updated.verifications.at(-1).sha, updated.sha);
  assert.equal(updated.verifications.at(-1).result, "success");
  assert.equal(harness.history.some(([event]) => event === "squash"), false);
  await assert.rejects(harness.action("approve"), /人工试用/);
  await tryOut(harness);
  await harness.action("approve");
  await harness.action("merge");
  assert.equal((await harness.task()).status, "merged");
});

test("更新主线发生冲突时保留候选并退回审阅", async (context) => {
  const harness = await setup(context);
  await start(harness);
  await harness.action("implement");
  await tryOut(harness);
  await harness.action("approve");
  const before = await harness.task();
  await writeFile(join(harness.source, "app.txt"), "conflicting main edit\n");
  await git(harness.source, "commit", "-am", "conflict with candidate");
  await git(harness.source, "push", "origin", "main");
  await assert.rejects(harness.action("merge"), /发生冲突.*\napp\.txt/);
  const after = await harness.task();
  assert.equal(after.status, "review");
  assert.equal(after.sha, before.sha);
  assert.equal(after.approval, null);
  assert.equal(await git(join(harness.profile, "iterations", "12", "worktree"), "status", "--porcelain"), "");
});

test("验证失败达到上限后停止自动修复", async (context) => {
  const harness = await setup(context, { validation: "failure" });
  await harness.service.perform("settings", { limit: 2 });
  await start(harness);
  await harness.action("implement");
  const task = await harness.task();
  assert.equal(task.status, "review");
  assert.deepEqual(task.verifications.map((item) => item.result), ["failure", "failure"]);
  await assert.rejects(harness.action("approve"), /必须通过验证/);
});

test("新建时断网会保存任务，重启同步时恢复同一任务", async (context) => {
  const harness = await setup(context, { offline: true });
  await writeFile(join(harness.source, "app.txt"), "uncommitted\n");
  await assert.rejects(harness.action("create", { ...proposal, base: undefined }), /明确选择/);
  await assert.rejects(harness.action("create", proposal), /网络断开/);
  const pending = await harness.task();
  assert.equal(pending.status, "draft");
  assert.equal(harness.issueCount(), 0);
  harness.setOnline();
  const recovered = new AppIterations(harness.config);
  await recovered.perform("sync", { id: pending.id });
  await recovered.perform("sync", { id: pending.id });
  assert.equal(harness.issueCount(), 1);
  assert.equal((await recovered.snapshot()).tasks[0].number, 12);
});

test("验收条件按行拆成试用清单，去掉列表符号", () => {
  const items = AppIterations.prototype.trialItems.call(null, { title: "改进", criteria: "- [ ] 显示日志摘要\n\n2. 点击重试只运行所选任务\n* 失败任务标红" });
  assert.deepEqual(items, ["显示日志摘要", "点击重试只运行所选任务", "失败任务标红"]);
  assert.deepEqual(AppIterations.prototype.trialItems.call(null, { title: "改进", criteria: "" }), ["需求已实现：改进"]);
  const longList = Array.from({ length: 31 }, (_, index) => `验收条件 ${index + 1}`);
  assert.deepEqual(AppIterations.prototype.trialItems.call(null, { criteria: longList.join("\n") }), longList);
});

test("自动验证通过前打开的预览不能用于人工试用", async (context) => {
  const harness = await setup(context);
  await harness.service.perform("settings", { limit: 1 });
  await start(harness);
  harness.service.verify = async (options) => {
    await harness.config.verify(options);
    await options.onStep({ name: "场景测试", command: "npm run test:e2e", durationMs: 1, exitCode: 1, logFile: "02.log" });
    await writeFile(join(options.output, "02.log"), "模拟场景测试失败\n");
    return "failure";
  };
  await harness.action("implement");
  const failed = await harness.task();
  assert.equal(failed.verifications.at(-1).result, "failure");
  await openPreview(harness);
  harness.service.verify = harness.config.verify;
  await harness.action("validate");
  const validated = await harness.task();
  assert.equal(validated.sha, failed.sha);
  await assert.rejects(harness.action("trial", { results: [{ result: "pass" }] }), /打开预览/);
  await tryOut(harness);
  await harness.action("approve");
  assert.equal((await harness.task()).status, "approved");
});

test("旧任务的批准没有匹配的试用记录时退回审阅", async (context) => {
  const harness = await setup(context);
  await start(harness);
  await harness.action("implement");
  await tryOut(harness);
  await harness.action("approve");
  const { id, sha } = await harness.task();
  const task = harness.service.task(id);
  delete task.approval.trial;
  delete task.trial;
  await harness.service.save();
  await assert.rejects(harness.action("merge"), /人工试用记录/);
  const reviewed = await harness.task();
  assert.equal(reviewed.status, "review");
  assert.equal(reviewed.sha, sha);
  assert.equal(reviewed.approval, null);
  assert.equal(harness.history.some(([event]) => event === "squash"), false);
});

test("批准前必须在预览中试用当前提交，未通过的问题交给 Agent 返工", async (context) => {
  const harness = await setup(context);
  await start(harness);
  await harness.action("implement");
  assert.equal((await harness.task()).status, "review");
  await assert.rejects(harness.action("approve"), /人工试用/);
  await assert.rejects(harness.action("trial", { results: [{ result: "pass" }] }), /打开预览/);

  await openPreview(harness);
  const opened = await harness.task();
  assert.equal(opened.previews.at(-1).sha, opened.sha);
  assert.ok(opened.previews.at(-1).endedAt);
  await assert.rejects(harness.action("trial", { results: [] }), /每一条/);
  await assert.rejects(harness.action("trial", { results: [{ result: "fail" }] }), /写明/);
  await harness.action("trial", { results: [{ result: "fail", note: "日志摘要没有显示" }] });
  const failed = await harness.task();
  assert.equal(failed.trial.passed, false);
  assert.equal(failed.trial.sha, failed.sha);
  assert.ok(failed.pendingFeedback.some((text) => text.includes("日志摘要没有显示")));
  assert.ok(harness.history.some(([event, , text]) => event === "comment" && text.includes("人工试用未通过")));
  await assert.rejects(harness.action("approve"), /人工试用/);

  const prompts = [];
  const original = harness.service.agent;
  harness.service.agent = (prompt, options) => { prompts.push(prompt); return original(prompt, options); };
  await harness.action("implement");
  assert.ok(prompts[0].includes("日志摘要没有显示"));
  const reworked = await harness.task();
  assert.notEqual(reworked.sha, failed.sha);
  assert.equal(reworked.trial, null);
  assert.equal(reworked.trials.length, 1);
  assert.ok(harness.history.some(([event, , text]) => event === "comment" && text.includes("人工试用已失效")));
  await assert.rejects(harness.action("approve"), /人工试用/);

  await tryOut(harness);
  await harness.action("approve");
  assert.equal((await harness.task()).approval.trial, (await harness.task()).trial.at);
  await harness.action("merge");
  assert.equal((await harness.task()).status, "merged");
  assert.ok(harness.history.some(([method, , body]) => method === "PATCH" && body?.body?.includes("## 人工试用\n通过")));
});

test("完全权限的提示词要求 Agent 自检并记录经验，受限模式不要求", () => {
  const self = { acceptance: () => "tests/acceptance/iter-7", frozenPaths: () => ["tests/acceptance/iter-7", "playwright.config.mjs"] };
  const task = { number: 7, title: "示例", description: "需求", criteria: "- 条件" };
  const spec = AppIterations.prototype.prompt.call(self, task, "spec", { access: "full" });
  assert.match(spec, /只将验收条件写成测试/);
  assert.match(spec, /iteration-check\.mjs tests\/acceptance\/iter-7 --expect-fail/);
  assert.match(spec, /AGENTS\.md/);
  const implement = AppIterations.prototype.prompt.call(self, task, "implement", { access: "full" });
  assert.match(implement, /iteration-check\.mjs tests\/acceptance\/iter-7`/);
  assert.match(implement, /经验记录/);
  assert.doesNotMatch(AppIterations.prototype.prompt.call(self, task, "implement", { access: "restricted" }), /iteration-check/);
});
