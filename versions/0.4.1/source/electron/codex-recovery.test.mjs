import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexSdk } from "./codex-sdk.mjs";
import { CODEX_CONTINUATION_PROMPT, codexRecoveryDelay, isTransientCodexFailure } from "./codex-recovery.mjs";

test("agent recovery only classifies temporary provider and transport failures", () => {
  for (const message of ["Reconnecting... 1/5 (stream disconnected before completion: Concurrency limit exceeded for user, please retry later)", "429 Too Many Requests", "connection reset", "fetch failed", "Codex 回复流在完成前中断。", "503 Service unavailable"]) {
    assert.equal(isTransientCodexFailure(new Error(message)), true, message);
  }
  for (const message of ["invalid api key", "insufficient_quota", "MCP tool call requires approval, but approval policy is never", "helper_unknown_error: setup refresh had errors", "Access denied (os error 5)", "thread-store conflict", "command exited with code 1", "failed to write metadata"]) {
    assert.equal(isTransientCodexFailure(new Error(message)), false, message);
  }
  assert.equal(isTransientCodexFailure(Object.assign(new Error("Concurrency limit exceeded"), { permanent: true })), false);
  assert.equal(isTransientCodexFailure(Object.assign(new Error("rate limit"), { status: 401 })), false);
  assert.equal(codexRecoveryDelay(1, () => 0.5), 15_000);
  assert.equal(codexRecoveryDelay(2, () => 0.5), 30_000);
  assert.equal(codexRecoveryDelay(5, () => 0.5), 60_000);
});

async function scenario(run, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "autoresearch-recovery-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "codex.exe"), "test stub");
  const calls = [], resumed = [], retries = [], waits = [], savedIds = [];
  let starts = 0;
  const makeThread = () => ({
    id: "preserved-thread",
    runStreamed: async (prompt) => {
      calls.push(prompt);
      return { events: run(calls.length) };
    },
  });
  try {
    let response, error;
    try {
      response = await runCodexSdk("Submit the experiment once", {
        env: { PATH: join(root, "bin"), USERPROFILE: root }, workingDirectory: root,
        sandboxMode: "workspace-write", maxAttempts: 1, maxRecoveryAttempts: 3,
        onRetry: (event) => retries.push(event),
        onThread: (id) => savedIds.push(id),
        wait: async (ms) => waits.push(ms),
        sdkFactory: () => ({
          startThread: () => { starts += 1; return makeThread(); },
          resumeThread: (id) => { resumed.push(id); return makeThread(); },
        }),
        ...options,
      });
    } catch (caught) { error = caught; }
    return { response, error, calls, resumed, retries, waits, savedIds, starts };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("transient failure resumes same thread after completed tools without replaying the task", async () => {
  let submissions = 0;
  const result = await scenario(async function* (attempt) {
    yield { type: "thread.started", thread_id: "preserved-thread" };
    yield { type: "turn.started" };
    if (attempt === 1) {
      submissions += 1;
      yield { type: "item.started", item: { type: "command_execution", id: "submit" } };
      yield { type: "item.completed", item: { type: "command_execution", id: "submit", exit_code: 0 } };
      yield { type: "turn.failed", error: { message: "Concurrency limit exceeded for user, please retry later" } };
      return;
    }
    yield { type: "item.completed", item: { type: "agent_message", text: "恢复成功；后台任务无需重投。" } };
    yield { type: "turn.completed" };
  });
  assert.equal(result.error, undefined);
  assert.equal(result.response.finalResponse, "恢复成功；后台任务无需重投。");
  assert.equal(submissions, 1);
  assert.equal(result.starts, 1);
  assert.deepEqual(result.resumed, ["preserved-thread"]);
  assert.deepEqual(result.calls, ["Submit the experiment once", CODEX_CONTINUATION_PROMPT]);
  assert.deepEqual(result.retries.map((event) => event.phase), ["waiting", "resuming"]);
  assert.ok(result.waits[0] >= 12_000 && result.waits[0] <= 18_000);
  assert.ok(result.savedIds.every((id) => id === "preserved-thread"));
});

test("limit failures stop at the configured budget and retain the session", async () => {
  const result = await scenario(async function* () {
    yield { type: "thread.started", thread_id: "preserved-thread" };
    yield { type: "turn.started" };
    throw new Error("stream disconnected: Concurrency limit exceeded for user");
  }, { maxRecoveryAttempts: 2 });
  assert.match(result.error.message, /自动恢复未成功/);
  assert.equal(result.calls.length, 3);
  assert.equal(result.waits.length, 2);
  assert.equal(result.starts, 1);
});

test("CLI reconnect progress does not kill the running CLI or submit a new turn", async () => {
  const result = await scenario(async function* () {
    yield { type: "thread.started", thread_id: "preserved-thread" };
    yield { type: "turn.started" };
    yield { type: "error", message: "Reconnecting... 1/5 (stream disconnected before completion: Concurrency limit exceeded for user, please retry later)" };
    yield { type: "item.completed", item: { type: "agent_message", text: "同一回合恢复完成" } };
    yield { type: "turn.completed" };
  });
  assert.equal(result.error, undefined);
  assert.equal(result.response.finalResponse, "同一回合恢复完成");
  assert.equal(result.calls.length, 1);
  assert.equal(result.waits.length, 0);
  assert.deepEqual(result.resumed, []);
  assert.deepEqual(result.retries.map((event) => event.phase), ["reconnecting"]);
});

test("an exhausted CLI reconnect stream falls back to bounded same-thread recovery", async () => {
  const result = await scenario(async function* (attempt) {
    yield { type: "thread.started", thread_id: "preserved-thread" };
    yield { type: "turn.started" };
    if (attempt === 1) {
      yield { type: "error", message: "Reconnecting... 5/5 (Concurrency limit exceeded for user)" };
      return;
    }
    yield { type: "item.completed", item: { type: "agent_message", text: "续接完成" } };
    yield { type: "turn.completed" };
  });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.resumed, ["preserved-thread"]);
  assert.equal(result.calls[1], CODEX_CONTINUATION_PROMPT);
});

test("unfinished tool, local runner, authentication and approval failures are not resumed", async () => {
  for (const failure of ["active tool", "helper_unknown_error: setup refresh had errors", "invalid api key", "MCP tool call requires approval, but approval policy is never"]) {
    const result = await scenario(async function* () {
      yield { type: "turn.started" };
      if (failure === "active tool") yield { type: "item.started", item: { type: "mcp_tool_call", id: "possibly-running" } };
      throw new Error(failure === "active tool" ? "stream disconnected" : failure);
    });
    assert.ok(result.error, failure);
    assert.equal(result.calls.length, 1, failure);
    assert.equal(result.waits.length, 0, failure);
  }
});

test("a researcher stop during backoff prevents any new turn", async () => {
  const controller = new AbortController();
  const stopped = new Error("研究者停止");
  const result = await scenario(async function* () { throw new Error("Concurrency limit exceeded for user"); }, {
    signal: controller.signal,
    wait: async () => controller.abort(stopped),
  });
  assert.equal(result.error, stopped);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.resumed, []);
});

test("recovery remains opt-in and never extends the turn deadline", async () => {
  const noRecovery = await scenario(async function* () { throw new Error("Concurrency limit exceeded"); }, { maxRecoveryAttempts: 0 });
  assert.equal(noRecovery.calls.length, 1);
  const expired = await scenario(async function* () { throw new Error("Concurrency limit exceeded"); }, { timeoutMs: 1_000 });
  assert.equal(expired.calls.length, 1);
  assert.match(expired.error.message, /自动恢复未成功/);
});
