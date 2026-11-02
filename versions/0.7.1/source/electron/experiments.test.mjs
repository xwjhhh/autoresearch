import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ExperimentLab, buildJobEnv, lastLogLine, paperMarkdown } from "./experiments/service.mjs";
import { agentBrief, executionPolicy, formatDuration, userTurnPrompt, wakePrompt } from "./experiments/brief.mjs";

const projectId = "22222222-2222-4222-8222-222222222222";
const longCommand = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";

async function waitFor(check, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error("等待超时");
    await new Promise((done) => setTimeout(done, 40));
  }
}

function setup({ turns = [], settings, platform = process.platform, nodePath } = {}) {
  const calls = [];
  const updates = [];
  let root;
  const make = async () => {
    root ??= await mkdtemp(join(tmpdir(), "autoresearch-exp-"));
    const pdfPath = join(root, "source.pdf");
    await writeFile(pdfPath, "%PDF-1.4 test");
    return new ExperimentLab({
      projectRoot: () => join(root, "project"),
      loadPaper: async (_projectId, paperId) => {
        if (paperId !== "paper_001") throw new Error("文献不存在。");
        return {
          id: "paper_001", title: "ReflexTune：基于失败反馈的微调", pdfPath, analysisScript: "讲解稿",
          chunks: [{ page: 7, text: "Table 2: pass@1 62.8" }, { page: 1, text: "Code: github.com/x/y" }, { page: 7, text: "SFT 55.1" }],
        };
      },
      runAgent: async (prompt, options) => {
        const index = calls.length;
        calls.push({ prompt, options });
        const turn = turns[index] ?? (async () => ({ finalResponse: `第 ${index + 1} 轮完成` }));
        return turn(options, prompt);
      },
      emit: (update) => updates.push(update),
      pollMs: 40,
      platform,
      ...(nodePath ? { nodePath } : {}),
    });
  };
  return { calls, updates, make, root: () => root, settings };
}

test("本地 MCP 提问工具等待结构化答案后才返回", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-question-tool-"));
  const requests = join(root, "requests");
  const answers = join(root, "answers");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./experiments/question-server.mjs", import.meta.url))], {
    env: { ...process.env, AUTORESEARCH_QUESTION_REQUESTS: requests, AUTORESEARCH_QUESTION_ANSWERS: answers },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    } catch { /* 忽略非 JSON 输出；协议 stdout 应只包含 JSON-RPC。 */ }
  });
  const call = (method, params = {}) => {
    const id = ++sequence;
    const response = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  };
  try {
    const initialized = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(initialized.result.serverInfo.name, "autoresearch-questions");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = await call("tools/list");
    assert.equal(listed.result.tools[0].name, "request_user_input");
    const responsePromise = call("tools/call", { name: "request_user_input", arguments: { questions: [
      { id: "scope", header: "复现范围", question: "跑哪一部分？", options: [{ label: "单条完整链" }, { label: "论文主表" }], isOther: true },
    ] } });
    const request = await waitFor(async () => {
      const files = await readdir(requests).catch(() => []);
      return files[0] ? JSON.parse(await readFile(join(requests, files[0]), "utf8")) : false;
    });
    assert.equal(request.questions[0].question, "跑哪一部分？");
    assert.equal(await Promise.race([responsePromise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))]), false);
    await writeFile(join(answers, `${request.requestId}.json`), JSON.stringify({ requestId: request.requestId, answers: [{ id: "scope", answer: "单条完整链" }] }));
    const response = await responsePromise;
    assert.equal(response.result.structuredContent.answers[0].answer, "单条完整链");
    assert.match(response.result.content[0].text, /单条完整链/);
    await waitFor(async () => (await readdir(requests).catch(() => [])).length === 0);
  } finally {
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve));
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("实验会话使用独立 Codex thread，可并行运行且停止彼此隔离", async () => {
  const gates = [];
  const ctx = setup({ turns: [async (options) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    gates.push(release);
    await options.onThread("thread-primary");
    await Promise.race([gate, new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }))]);
    return { finalResponse: `完成 ${options.threadId ?? "主会话"}` };
  }, async (options) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    gates.push(release);
    await options.onThread("thread-secondary");
    await Promise.race([gate, new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }))]);
    return { finalResponse: "次会话完成" };
  }] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "并行会话测试" });
    await waitFor(() => ctx.calls.length === 1);
    const created = await lab.createConversation(projectId, "exp_001", "新意见");
    await lab.send(projectId, "exp_001", "补充一个方向", created.id);
    await waitFor(() => ctx.calls.length === 2);
    assert.equal(ctx.calls.length, 2);
    assert.equal(ctx.calls[1].options.threadId, null);
    assert.equal((await lab.get(projectId, "exp_001")).experiment.conversations[0].threadId, "thread-primary");
    assert.equal((await lab.get(projectId, "exp_001")).experiment.conversations[1].threadId, "thread-secondary");
    await lab.stop(projectId, "exp_001", created.id);
    assert.equal((await lab.get(projectId, "exp_001")).experiment.conversations[0].agent, "working");
    gates[0]?.();
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.conversations[0].agent === "idle");
  } finally {
    for (const release of gates) release();
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("旧实验会自动更新运行入口，次会话任务和结果通知留在原会话", async () => {
  const ctx = setup({ turns: [
    async () => ({ finalResponse: "主会话完成" }),
    async (options) => {
      assert.match(options.conversationId, /^conv_/);
      assert.equal(options.shellEnvironment.AUTORESEARCH_CONVERSATION_ID, options.conversationId);
      const helper = join(options.workingDirectory, ".ar", "run.mjs");
      assert.match(await readFile(helper, "utf8"), /AUTORESEARCH_CONVERSATION_ID/);
      execFileSync(process.execPath, [helper, "session-job", "--", "node -e \"process.stdout.write('session job done')\""], {
        cwd: options.workingDirectory,
        env: { ...process.env, ...options.shellEnvironment },
      });
      return { finalResponse: "次会话已提交任务" };
    },
  ] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "会话隔离", settings: { approveJobs: true } });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const entry = await lab.entry(projectId, "exp_001");
    const primaryId = entry.experiment.conversations[0].id;
    const staleHelper = join(entry.workspace, ".ar", "run.mjs");
    await writeFile(staleHelper, "// stale helper from an earlier app version\n", "utf8");
    const secondary = await lab.createConversation(projectId, "exp_001", "会话 2");
    await lab.send(projectId, "exp_001", "增加一个验证方向", secondary.id);

    const pending = await waitFor(async () => {
      const snapshot = await lab.get(projectId, "exp_001");
      return snapshot.jobs.find((job) => job.name === "session-job")?.status === "pending" ? snapshot : false;
    });
    const job = pending.jobs.find((item) => item.name === "session-job");
    assert.equal(job.conversationId, secondary.id);
    assert.ok(pending.events.some((event) => event.type === "user" && event.conversationId === secondary.id && event.text === "增加一个验证方向"));
    assert.ok(pending.events.some((event) => event.type === "job" && event.conversationId === secondary.id && event.jobId === job.id));
    assert.ok(!pending.events.some((event) => event.type === "user" && event.text === "增加一个验证方向" && event.conversationId === primaryId));
    assert.ok(!pending.events.some((event) => event.type === "job" && event.jobId === job.id && event.conversationId === primaryId));

    await lab.jobAction(projectId, "exp_001", job.id, "approve");
    const completed = await waitFor(async () => {
      const snapshot = await lab.get(projectId, "exp_001");
      return snapshot.jobs.find((item) => item.id === job.id)?.status === "done" ? snapshot : false;
    });
    const lifecycle = completed.events.filter((event) => event.jobId === job.id);
    assert.ok(lifecycle.length >= 2);
    assert.ok(lifecycle.every((event) => event.conversationId === secondary.id));
    assert.ok(!completed.events.some((event) => event.type === "agent" && event.text === "次会话已提交任务" && event.conversationId === primaryId));
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("旧实验迁移后保留原 Codex thread 与聊天历史", async () => {
  const ctx = setup();
  const lab = await ctx.make();
  try {
    const root = join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".ar"), { recursive: true });
    await mkdir(join(root, "jobs"), { recursive: true });
    await writeFile(join(root, "experiment.json"), JSON.stringify({
      id: "exp_001", projectId, kind: "reproduction", title: "旧实验", paperId: "paper_001", paperTitle: "论文", goal: "继续", code: "",
      settings: { network: true }, threadId: "thread-legacy", agent: "idle", activity: "", error: null,
      notices: [], pendingQuestion: null, pendingContinuation: null, turns: 4, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify({ id: "event-legacy", at: new Date().toISOString(), type: "user", text: "旧聊天" })}\n`);
    const snapshot = await lab.get(projectId, "exp_001");
    assert.equal(snapshot.experiment.conversations.length, 1);
    assert.equal(snapshot.experiment.conversations[0].threadId, "thread-legacy");
    assert.equal(snapshot.experiment.conversations[0].turns, 4);
    assert.equal(snapshot.events[0].conversationId, snapshot.experiment.conversations[0].id);
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("论文全文按页码排序，并标出页码", () => {
  const text = paperMarkdown("标题", [{ page: 3, text: "c" }, { page: 1, text: "a" }, { page: 3, text: "d" }, { page: 2, text: " " }]);
  assert.match(text, /^# 标题/);
  assert.ok(text.indexOf("## p.1") < text.indexOf("## p.3"));
  assert.match(text, /## p\.3\n\nc\n\nd/);
  assert.equal(text.includes("## p.2"), false);
});

test("Windows 执行器初始化失败时结束本轮，避免反复换命令重试", async () => {
  let continued = false;
  const ctx = setup({ turns: [async (options) => {
    await options.onEvent({ type: "item.completed", item: { type: "command_execution", command: "Get-Location", exit_code: -1, status: "failed", aggregated_output: "Failed to create unified exec process: helper_unknown_error: setup refresh had errors" } });
    continued = true;
    return { finalResponse: "不应该继续" };
  }] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "测试执行器错误" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const snapshot = await lab.get(projectId, "exp_001");
    assert.equal(continued, false);
    assert.match(snapshot.experiment.error, /Windows 命令执行器初始化失败/);
    assert.equal(snapshot.events.filter((event) => event.type === "command").length, 1);
    assert.ok(snapshot.events.some((event) => event.type === "error" && event.text.includes("命令尚未运行")));
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("后台任务只拿到白名单环境变量", () => {
  const env = buildJobEnv({
    PATH: "/bin", Path: "/x", CUDA_VISIBLE_DEVICES: "0", https_proxy: "http://p", CONDA_PREFIX: "/c",
    OPENAI_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", HF_TOKEN: "hf", AUTORESEARCH_JOB_ENV: "hf_token",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CUDA_VISIBLE_DEVICES, "0");
  assert.equal(env.https_proxy, "http://p");
  assert.equal(env.CONDA_PREFIX, "/c");
  assert.equal(env.HF_TOKEN, "hf");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.PYTHONUNBUFFERED, "1");
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONIOENCODING, "utf-8");
});

test("常驻说明按平台写明后台任务用哪个 shell", () => {
  assert.match(agentBrief({ platform: "win32" }), /PowerShell/);
  assert.match(agentBrief({ platform: "win32" }), /SEC_E_NO_CREDENTIALS/);
  assert.match(agentBrief({ platform: "win32" }), /NODE_USE_ENV_PROXY/);
  assert.match(agentBrief({ platform: "win32" }), /mcp__autoresearch_questions__request_user_input/);
  assert.match(agentBrief({ platform: "win32" }), /Get-Command rg/);
  assert.match(agentBrief({ platform: "win32" }), /python -X utf8/);
  assert.match(agentBrief({ platform: "linux" }), /\/bin\/sh/);
  assert.doesNotMatch(agentBrief({ platform: "linux" }), /Get-Command rg|Get-CimInstance/);
  assert.match(agentBrief({ platform: "linux" }), /node \.ar\/run\.mjs/);
  assert.equal(formatDuration(3_725_000), "1 时 2 分");
  assert.equal(formatDuration(65_000), "1 分 5 秒");
  assert.match(userTurnPrompt({ text: "继续", notices: [{ text: "任务结束" }], newThread: true }), /新会话[\s\S]*\[平台通知\][\s\S]*研究者：\n继续/);
  assert.match(userTurnPrompt({ text: "回答", notices: [], newThread: false }), /mcp__autoresearch_questions__request_user_input/);
});

test("只在 Codex 回合结束后显示最终答复并开放下一条消息", async () => {
  let lab;
  let notifyQuestion;
  let finishTurn;
  let finalCallbackCount = 0;
  const questionSeen = new Promise((resolve) => { notifyQuestion = resolve; });
  const turnGate = new Promise((resolve) => { finishTurn = resolve; });
  const ctx = setup({ turns: [async (options) => {
    await options.onThread("thread-1");
    await options.onEvent({ type: "item.completed", item: { type: "agent_message", text: "需要你选一个范围。" } });
    const during = await lab.get(projectId, "exp_001");
    notifyQuestion(during);
    await turnGate;
    await options.onEvent({ type: "item.completed", item: { type: "agent_message", text: "请确认 SearchQA 单条完整链。" } });
    finalCallbackCount += 1;
    return { finalResponse: "请确认 SearchQA 单条完整链。" };
  }, async () => ({ finalResponse: "收到，继续。" })] });
  lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "开始复现" });
    const during = await questionSeen;
    assert.equal(during.experiment.agent, "working");
    assert.equal(during.experiment.pendingQuestion, null);
    assert.equal(during.events.some((event) => event.type === "agent"), false);
    await assert.rejects(lab.send(projectId, "exp_001", "先跑单条链"), /agent 正在工作/);

    finishTurn();
    await waitFor(async () => finalCallbackCount === 1 && (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const completed = await lab.get(projectId, "exp_001");
    assert.equal(ctx.calls.length, 1);
    assert.equal(completed.experiment.pendingQuestion, null);
    assert.equal(completed.events.filter((event) => event.type === "agent").length, 1);
    assert.equal(completed.events.find((event) => event.type === "agent").text, "请确认 SearchQA 单条完整链。");

    await lab.send(projectId, "exp_001", "先跑 SearchQA 单条完整链");
    await waitFor(async () => ctx.calls.length === 2 && (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    assert.match(ctx.calls[1].prompt, /先跑 SearchQA 单条完整链/);
    assert.equal(ctx.calls[1].options.threadId, "thread-1");
  } finally {
    finishTurn();
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("上游限流等待保留工作状态、原线程和历史，恢复后提交最终答复", async () => {
  let release;
  let ready;
  const gate = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { ready = resolve; });
  const ctx = setup({ turns: [async (options) => {
    await options.onThread("thread-rate-limit");
    await options.onEvent({ type: "item.completed", item: { type: "command_execution", command: "Get-Content REPRO.md", exit_code: 0, status: "completed", aggregated_output: "保留记录" } });
    await options.onEvent({ type: "item.completed", item: { type: "agent_message", text: "尚未完成的输出" } });
    await options.onRetry({ attempt: 1, maxAttempts: 5, delayMs: 15_000, phase: "waiting" });
    ready();
    await gate;
    await options.onRetry({ attempt: 1, maxAttempts: 5, delayMs: 0, phase: "resuming" });
    return { finalResponse: "恢复后完成" };
  }] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "保持复现对话" });
    await waiting;
    const during = await lab.get(projectId, "exp_001");
    assert.equal(during.experiment.agent, "working");
    assert.equal(during.experiment.threadId, "thread-rate-limit");
    assert.equal(during.experiment.error, null);
    assert.match(during.experiment.activity, /15 秒后自动恢复/);
    assert.equal(during.events.filter((event) => event.type === "command").length, 1);
    assert.equal(during.events.some((event) => event.type === "error"), false);
    assert.equal(during.events.some((event) => event.type === "agent"), false);
    await assert.rejects(lab.send(projectId, "exp_001", "重复消息"), /agent 正在工作/);
    release();
    await waitFor(async () => (await lab.get(projectId, "exp_001")).events.some((event) => event.type === "agent" && event.text === "恢复后完成"));
    const done = await lab.get(projectId, "exp_001");
    assert.equal(done.experiment.turns, 1);
    assert.equal(done.experiment.threadId, "thread-rate-limit");
    assert.equal(ctx.calls.length, 1);
    assert.deepEqual(done.events.filter((event) => event.type === "agent").map((event) => event.text), ["恢复后完成"]);
  } finally {
    release();
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("结构化问题会暂停界面并在同一 Codex 回合收到答案", async () => {
  let answerSeen;
  const answerReceived = new Promise((resolve) => { answerSeen = resolve; });
  const ctx = setup({ turns: [async (options) => {
    await options.onThread("thread-question");
    const answerPath = join(options.workingDirectory, ".ar", "conversations", options.conversationId, "question-answers");
    const answer = await waitFor(async () => {
      const files = await readdir(answerPath).catch(() => []);
      return files[0] ? JSON.parse(await readFile(join(answerPath, files[0]), "utf8")) : false;
    });
    answerSeen(answer);
    return { finalResponse: "已按你的选择继续。" };
  }] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "询问复现范围" });
    const workspace = join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001", "workspace");
    const requestId = randomUUID();
    const primaryId = (await lab.get(projectId, "exp_001")).experiment.conversations[0].id;
    await writeFile(join(workspace, ".ar", "conversations", primaryId, "questions", `${requestId}.json`), JSON.stringify({
      requestId,
      createdAt: new Date().toISOString(),
      questions: [{ id: "scope", header: "复现范围", question: "这次跑哪部分？", options: [{ label: "单条完整链" }, { label: "论文主表" }], isOther: true }],
    }));
    const pending = await waitFor(async () => {
      const state = await lab.get(projectId, "exp_001");
      return state.experiment.pendingQuestion?.requestId === requestId ? state : false;
    });
    assert.equal(pending.experiment.agent, "waiting");
    assert.equal(pending.experiment.pendingQuestion.questions[0].options[0].label, "单条完整链");
    await assert.rejects(lab.send(projectId, "exp_001", "先跑完整链"), /先回答弹窗里的问题/);

    await lab.answerQuestion(projectId, "exp_001", primaryId, requestId, { scope: "单条完整链" });
    const answer = await answerReceived;
    assert.deepEqual(answer.answers, [{ id: "scope", answer: "单条完整链" }]);
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const done = await lab.get(projectId, "exp_001");
    assert.equal(ctx.calls.length, 1);
    assert.equal(done.experiment.pendingQuestion, null);
    assert.equal(done.experiment.pendingContinuation, null);
    assert.equal(done.experiment.threadId, "thread-question");
    assert.ok(done.events.some((event) => event.type === "user" && event.text.includes("单条完整链")));
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("应用重启后仍显示未回答问题，答案会通过原线程继续", async () => {
  const ctx = setup({ turns: [async (options) => {
    await options.onThread("thread-after-restart");
    await new Promise((resolve, reject) => {
      const abort = () => reject(options.signal.reason);
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    });
    return { finalResponse: "不可到达" };
  }, async (options) => {
    assert.equal(options.threadId, null);
    await options.onThread("thread-after-answer");
    return { finalResponse: "按回答继续完成" };
  }] });
  const first = await ctx.make();
  try {
    await first.create(projectId, { paperId: "paper_001", goal: "等待研究者决定" });
    const workspace = join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001", "workspace");
    const requestId = randomUUID();
    const primaryId = (await first.get(projectId, "exp_001")).experiment.conversations[0].id;
    await writeFile(join(workspace, ".ar", "conversations", primaryId, "questions", `${requestId}.json`), JSON.stringify({
      requestId,
      createdAt: new Date().toISOString(),
      questions: [{ id: "backend", header: "模型後端", question: "使用哪個後端？", options: [{ label: "Azure/OpenAI-compatible API" }, { label: "先準備環境" }], isOther: true }],
    }));
    await waitFor(async () => (await first.get(projectId, "exp_001")).experiment.pendingQuestion?.requestId === requestId);
    await first.stopAll();

    const resumed = await ctx.make();
    await resumed.recover([projectId]);
    const recovered = await resumed.get(projectId, "exp_001");
    assert.equal(recovered.experiment.pendingQuestion.requestId, requestId);
    assert.equal(recovered.experiment.agent, "waiting");
    await resumed.answerQuestion(projectId, "exp_001", primaryId, requestId, { backend: "先準備環境" });
    await waitFor(async () => ctx.calls.length === 2 && (await resumed.get(projectId, "exp_001")).experiment.agent === "idle");
    assert.equal(ctx.calls[1].options.threadId, null);
    assert.equal((await resumed.get(projectId, "exp_001")).experiment.threadId, "thread-after-answer");
    assert.match(ctx.calls[1].prompt, /先準備環境/);
    assert.equal((await resumed.get(projectId, "exp_001")).experiment.pendingQuestion, null);
  } finally {
    await first.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("新建实验会准备工作目录、启动第一轮，并记录 agent 的事件", async () => {
  const ctx = setup({
    turns: [async (options) => {
      await options.onThread("thread-1");
      await options.onEvent({ type: "item.started", item: { type: "command_execution", command: "git clone x" } });
      await options.onEvent({ type: "item.completed", item: { type: "command_execution", command: "git clone x", exit_code: 0, status: "completed", aggregated_output: "done" } });
      await options.onEvent({ type: "item.completed", item: { type: "file_change", status: "completed", changes: [{ path: join(options.workingDirectory, "REPRO.md"), kind: "update" }] } });
      await options.onEvent({ type: "item.completed", item: { type: "agent_message", text: "我的计划是……" } });
      return { finalResponse: "我的计划是……" };
    }],
  });
  const lab = await ctx.make();
  try {
    const snapshot = await lab.create(projectId, { paperId: "paper_001", goal: "复现 Table 2", code: "" });
    assert.equal(snapshot.experiment.id, "exp_001");
    assert.equal(snapshot.experiment.title, "ReflexTune 复现");
    assert.equal(snapshot.experiment.agent, "working");
    const workspace = join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001", "workspace");
    assert.ok(existsSync(join(ctx.root(), "project", "Experiments", "DesignedExperiments")));
    for (const file of ["paper/paper.md", "paper/original.pdf", "paper/analysis.md", "AGENTS.md", "REPRO.md", ".ar/run.mjs", ".ar/question-server.mjs"]) assert.ok(existsSync(join(workspace, file)), file);
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const done = await lab.get(projectId, "exp_001");
    assert.equal(done.experiment.threadId, "thread-1");
    assert.deepEqual(done.events.map((event) => event.type), ["user", "command", "file", "agent"]);
    assert.equal(done.events[2].changes[0].path, "REPRO.md");
    assert.match(ctx.calls[0].prompt, /复现 Table 2/);
    assert.match(ctx.calls[0].prompt, /AGENTS\.md/);
    assert.equal(ctx.calls[0].options.workingDirectory, workspace);
    assert.equal(ctx.calls[0].options.network, true);
    assert.ok(ctx.updates.some((update) => update.experiment?.activity?.startsWith("正在执行")));
    assert.deepEqual((await lab.list(projectId)).map((item) => item.id), ["exp_001"]);
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("旧版 Experiments/exp_NNN 目录仍可读取和恢复", async () => {
  const ctx = setup();
  const first = await ctx.make();
  let resumed;
  try {
    await first.create(projectId, { paperId: "paper_001", goal: "验证旧目录兼容" });
    await waitFor(async () => (await first.get(projectId, "exp_001")).experiment.agent === "idle");
    await first.stopAll();

    const projectRoot = join(ctx.root(), "project");
    const current = join(projectRoot, "Experiments", "PaperReproductions", "exp_001");
    const legacy = join(projectRoot, "Experiments", "exp_001");
    await rename(current, legacy);

    resumed = await ctx.make();
    await resumed.recover([projectId]);
    assert.deepEqual((await resumed.list(projectId)).map((item) => item.id), ["exp_001"]);
    assert.equal((await resumed.get(projectId, "exp_001")).experiment.title, "ReflexTune 复现");
  } finally {
    await first.stopAll();
    await resumed?.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("恢复早期实验时补建缺失的课题依赖申请脚本", async () => {
  const ctx = setup();
  const first = await ctx.make();
  let resumed;
  try {
    await first.create(projectId, { paperId: "paper_001", goal: "迁移旧实验环境入口" });
    await waitFor(async () => (await first.get(projectId, "exp_001")).experiment.agent === "idle");
    await first.stopAll();
    const helper = join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001", "workspace", ".ar", "environment.mjs");
    await rm(helper, { force: true });

    resumed = await ctx.make();
    await resumed.recover([projectId]);
    assert.match(await readFile(helper, "utf8"), /只提交申请/);
    assert.equal((await resumed.get(projectId, "exp_001")).experiment.id, "exp_001");
  } finally {
    await first.stopAll();
    await resumed?.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("恢复早期实验时补建缺失的提问 MCP 脚本和通信目录", async () => {
  const ctx = setup();
  const first = await ctx.make();
  let resumed;
  try {
    await first.create(projectId, { paperId: "paper_001", goal: "迁移旧实验提问入口" });
    await waitFor(async () => (await first.get(projectId, "exp_001")).experiment.agent === "idle");
    await first.stopAll();

    const platformRoot = join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001", "workspace", ".ar");
    const helper = join(platformRoot, "question-server.mjs");
    const requests = join(platformRoot, "questions");
    const answers = join(platformRoot, "question-answers");
    await Promise.all([
      rm(helper, { force: true }),
      rm(requests, { recursive: true, force: true }),
      rm(answers, { recursive: true, force: true }),
    ]);

    resumed = await ctx.make();
    await resumed.recover([projectId]);
    assert.match(await readFile(helper, "utf8"), /request_user_input/);
    assert.equal(existsSync(requests), true);
    assert.equal(existsSync(answers), true);
    assert.equal((await resumed.get(projectId, "exp_001")).experiment.id, "exp_001");
  } finally {
    await first.stopAll();
    await resumed?.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("agent 提交的长任务等研究者批准后运行，结束后自动唤醒 agent", async () => {
  const ctx = setup({
    turns: [
      async (options) => {
        await options.onThread("thread-1");
        execFileSync(process.execPath, [".ar/run.mjs", "smoke", "--note", "测试", "--", "echo hello-from-job; exit 3"], { cwd: options.workingDirectory });
        return { finalResponse: "已提交后台任务" };
      },
      async () => ({ finalResponse: "看到了退出码 3" }),
    ],
  });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现", settings: { approveJobs: true } });
    const pending = await waitFor(async () => (await lab.get(projectId, "exp_001")).jobs.find((job) => job.status === "pending"));
    assert.equal(pending.name, "smoke");
    assert.equal(pending.note, "测试");
    await assert.rejects(lab.jobAction(projectId, "exp_001", pending.id, "stop"), /没有在运行/);
    await lab.jobAction(projectId, "exp_001", pending.id, "approve");
    await waitFor(() => ctx.calls.length === 2);
    const wake = ctx.calls[1];
    assert.match(wake.prompt, /\[平台通知\]/);
    assert.match(wake.prompt, /退出码 3/);
    assert.match(wake.prompt, /hello-from-job/);
    assert.equal(wake.options.threadId, "thread-1");
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const snapshot = await lab.get(projectId, "exp_001");
    assert.equal(snapshot.jobs[0].status, "failed");
    assert.equal(snapshot.jobs[0].exitCode, 3);
    assert.ok(snapshot.events.some((event) => event.type === "job" && event.jobId === pending.id));
    assert.match(await lab.readJobLog(projectId, "exp_001", pending.id), /hello-from-job/);
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("关闭确认时任务直接运行；研究者可以停止它，停止不会唤醒 agent", async () => {
  const ctx = setup({
    turns: [async (options) => {
      execFileSync(process.execPath, [".ar/run.mjs", "long", "--", longCommand], { cwd: options.workingDirectory });
      return { finalResponse: "提交了" };
    }],
  });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现", settings: { approveJobs: false } });
    const running = await waitFor(async () => (await lab.get(projectId, "exp_001")).jobs.find((job) => job.status === "running"));
    const statusFile = join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001", "jobs", `${running.id}.status.json`);
    const status = await waitFor(async () => existsSync(statusFile) && JSON.parse(await readFile(statusFile, "utf8")));
    await lab.jobAction(projectId, "exp_001", running.id, "stop");
    await waitFor(() => { try { process.kill(status.pid, 0); return false; } catch { return true; } });
    const snapshot = await lab.get(projectId, "exp_001");
    assert.equal(snapshot.jobs[0].status, "stopped");
    assert.match(snapshot.experiment.notices[0].text, /停止了后台任务/);
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(ctx.calls.length, 1);
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("无效的任务请求会被忽略，并让 agent 修正", async () => {
  const ctx = setup({
    turns: [
      async (options) => {
        await writeFile(join(options.workingDirectory, ".ar", "requests", "1.json"), JSON.stringify({ name: "bad name!", command: "x" }));
        return { finalResponse: "提交了" };
      },
      async () => ({ finalResponse: "我改一下" }),
    ],
  });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现" });
    await waitFor(() => ctx.calls.length === 2);
    assert.match(ctx.calls[1].prompt, /任务名字无效/);
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const snapshot = await lab.get(projectId, "exp_001");
    assert.equal(snapshot.jobs.length, 0);
    assert.ok(snapshot.events.some((event) => event.type === "system" && event.text.includes("忽略了一个后台任务请求")));
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("agent 工作时不能再发消息；停止后可以继续，未送达的设置变化随下一条消息发给 agent", async () => {
  let release;
  const ctx = setup({
    turns: [
      (options) => new Promise((_resolve, reject) => {
        release = () => reject(new Error("中断"));
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      }),
      async () => ({ finalResponse: "好的" }),
    ],
  });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现" });
    await waitFor(() => ctx.calls.length === 1);
    await assert.rejects(lab.send(projectId, "exp_001", "你好"), /正在工作/);
    await lab.stop(projectId, "exp_001");
    assert.ok(release);
    await lab.updateSettings(projectId, "exp_001", { network: false });
    await lab.send(projectId, "exp_001", "继续");
    await waitFor(() => ctx.calls.length === 2);
    assert.equal(ctx.calls[1].options.network, false);
    assert.match(ctx.calls[1].prompt, /允许联网：关/);
    assert.match(ctx.calls[1].prompt, /研究者：\n继续/);
    const snapshot = await lab.get(projectId, "exp_001");
    assert.ok(snapshot.events.some((event) => event.text === "已停止 agent 这一轮。"));
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("应用重启后，关闭期间结束的任务会被收尾并唤醒 agent", async () => {
  const ctx = setup({ turns: [async () => ({ finalResponse: "计划" })] });
  const first = await ctx.make();
  await first.create(projectId, { paperId: "paper_001", goal: "复现" });
  await waitFor(async () => (await first.get(projectId, "exp_001")).experiment.agent === "idle");
  await first.stopAll();
  const experimentRoot = join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001");
  const job = { id: "job_001", name: "train", command: "python train.py", cwd: ".", note: "", status: "running", requestedAt: new Date().toISOString(), startedAt: new Date(Date.now() - 60_000).toISOString(), log: ".ar/logs/job_001-train.log", exitCode: null, runnerPid: 999_999 };
  await writeFile(join(experimentRoot, "jobs", "job_001.json"), JSON.stringify(job));
  await writeFile(join(experimentRoot, "jobs", "job_001.status.json"), JSON.stringify({ state: "finished", exitCode: 0, finishedAt: new Date().toISOString() }));
  await writeFile(join(experimentRoot, "workspace", ".ar", "logs", "job_001-train.log"), "epoch 3 acc 61.9\n");
  const experiment = JSON.parse(await readFile(join(experimentRoot, "experiment.json"), "utf8"));
  await writeFile(join(experimentRoot, "experiment.json"), JSON.stringify({ ...experiment, agent: "working", conversations: experiment.conversations.map((item, index) => index ? item : { ...item, agent: "working" }) }));

  ctx.calls.length = 0;
  const second = await ctx.make();
  try {
    await second.recover([projectId]);
    await waitFor(() => ctx.calls.length === 1);
    assert.match(ctx.calls[0].prompt, /退出码 0/);
    assert.match(ctx.calls[0].prompt, /acc 61\.9/);
    const snapshot = await second.get(projectId, "exp_001");
    assert.equal(snapshot.jobs[0].status, "done");
    assert.ok(snapshot.events.some((event) => event.text?.includes("应用关闭时 agent 这一轮被中断")));
  } finally {
    await second.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("只能打开实验工作目录里的文件；文件列表跳过虚拟环境", async () => {
  const ctx = setup();
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const workspace = join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001", "workspace");
    await assert.rejects(lab.resolvePath(projectId, "exp_001", "../experiment.json"), /只能打开/);
    await assert.rejects(lab.resolvePath(projectId, "exp_001", "/etc/passwd"), /路径无效/);
    assert.equal(await lab.resolvePath(projectId, "exp_001", "REPRO.md"), await realpath(join(workspace, "REPRO.md")));
    await assert.rejects(lab.get(projectId, "../x"), /实验编号无效/);
    execFileSync(process.execPath, ["-e", "require('fs').mkdirSync('.venv/lib', { recursive: true })"], { cwd: workspace });
    const files = await lab.listFiles(projectId, "exp_001");
    const venv = files.find((node) => node.name === ".venv");
    assert.equal(venv.collapsed, true);
    assert.deepEqual(venv.children, []);
    assert.ok(files.find((node) => node.name === "paper").children.some((node) => node.name === "paper.md"));
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("连续自动唤醒八次后暂停，研究者消息重置计数且保留通知", async () => {
  const ctx = setup({ turns: Array.from({ length: 9 }, () => async (options) => {
    await writeFile(join(options.workingDirectory, ".ar", "requests", "invalid.json"), '{"name":"!","command":"x"}');
    return { finalResponse: "请求已提交" };
  }) });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现", settings: { continuous: false } });
    await waitFor(async () => {
      const snapshot = await lab.get(projectId, "exp_001");
      return ctx.calls.length === 9 && snapshot.events.some((event) => event.text?.includes("连续自动唤醒 agent 8 次"));
    });
    let snapshot = await lab.get(projectId, "exp_001");
    assert.equal(snapshot.experiment.autoWakes, 8);
    assert.equal(snapshot.experiment.notices.length, 1);
    await lab.send(projectId, "exp_001", "继续");
    await waitFor(async () => ctx.calls.length === 10 && (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    snapshot = await lab.get(projectId, "exp_001");
    assert.equal(snapshot.experiment.autoWakes, 0);
    assert.match(ctx.calls[9].prompt, /任务名字无效/);
    assert.match(ctx.calls[9].prompt, /重新读取 AGENTS\.md/);
  } finally { await lab.stopAll(); await rm(ctx.root(), { recursive: true, force: true }); }
});

test("每轮动态注入执行设置，尊重已有授权且不覆盖 AGENTS.md", async () => {
  assert.match(executionPolicy({ approveJobs: false, continuous: true }), /后台任务自动运行已开启/);
  assert.ok(executionPolicy({ approveJobs: true, continuous: false }).includes("直接通过 .ar/run.mjs 提交"));
  assert.match(wakePrompt({ notices: [], newThread: false }), /已经结束的任务结果/);
  assert.doesNotMatch(executionPolicy({}, { platform: "linux" }), /Get-Command rg|Get-CimInstance/);
  const ctx = setup({ platform: "win32" });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const entry = await lab.entry(projectId, "exp_001");
    assert.deepEqual(entry.experiment.settings, { network: true, approveJobs: false, continuous: true });
    assert.match(ctx.calls[0].prompt, /持续接续已开启/);
    assert.match(ctx.calls[0].prompt, /Get-Command rg/);
    assert.match(ctx.calls[0].prompt, /不要猜日志文件名/);
    await writeFile(join(entry.workspace, "AGENTS.md"), "# 我的实验规则\n保留自定义说明");
    await lab.updateSettings(projectId, "exp_001", { approveJobs: true, continuous: false });
    await lab.send(projectId, "exp_001", "继续");
    await waitFor(async () => ctx.calls.length === 2 && (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    assert.match(ctx.calls[1].prompt, /后台任务采用逐项确认/);
    assert.match(ctx.calls[1].prompt, /持续接续未开启/);
    assert.match(ctx.calls[1].prompt, /python -X utf8/);
    assert.equal(await readFile(join(entry.workspace, "AGENTS.md"), "utf8"), "# 我的实验规则\n保留自定义说明");
  } finally { await lab.stopAll(); await rm(ctx.root(), { recursive: true, force: true }); }
});

test("开启自动运行会启动待确认任务，之后提交不再逐项确认", async () => {
  const ctx = setup({ turns: [async (options) => {
    execFileSync(process.execPath, [".ar/run.mjs", "auto-toggle", "--", "echo auto-toggle-ok"], { cwd: options.workingDirectory });
    return { finalResponse: "已提交" };
  }, async (options, prompt) => {
    assert.match(prompt, /后台任务自动运行已开启/);
    execFileSync(process.execPath, [".ar/run.mjs", "auto-next", "--", "echo auto-next-ok"], { cwd: options.workingDirectory });
    return { finalResponse: "下一步已提交" };
  }] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现", settings: { approveJobs: true } });
    await waitFor(async () => { const state = await lab.get(projectId, "exp_001"); return state.experiment.agent === "idle" && state.jobs[0]?.status === "pending"; });
    await lab.updateSettings(projectId, "exp_001", { approveJobs: false });
    const snapshot = await waitFor(async () => {
      const state = await lab.get(projectId, "exp_001");
      return ctx.calls.length === 3 && state.experiment.agent === "idle" && state.jobs.length === 2 && state.jobs.every((job) => job.status === "done") && state;
    });
    assert.equal(snapshot.experiment.settings.approveJobs, false);
    assert.match(ctx.calls[2].prompt, /auto-next-ok/);
    assert.equal(snapshot.experiment.autoWakes, 2);
  } finally { await lab.stopAll(); await rm(ctx.root(), { recursive: true, force: true }); }
});

test("持续模式成功任务超过八轮仍接续，重启后保留设置和计数", async () => {
  const turns = Array.from({ length: 9 }, (_, index) => async (options) => {
    await options.onThread("thread-continuous");
    execFileSync(process.execPath, [".ar/run.mjs", `step-${index}`, "--", `echo step-${index}-ok`], { cwd: options.workingDirectory });
    return { finalResponse: "后台运行" };
  });
  const ctx = setup({ turns });
  const lab = await ctx.make();
  let resumed;
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "连续验证" });
    const snapshot = await waitFor(async () => {
      const state = await lab.get(projectId, "exp_001");
      return ctx.calls.length === 10 && state.experiment.agent === "idle" && state.jobs.length === 9 && state.jobs.every((job) => job.status === "done") && state;
    }, 25000);
    assert.equal(snapshot.experiment.autoWakes, 9);
    assert.equal(snapshot.experiment.autoWakeStalls, 0);
    assert.equal(ctx.calls[9].options.threadId, "thread-continuous");
    assert.ok(!snapshot.events.some((event) => event.text?.includes("先停在这里")));
    await lab.stopAll();
    resumed = await ctx.make();
    await resumed.recover([projectId]);
    const restored = await resumed.get(projectId, "exp_001");
    assert.equal(restored.experiment.settings.continuous, true);
    assert.equal(restored.experiment.settings.approveJobs, false);
    assert.equal(restored.experiment.autoWakes, 9);
    assert.equal(ctx.calls.length, 10);
  } finally { await lab.stopAll(); await resumed?.stopAll(); await rm(ctx.root(), { recursive: true, force: true }); }
});

test("自动模式把失败结果交回同一会话修正，成功后继续下一步", async () => {
  const ctx = setup({ turns: [async (options) => {
    await options.onThread("thread-retry");
    execFileSync(process.execPath, [".ar/run.mjs", "smoke-failed", "--", "echo failed-smoke; exit 1"], { cwd: options.workingDirectory });
    return { finalResponse: "已提交短测试" };
  }, async (options, prompt) => {
    assert.match(prompt, /退出码 1/);
    assert.match(prompt, /失败时在已授权范围内修正重试/);
    execFileSync(process.execPath, [".ar/run.mjs", "smoke-fixed", "--", "echo fixed-smoke"], { cwd: options.workingDirectory });
    return { finalResponse: "已修正" };
  }] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "修正同一短测试" });
    const snapshot = await waitFor(async () => {
      const state = await lab.get(projectId, "exp_001");
      return ctx.calls.length === 3 && state.experiment.agent === "idle" && state.jobs[1]?.status === "done" && state;
    });
    assert.equal(snapshot.jobs[0].status, "failed");
    assert.equal(snapshot.experiment.autoWakeStalls, 0);
    assert.equal(ctx.calls[2].options.threadId, "thread-retry");
    assert.match(ctx.calls[2].prompt, /fixed-smoke/);
  } finally { await lab.stopAll(); await rm(ctx.root(), { recursive: true, force: true }); }
});

test("旧实验保留审批与八次暂停，显式开启持续接续后处理保留的结果", async () => {
  const ctx = setup();
  const first = await ctx.make();
  let resumed;
  try {
    await first.create(projectId, { paperId: "paper_001", goal: "兼容旧实验", settings: { approveJobs: true, continuous: false } });
    await waitFor(async () => (await first.get(projectId, "exp_001")).experiment.agent === "idle");
    await first.stopAll();
    const path = join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001", "experiment.json");
    const experiment = JSON.parse(await readFile(path, "utf8"));
    delete experiment.settings.continuous;
    delete experiment.autoWakeStalls;
    experiment.autoWakes = 8;
    experiment.notices.push({ text: "保留的任务结果", wake: true });
    experiment.conversations[0].autoWakes = 8;
    experiment.conversations[0].notices = experiment.notices;
    await writeFile(path, JSON.stringify(experiment));
    resumed = await ctx.make();
    await resumed.recover([projectId]);
    assert.equal(ctx.calls.length, 1);
    const before = await resumed.get(projectId, "exp_001");
    assert.equal(before.experiment.settings.approveJobs, true);
    assert.equal(before.experiment.settings.continuous, undefined);
    await resumed.updateSettings(projectId, "exp_001", { continuous: true });
    await waitFor(async () => ctx.calls.length === 2 && (await resumed.get(projectId, "exp_001")).experiment.agent === "idle");
    assert.match(ctx.calls[1].prompt, /保留的任务结果/);
    assert.match(ctx.calls[1].prompt, /持续接续已开启/);
    assert.equal((await resumed.get(projectId, "exp_001")).experiment.settings.approveJobs, true);
  } finally { await first.stopAll(); await resumed?.stopAll(); await rm(ctx.root(), { recursive: true, force: true }); }
});

test("持续模式连续无效请求暂停，消息重置计数；重投成功通知不会无限重试", async () => {
  const ctx = setup({ turns: Array.from({ length: 9 }, () => async (options) => {
    await writeFile(join(options.workingDirectory, ".ar", "requests", "invalid.json"), '{"name":"!","command":"x"}');
    return { finalResponse: "已提交" };
  }) });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "防止无效循环" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).events.some((event) => event.text?.includes("连续 8 次接续没有成功")));
    const entry = await lab.entry(projectId, "exp_001");
    assert.equal(entry.experiment.autoWakeStalls, 8);
    assert.equal(ctx.calls.length, 9);
    assert.equal(entry.experiment.notices.filter((notice) => notice.wake).length, 1);
    await lab.send(projectId, "exp_001", "继续");
    await waitFor(async () => ctx.calls.length === 10 && (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    assert.equal(entry.experiment.autoWakeStalls, 0);
  } finally { await lab.stopAll(); await rm(ctx.root(), { recursive: true, force: true }); }

  const failures = setup({ turns: [async () => ({}), ...Array.from({ length: 9 }, () => async () => { throw new Error("temporary agent failure"); })] });
  const failingLab = await failures.make();
  try {
    await failingLab.create(projectId, { paperId: "paper_001", goal: "防止重复结果无限重试" });
    await waitFor(async () => (await failingLab.get(projectId, "exp_001")).experiment.agent === "idle");
    const entry = await failingLab.entry(projectId, "exp_001");
    entry.experiment.notices.push({ text: "成功结果", wake: true, progress: true });
    failingLab.maybeWake(entry);
    await waitFor(async () => (await failingLab.get(projectId, "exp_001")).events.some((event) => event.text?.includes("连续 8 次接续没有成功")));
    assert.equal(failures.calls.length, 10);
    assert.equal(entry.experiment.notices[0].progress, false);
  } finally { await failingLab.stopAll(); await rm(failures.root(), { recursive: true, force: true }); }
});

test("等待回答和手动停止期间，自动模式不启动待运行任务或自动续接", async () => {
  const ctx = setup();
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "尊重暂停", settings: { approveJobs: true } });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const entry = await lab.entry(projectId, "exp_001");
    await lab.serial(entry, () => lab.createJob(entry, { name: "paused", command: "echo resumed-ok" }));
    entry.experiment.conversations[0].pendingQuestion = { requestId: randomUUID(), questions: [] };
    await lab.updateSettings(projectId, "exp_001", { approveJobs: false });
    assert.equal([...entry.jobs.values()][0].status, "pending");
    entry.experiment.conversations[0].notices.push({ text: "前序任务已完成", wake: true, progress: true });
    lab.maybeWake(entry);
    assert.equal(ctx.calls.length, 1);
    await lab.stop(projectId, "exp_001");
    await lab.updateSettings(projectId, "exp_001", { approveJobs: true });
    await lab.updateSettings(projectId, "exp_001", { approveJobs: false });
    assert.equal([...entry.jobs.values()][0].status, "pending");
    assert.equal(ctx.calls.length, 1);
    await lab.send(projectId, "exp_001", "继续");
    await waitFor(async () => { const state = await lab.get(projectId, "exp_001"); return state.jobs[0].status === "done" && state.experiment.agent === "idle"; });
    assert.ok(ctx.calls.length >= 2);
  } finally { await lab.stopAll(); await rm(ctx.root(), { recursive: true, force: true }); }
});

test("Electron Node 后台任务在服务关闭后继续运行，重启后回传同一会话", async () => {
  const nodePath = process.platform === "win32" ? createRequire(import.meta.url)("electron") : process.execPath;
  const command = process.platform === "win32" ? "Start-Sleep -Milliseconds 1200; Write-Output '关闭后完成'; exit 0" : "sleep 1; echo '关闭后完成'";
  let submitted = false;
  const ctx = setup({ nodePath, turns: [async (options) => {
    if (submitted) return { finalResponse: "已读取任务结果" };
    submitted = true;
    await options.onThread("thread-persisted");
    execFileSync(process.execPath, [".ar/run.mjs", "survive", "--", command], { cwd: options.workingDirectory });
    return { finalResponse: "后台运行" };
  }] });
  const first = await ctx.make();
  let second;
  try {
    await first.create(projectId, { paperId: "paper_001", goal: "复现", settings: { approveJobs: false } });
    const job = await waitFor(async () => (await first.get(projectId, "exp_001")).jobs.find((item) => item.status === "running"));
    const statusPath = join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001", "jobs", `${job.id}.status.json`);
    await waitFor(async () => existsSync(statusPath) && JSON.parse(await readFile(statusPath, "utf8")).state === "running");
    await first.stopAll();
    await waitFor(async () => JSON.parse(await readFile(statusPath, "utf8")).state === "finished");
    const finished = JSON.parse(await readFile(statusPath, "utf8"));
    await waitFor(() => { try { process.kill(finished.runnerPid, 0); return false; } catch { return true; } });
    ctx.calls.length = 0;
    second = await ctx.make();
    await second.recover([projectId]);
    await waitFor(async () => ctx.calls.length === 1 && (await second.get(projectId, "exp_001")).experiment.agent === "idle");
    assert.equal(ctx.calls[0].options.threadId, "thread-persisted");
    assert.match(ctx.calls[0].prompt, /退出码 0/);
    assert.match(ctx.calls[0].prompt, /关闭后完成/);
    assert.equal((await second.get(projectId, "exp_001")).jobs[0].status, "done");
  } finally {
    await first.stopAll();
    await second?.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("任务工作目录的符号链接或 Windows junction 不能越过实验目录", async () => {
  const ctx = setup();
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const entry = await lab.entry(projectId, "exp_001");
    const outside = join(ctx.root(), "outside");
    await mkdir(outside);
    await symlink(outside, join(entry.workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    assert.match(await lab.validateRequest(entry, { name: "escape", command: "echo x", cwd: "escape" }), /不在实验目录内/);
    await assert.rejects(lab.resolvePath(projectId, "exp_001", "escape"), /只能打开/);
  } finally { await lab.stopAll(); await rm(ctx.root(), { recursive: true, force: true }); }
});

test("失败的 agent 回合不会丢失尚未送达的设置通知", async () => {
  const ctx = setup({ turns: [async () => ({ finalResponse: "完成" }), async () => { throw new Error("connection reset"); }] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    await lab.updateSettings(projectId, "exp_001", { network: false });
    await lab.send(projectId, "exp_001", "继续");
    await waitFor(async () => ctx.calls.length === 2 && (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    assert.match((await lab.get(projectId, "exp_001")).experiment.notices[0].text, /允许联网：关/);
    await lab.send(projectId, "exp_001", "重试");
    await waitFor(async () => ctx.calls.length === 3 && (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    assert.match(ctx.calls[2].prompt, /允许联网：关/);
  } finally { await lab.stopAll(); await rm(ctx.root(), { recursive: true, force: true }); }
});

test("Windows 后台任务把 PowerShell 错误记录为失败", { skip: process.platform !== "win32" }, async () => {
  const ctx = setup({ turns: [async (options) => {
    execFileSync(process.execPath, [".ar/run.mjs", "ps-error", "--", "Get-Item -LiteralPath 'missing-experiment-input-827166'"], { cwd: options.workingDirectory });
    return { finalResponse: "提交" };
  }] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现", settings: { approveJobs: false } });
    const job = await waitFor(async () => (await lab.get(projectId, "exp_001")).jobs.find((item) => item.status === "failed"));
    assert.equal(job.exitCode, 1);
    assert.match(await lab.readJobLog(projectId, "exp_001", job.id), /missing-experiment-input-827166/);
  } finally { await lab.stopAll(); await rm(ctx.root(), { recursive: true, force: true }); }
});

test("日志最后一行：去掉颜色码，进度条只取最后一次刷新，跳过结束标记", () => {
  assert.equal(lastLogLine("Epoch 1\n\r 10%|█   \r 47%|████\n"), "47%|████");
  assert.equal(lastLogLine("\u001b[32mloss 0.31\u001b[0m\n\n"), "loss 0.31");
  assert.equal(lastLogLine("acc 0.9\n\n[AutoResearch 2026-01-01T00:00:00.000Z] 结束：退出码 0\n"), "acc 0.9");
  assert.equal(lastLogLine(""), "");
});

const progressCommand = `node -e "process.stdout.write('step 1\\nprogress 10%\\rprogress 90%\\n')"`;

test("手动运行的命令直接执行、可增量读日志；默认不唤醒 agent，勾选后才唤醒", async () => {
  const ctx = setup({ turns: [async (options) => { await options.onThread("thread-1"); return { finalResponse: "计划" }; }, async () => ({ finalResponse: "看到了手动命令" })] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    await assert.rejects(lab.runCommand(projectId, "exp_001", { command: "  " }), /命令为空/);
    await assert.rejects(lab.runCommand(projectId, "exp_001", { command: "echo x", cwd: "../.." }), /不在实验目录内/);

    const job = await lab.runCommand(projectId, "exp_001", { command: progressCommand });
    assert.equal(job.origin, "user");
    assert.equal(job.status, "running", "手动命令不需要确认");
    const done = await waitFor(async () => (await lab.get(projectId, "exp_001")).jobs.find((item) => item.id === job.id && item.status !== "running"));
    assert.equal(done.status, "done");
    assert.equal(done.lastLine, "progress 90%");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(ctx.calls.length, 1, "默认不唤醒 agent");
    const snapshot = await lab.get(projectId, "exp_001");
    assert.ok(snapshot.experiment.notices.some((notice) => notice.wake === false && /研究者手动运行的命令/.test(notice.text)), "结果留给下一条消息");

    const first = await lab.readJobLogChunk(projectId, "exp_001", job.id);
    const text = Buffer.from(first.bytes).toString("utf8");
    assert.match(text, /step 1\r?\nprogress 10%\rprogress 90%/);
    assert.equal(first.from, 0);
    assert.equal(first.next, first.size);
    assert.equal(first.skipped, 0);
    const again = await lab.readJobLogChunk(projectId, "exp_001", job.id, first.next);
    assert.equal(again.bytes.length, 0);
    const truncated = await lab.readJobLogChunk(projectId, "exp_001", job.id, first.size + 100);
    assert.equal(truncated.reset, true, "日志变短时从头重读");
    const middle = await lab.readJobLogChunk(projectId, "exp_001", job.id, 5);
    assert.equal(middle.from, 5);
    assert.equal(Buffer.from(middle.bytes).toString("utf8"), text.slice(5));

    const notified = await lab.runCommand(projectId, "exp_001", { command: progressCommand, notify: true });
    await waitFor(() => ctx.calls.length === 2);
    assert.match(ctx.calls[1].prompt, new RegExp(`研究者手动运行的命令（${notified.id}）`));
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("只能清理已结束后台任务的日志文件，并保留任务记录", async () => {
  const ctx = setup();
  const lab = await ctx.make();
  let reopened;
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const entry = await lab.entry(projectId, "exp_001");
    const doneJob = {
      id: "job_001", name: "old-eval", command: "python eval.py", cwd: ".", note: "", status: "done",
      requestedAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      exitCode: 0, log: ".ar/logs/job_001-old-eval.log",
    };
    const runningJob = {
      ...doneJob, id: "job_002", name: "active-run", status: "running", finishedAt: undefined,
      exitCode: null, log: ".ar/logs/job_002-active-run.log",
    };
    entry.jobs.set(doneJob.id, doneJob);
    entry.jobs.set(runningJob.id, runningJob);
    await writeFile(join(entry.root, "jobs", `${doneJob.id}.json`), JSON.stringify(doneJob));
    await writeFile(join(entry.root, "jobs", `${runningJob.id}.json`), JSON.stringify(runningJob));
    const doneLog = join(entry.workspace, ...doneJob.log.split("/"));
    const runningLog = join(entry.workspace, ...runningJob.log.split("/"));
    await writeFile(doneLog, "old result output\n");
    await writeFile(runningLog, "still running\n");

    await assert.rejects(lab.clearJobLogs(projectId, "exp_001", [runningJob.id]), /只能清理已经结束/);
    assert.equal(existsSync(runningLog), true, "运行中的日志不能删除");

    const [cleared] = await lab.clearJobLogs(projectId, "exp_001", [doneJob.id]);
    assert.equal(cleared.outputDeleted, true);
    assert.equal(existsSync(doneLog), false);
    const snapshot = await lab.get(projectId, "exp_001");
    assert.equal(snapshot.jobs.find((job) => job.id === doneJob.id).status, "done");
    assert.equal(snapshot.jobs.find((job) => job.id === doneJob.id).outputDeleted, true);
    assert.ok(snapshot.jobs.find((job) => job.id === doneJob.id).startedAt, "预算相关的开始时间仍保留");
    assert.equal(entry.jobs.has(doneJob.id), true, "预算与任务历史仍可使用该记录");

    await lab.stopAll();
    reopened = await ctx.make();
    const restored = await reopened.get(projectId, "exp_001");
    assert.equal(restored.jobs.find((job) => job.id === doneJob.id).outputDeleted, true, "清理状态重启后保留");
  } finally {
    await lab.stopAll();
    await reopened?.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("日志目录已被手动删除时仍可清理终端任务标签", async () => {
  const ctx = setup();
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "清理缺失的日志目录" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const entry = await lab.entry(projectId, "exp_001");
    const job = {
      id: "job_001", name: "removed-output", command: "python eval.py", cwd: ".", note: "", status: "done",
      requestedAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      exitCode: 0, log: ".ar/logs/job_001-removed-output.log",
    };
    entry.jobs.set(job.id, job);
    await writeFile(join(entry.root, "jobs", `${job.id}.json`), JSON.stringify(job));
    await rm(join(entry.workspace, ".ar", "logs"), { recursive: true, force: true });
    const eventCount = (await lab.get(projectId, "exp_001")).events.length;

    const [cleared] = await lab.clearJobLogs(projectId, "exp_001", [job.id]);
    assert.equal(cleared.outputDeleted, true);
    assert.equal((await lab.get(projectId, "exp_001")).events.length, eventCount, "清理不改动聊天和实验事件");
    assert.equal((await lab.get(projectId, "exp_001")).jobs[0].status, "done", "任务摘要仍保留");
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("agent 正在执行的短命令实时推给界面，结束后清空", async () => {
  let during = null;
  const ctx = setup({ turns: [async (options) => {
    await options.onEvent({ type: "item.started", item: { id: "cmd_1", type: "command_execution", command: "pip install -r requirements.txt", aggregated_output: "" } });
    await options.onEvent({ type: "item.updated", item: { id: "cmd_1", type: "command_execution", command: "pip install -r requirements.txt", aggregated_output: "Collecting torch\n" } });
    during = await options.peek();
    await new Promise((resolve) => setTimeout(resolve, 500)); // 推送最多每 400 毫秒一次
    await options.onEvent({ type: "item.completed", item: { id: "cmd_1", type: "command_execution", command: "pip install -r requirements.txt", exit_code: 0, status: "completed", aggregated_output: "Collecting torch\nSuccessfully installed torch\n" } });
    return { finalResponse: "装好了" };
  }] });
  const lab = await ctx.make();
  try {
    const runAgent = lab.runAgent;
    lab.runAgent = (prompt, options) => runAgent(prompt, { ...options, peek: () => lab.get(projectId, "exp_001") });
    await lab.create(projectId, { paperId: "paper_001", goal: "复现" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    assert.equal(during.live.command, "pip install -r requirements.txt");
    assert.match(during.live.output, /Collecting torch/);
    const snapshot = await lab.get(projectId, "exp_001");
    assert.equal(snapshot.live, null);
    assert.ok(ctx.updates.some((update) => update.live?.output?.includes("Collecting torch")));
    assert.ok(ctx.updates.some((update) => update.live === null));
    assert.ok(snapshot.events.some((event) => event.type === "command" && /Successfully installed/.test(event.output)));
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("agent 不能把请求伪装成手动命令来绕过任务确认", async () => {
  const ctx = setup({ turns: [async (options) => {
    await writeFile(join(options.workingDirectory, ".ar", "requests", "forged-manual.json"), JSON.stringify({
      name: "forged-manual", command: "echo should-require-approval", cwd: ".", origin: "user", notify: false,
    }));
    return { finalResponse: "提交了任务" };
  }] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "校验审批来源", settings: { approveJobs: true } });
    const snapshot = await waitFor(async () => {
      const state = await lab.get(projectId, "exp_001");
      return state.experiment.agent === "idle" && state.jobs.length === 1 && state;
    });
    assert.equal(snapshot.jobs[0].status, "pending");
    assert.equal(snapshot.jobs[0].origin, undefined);
    assert.equal(snapshot.jobs[0].runnerPid, undefined);
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("agent 命令未发结束事件就报错时，仍清空终端实时状态", async () => {
  const ctx = setup({ turns: [async (options) => {
    await options.onEvent({ type: "item.started", item: { id: "interrupted", type: "command_execution", command: "echo partial", aggregated_output: "partial" } });
    await options.onEvent({ type: "item.updated", item: { id: "interrupted", type: "command_execution", command: "echo partial", aggregated_output: "partial output" } });
    throw new Error("测试中断");
  }] });
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "校验终端状态清理" });
    const state = await waitFor(async () => {
      const snapshot = await lab.get(projectId, "exp_001");
      return snapshot.experiment.agent === "idle" && snapshot;
    });
    assert.equal(state.live, null);
    assert.match(state.experiment.error, /测试中断/);
    const entry = await lab.entry(projectId, "exp_001");
    assert.equal(entry.liveTimer, null);
    assert.ok(ctx.updates.some((update) => update.live === null));
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("大日志首次只取末尾 512KB，截断后从头重读并在文件删除时重置", async () => {
  const ctx = setup();
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "校验大日志" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const entry = await lab.entry(projectId, "exp_001");
    const job = { id: "job_001", name: "chunk-check", status: "done", log: ".ar/logs/chunk-check.log" };
    entry.jobs.set(job.id, job);
    const path = join(entry.workspace, ".ar", "logs", "chunk-check.log");
    const original = Buffer.alloc(2 * 1024 * 1024, 65);
    await writeFile(path, original);
    const initial = await lab.readJobLogChunk(projectId, "exp_001", job.id);
    assert.equal(initial.bytes.length, 512 * 1024);
    assert.equal(initial.from, original.length - initial.bytes.length);
    assert.equal(initial.skipped, initial.from);
    assert.equal(initial.next, original.length);
    assert.equal(initial.reset, false);
    const shorter = Buffer.alloc(700 * 1024, 66);
    await writeFile(path, shorter);
    const truncated = await lab.readJobLogChunk(projectId, "exp_001", job.id, initial.next);
    assert.equal(truncated.from, 0);
    assert.equal(truncated.reset, true);
    assert.deepEqual(Buffer.from(truncated.bytes), shorter);
    await rm(path);
    const removed = await lab.readJobLogChunk(projectId, "exp_001", job.id, truncated.next);
    assert.equal(removed.reset, true);
    assert.equal(removed.next, 0);
    assert.equal(removed.bytes.length, 0);
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});

test("在实验工作目录打开系统 PowerShell 窗口，不能打开到实验目录外", async () => {
  const ctx = setup();
  const lab = await ctx.make();
  try {
    await lab.create(projectId, { paperId: "paper_001", goal: "复现" });
    await waitFor(async () => (await lab.get(projectId, "exp_001")).experiment.agent === "idle");
    const spawned = [];
    lab.platform = "win32";
    lab.spawn = (file, args, options) => {
      spawned.push({ file, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit("spawn"));
      return child;
    };
    assert.equal(await lab.openTerminal(projectId, "exp_001"), true);
    assert.equal(spawned[0].file, "powershell.exe");
    assert.deepEqual(spawned[0].args, ["-NoExit", "-NoLogo"]);
    assert.equal(await realpath(spawned[0].options.cwd), await realpath(join(ctx.root(), "project", "Experiments", "PaperReproductions", "exp_001", "workspace")));
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].options.windowsHide, false);
    await assert.rejects(lab.openTerminal(projectId, "exp_001", "../.."));
    lab.spawn = () => { const child = new EventEmitter(); process.nextTick(() => child.emit("error", new Error("ENOENT"))); return child; };
    await assert.rejects(lab.openTerminal(projectId, "exp_001"), /打不开终端/);
  } finally {
    await lab.stopAll();
    await rm(ctx.root(), { recursive: true, force: true });
  }
});
