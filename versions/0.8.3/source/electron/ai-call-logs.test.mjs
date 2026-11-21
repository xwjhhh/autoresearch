import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interruptRunningAiCallLogs, interruptRunningAiCallLogsInProject, readAiCallLog, writeAiCallLog } from "./ai-call-logs.mjs";

test("writes and reads an AI call log under the project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-call-log-"));
  const callId = "c6b867bd-c423-4e60-9398-7c24bd392a88";
  const record = { id: callId, paperId: "paper_001", status: "complete", request: { systemPrompt: "Read" }, rawResponse: "{}" };
  try {
    await writeAiCallLog(root, "paper_001", callId, { ...record, status: "running", rawResponse: "" });
    await writeAiCallLog(root, "paper_001", callId, record);
    assert.deepEqual(await readAiCallLog(root, "paper_001", callId), record);
    assert.deepEqual(JSON.parse(await readFile(join(root, "ai-call-logs", "paper_001", `${callId}.json`), "utf8")), record);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe paper and call identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-call-log-"));
  try {
    await assert.rejects(readAiCallLog(root, "../outside", "c6b867bd-c423-4e60-9398-7c24bd392a88"), /调用日志归属编号无效/);
    await assert.rejects(readAiCallLog(root, "paper_001", "..\\outside"), /调用日志编号无效/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supports project and idea scopes and interrupts every in-flight scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-call-log-"));
  const projectCallId = "c6b867bd-c423-4e60-9398-7c24bd392a88";
  const ideaCallId = "d7c978ce-d534-4f71-8409-8d35ce403b99";
  try {
    await writeAiCallLog(root, "project", projectCallId, { id: projectCallId, scopeId: "project", status: "running", request: { messages: [] }, rawResponse: "" });
    await writeAiCallLog(root, "idea_001", ideaCallId, { id: ideaCallId, scopeId: "idea_001", status: "running", request: { messages: [] }, rawResponse: "" });
    const interrupted = await interruptRunningAiCallLogsInProject(root, "应用关闭时 AI 调用中断。", "2026-10-23T12:00:00.000Z");
    assert.equal(interrupted.length, 2);
    assert.equal((await readAiCallLog(root, "project", projectCallId)).status, "failed");
    assert.equal((await readAiCallLog(root, "idea_001", ideaCallId)).status, "failed");
    assert.deepEqual(await interruptRunningAiCallLogsInProject(root, "new error", "later"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks in-flight logs interrupted after app recovery while keeping completed calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-call-log-"));
  const callId = "c6b867bd-c423-4e60-9398-7c24bd392a88";
  const started = { id: callId, paperId: "paper_001", status: "running", request: { messages: [] }, rawResponse: "" };
  try {
    await writeAiCallLog(root, "paper_001", callId, started);
    const interrupted = await interruptRunningAiCallLogs(root, "paper_001", "应用关闭时分析中断。", "2026-10-23T12:00:00.000Z");
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].status, "failed");
    assert.equal(interrupted[0].error, "应用关闭时分析中断。");
    assert.equal((await readAiCallLog(root, "paper_001", callId)).finishedAt, "2026-10-23T12:00:00.000Z");
    assert.deepEqual(await interruptRunningAiCallLogs(root, "paper_001", "new error", "later"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
