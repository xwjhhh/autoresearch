import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { QuestionChannel, formatQuestionAnswers, normalizeQuestionRequest, validateQuestionAnswers } from "./agent-questions.mjs";

async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error("等待超时");
    await new Promise((done) => setTimeout(done, 25));
  }
}

const sample = {
  requestId: "11111111-1111-4111-8111-111111111111",
  questions: [
    { id: "scope", header: "写入位置", question: "可以把整理好的表格写到课题的 Notes 目录吗？", options: [{ label: "可以" }, { label: "只写在本论文目录" }] },
    { id: "name", question: "文件名用什么？", options: [], isOther: true },
  ],
};

test("问题必须有选项或允许自由回答，回答必须覆盖每个问题", () => {
  const request = normalizeQuestionRequest(sample, sample.requestId);
  assert.equal(request.questions[1].header, "问题 2");
  assert.equal(normalizeQuestionRequest({ ...sample, questions: [{ id: "x", question: "没有选项" }] }, sample.requestId), null);
  assert.equal(normalizeQuestionRequest(sample, "another-id"), null);
  assert.throws(() => validateQuestionAnswers(request, { scope: "随便" }), /写入位置/);
  assert.throws(() => validateQuestionAnswers(request, { scope: "可以" }), /问题 2/);
  const answers = validateQuestionAnswers(request, { scope: "可以", name: "compare.md" });
  assert.match(formatQuestionAnswers(request, answers), /写入位置：[\s\S]*研究者选择：可以[\s\S]*compare\.md/);
});

test("Codex 通过提问工具发问，界面回答后工具把答案交回 Codex", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-questions-"));
  let changes = 0;
  const channel = new QuestionChannel({ root, onChange: () => { changes += 1; }, pollMs: 20 });
  try {
    await writeFile(join(root, "stale.txt"), "x");
    const server = await channel.prepare({ serverSource: await readFile(new URL("./experiments/question-server.mjs", import.meta.url), "utf8"), nodePath: process.execPath, runAsNode: false });
    assert.deepEqual(server.args, [join(root, "question-server.mjs")]);
    channel.start();

    // 像 Codex 一样通过 stdio 调用 MCP 工具。
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
    const replies = new Map();
    createInterface({ input: child.stdout }).on("line", (line) => { const message = JSON.parse(line); replies.set(message.id, message); });
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: {} });
    await waitFor(() => replies.get(1));
    send({ id: 2, method: "tools/call", params: { name: "request_user_input", arguments: { questions: sample.questions } } });

    const pending = await waitFor(() => channel.pending);
    assert.equal(pending.questions.length, 2);
    assert.equal(changes, 1);
    await assert.rejects(channel.answer("wrong-id", {}), /已失效/);
    const { text } = await channel.answer(pending.requestId, { scope: "只写在本论文目录", name: "notes.md" });
    assert.match(text, /只写在本论文目录/);
    assert.equal(channel.pending, null);

    const reply = await waitFor(() => replies.get(2));
    assert.match(reply.result.content[0].text, /回答：只写在本论文目录/);
    assert.deepEqual(reply.result.structuredContent.answers.map((item) => item.answer), ["只写在本论文目录", "notes.md"]);
    child.stdin.end();
    child.kill();
  } finally {
    await channel.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("取消问题会让提问工具返回错误，而不是一直等下去", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-questions-"));
  const channel = new QuestionChannel({ root, pollMs: 20 });
  try {
    const server = await channel.prepare({ serverSource: await readFile(new URL("./experiments/question-server.mjs", import.meta.url), "utf8"), nodePath: process.execPath, runAsNode: false });
    channel.start();
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
    const replies = new Map();
    createInterface({ input: child.stdout }).on("line", (line) => { const message = JSON.parse(line); replies.set(message.id, message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "request_user_input", arguments: { questions: sample.questions.slice(0, 1) } } })}\n`);
    await waitFor(() => channel.pending);
    await channel.cancel("研究者停止了这一轮。");
    const reply = await waitFor(() => replies.get(7));
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /停止了这一轮/);
    child.stdin.end();
    child.kill();
    await channel.cleanup();
    assert.deepEqual(await readdir(join(root, "questions")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
