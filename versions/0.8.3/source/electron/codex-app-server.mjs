import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { addAdjacentCodexPath, codexCliCandidates } from "./codex-sdk.mjs";
import { runCommand } from "./iteration-github.mjs";
import { stopProcess } from "./iteration-runtime.mjs";
import { approvalMethods, iterationApproval, iterationApprovalResult } from "./iteration-policy.mjs";

const disabledFeatures = {
  restricted: ["apps", "plugins", "hooks", "multi_agent", "multi_agent_v2", "skill_mcp_dependency_install"],
  full: ["apps", "plugins", "skill_mcp_dependency_install"],
};
const text = (value) => typeof value === "string" ? value : "";

export async function resolveAppServer(env = process.env) {
  for (const executable of codexCliCandidates(env)) {
    const help = await runCommand(executable, ["app-server", "--help"], { env, timeout: 5000 }).catch(() => "");
    if (help.includes("--listen") && help.includes("stdio://")) return executable;
  }
  throw new Error("本机未找到支持 App Server stdio 的 Codex CLI。请将 AUTORESEARCH_CODEX_PATH 指向可用的 Codex 可执行文件，或在迭代设置中切换到旧 SDK。");
}

export class AppServerConnection {
  constructor(executable, { env, cwd, spawnProcess = spawn, onMessage = () => {}, access = "restricted", projects = {} } = {}) {
    this.outbound = 0;
    this.waiting = new Map();
    const trust = Object.keys(projects).flatMap((root) => ["-c", `projects.${JSON.stringify(root)}.trust_level="trusted"`]);
    const disabled = disabledFeatures[access].flatMap((feature) => ["--disable", feature]);
    const enabled = access === "full" ? ["--enable", "hooks", "--enable", "multi_agent"] : ["--enable", "request_permissions_tool"];
    this.child = spawnProcess(executable, ["app-server", "--listen", "stdio://", ...trust, ...enabled, ...disabled], { env, cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.reader.on("line", (line) => {
      if (this.error || !line.trim()) return;
      try {
        if (line.length > 8 * 1024 * 1024) throw new Error("App Server 消息超过协议限制。");
        const value = JSON.parse(line);
        if (value.method) onMessage(value);
        else if (Object.hasOwn(value, "id")) {
          const pending = this.waiting.get(value.id);
          if (pending) pending.finish(value.error ? new Error(text(value.error.message) || "App Server 请求失败。") : null, value.result);
        }
      } catch (error) { this.fail(error); }
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.once("error", (error) => this.fail(error));
    this.closed = new Promise((resolve) => this.child.once("close", (code) => {
      this.fail(new Error(`Codex App Server 已退出（${code ?? "无退出码"}）。`));
      resolve();
    }));
    this.failure = new Promise((_, reject) => { this.failConnection = reject; });
    void this.failure.catch(() => {});
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    for (const pending of this.waiting.values()) pending.finish(error);
    this.failConnection(error);
  }

  send(value) {
    if (this.error) throw this.error;
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  request(method, params, timeout = 25000) {
    const id = ++this.outbound;
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`App Server 请求超时：${method}`)), timeout);
      this.waiting.set(id, { finish });
      try { this.send({ id, method, params }); } catch (error) { finish(error); }
    });
  }

  async initialize() {
    const result = await this.request("initialize", { clientInfo: { name: "autoresearch", title: "AutoResearch", version: "1" }, capabilities: { experimentalApi: false, requestAttestation: false } });
    this.send({ method: "initialized" });
    return result;
  }

  async close() {
    this.reader.close();
    this.child.stdin.end();
    this.fail(new Error("App Server 连接已关闭。"));
    const timer = setTimeout(() => stopProcess(this.child), 1500);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}

function connectedItem(item) {
  if (item.type === "commandExecution") return { type: "command_execution", command: item.command, exit_code: item.exitCode };
  if (item.type === "fileChange") return { type: "file_change", changes: (item.changes ?? []).map((change) => ({ path: change.path, kind: change.kind?.type })) };
  return null;
}

export async function trustedProjects(workingDirectory, env) {
  const common = await runCommand("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: workingDirectory, env, timeout: 5000 }).then((value) => value.trim()).catch(() => "");
  const roots = [workingDirectory, ...(common ? [dirname(common)] : [])];
  return Object.fromEntries(roots.map((root) => [root, { trust_level: "trusted" }]));
}

export async function runCodexAppServer(prompt, options) {
  const { access = "restricted", workingDirectory, codexHome, env = process.env, extraEnv, configOverrides, model, reasoningEffort, imagePaths = [], threadId, signal, onThread, onEvent, onApproval, dismissApproval, onDelta, timeoutMs = 45 * 60_000, executable: supplied, spawnProcess } = options;
  signal?.throwIfAborted();
  const executable = supplied ?? await resolveAppServer(env);
  signal?.throwIfAborted();
  const processEnv = { ...env, ...(codexHome ? { CODEX_HOME: codexHome } : {}), ...extraEnv };
  addAdjacentCodexPath(executable, processEnv);
  const shellEnv = { ...env };
  addAdjacentCodexPath(executable, shellEnv);
  const full = access === "full";
  const projects = full ? await trustedProjects(workingDirectory, env) : {};
  signal?.throwIfAborted();
  const approvalPolicy = full ? "never" : "untrusted";
  const config = { ...configOverrides, ...(full ? {} : { mcp_servers: {} }), web_search: full ? "live" : "disabled", shell_environment_policy: { inherit: "none", set: shellEnv } };
  const sandboxPolicy = full ? { type: "dangerFullAccess" } : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  const threadConfig = { cwd: workingDirectory, approvalPolicy, approvalsReviewer: "user", sandbox: full ? "danger-full-access" : "workspace-write", config, ...(model ? { model } : {}), ...(configOverrides?.model_provider ? { modelProvider: configOverrides.model_provider } : {}) };
  const controller = new AbortController();
  const items = new Map(), approvals = new Map(), pendingApprovals = new Set();
  let thread, turn, queued = Promise.resolve(), finalResponse = "", interruptError, interruptTimer, latestDelta = "";
  let settle, rejectTurn;
  const finished = new Promise((resolve, reject) => { settle = resolve; rejectTurn = reject; });
  void finished.catch(() => {});
  const serialize = (event) => { queued = queued.then(event).catch(rejectTurn); };
  const interrupt = () => {
    if (!turn || interruptTimer || !controller.signal.aborted) return;
    interruptTimer = setTimeout(() => rejectTurn(interruptError), 7500);
    void rpc.request("turn/interrupt", { threadId: thread, turnId: turn }, 5000).catch(rejectTurn);
  };
  const cancel = (error) => {
    if (controller.signal.aborted) return;
    interruptError = error;
    controller.abort();
    interrupt();
  };
  const onAbort = () => cancel(new Error("操作已停止。"));

  async function approval({ id, method, params }) {
    const request = randomUUID();
    if (!approvalMethods.has(method)) {
      rpc.send({ id, error: { code: -32601, message: "AutoResearch does not grant this request" } });
      return;
    }
    if (!thread || params?.threadId !== thread || !turn || params?.turnId !== turn || approvals.has(id)) {
      rpc.send({ id, result: iterationApprovalResult(method, params, false, false) });
      return;
    }
    approvals.set(id, request);
    try {
      const card = iterationApproval({ method, params, item: items.get(params.itemId) });
      const answer = !controller.signal.aborted && await onApproval?.({ id: request, ...card }, controller.signal);
      if (approvals.has(id) && !rpc.error) rpc.send({ id, result: iterationApprovalResult(method, params, answer === true, controller.signal.aborted) });
    } finally { approvals.delete(id); dismissApproval?.(request); }
  }

  const rpc = new AppServerConnection(executable, { env: processEnv, cwd: dirname(workingDirectory), spawnProcess, access, projects, onMessage: ({ id, method, params }) => {
    if (id !== undefined) {
      const pending = approval({ id, method, params }).catch(rejectTurn).finally(() => pendingApprovals.delete(pending));
      pendingApprovals.add(pending);
      return;
    }
    if (params?.threadId !== thread || !thread) return;
    if (method === "turn/started" && !turn) { turn = params.turn.id; interrupt(); }
    if (method === "serverRequest/resolved") {
      if (approvals.has(params.requestId)) dismissApproval?.(approvals.get(params.requestId));
      approvals.delete(params.requestId);
      return;
    }
    if (!turn || (params.turnId ?? params.turn?.id) !== turn) return;
    if (method === "item/started" || method === "item/completed") {
      const item = params.item;
      if (method === "item/started" && ["fileChange", "commandExecution"].includes(item.type)) items.set(item.id, item);
      if (method === "item/completed") {
        items.delete(item.id);
        if (item.type === "agentMessage" && item.phase !== "commentary") finalResponse = item.text;
      }
      const event = connectedItem(item);
      if (event) serialize(() => onEvent?.({ type: method.replace("/", "."), item: event }));
    }
    if (method === "item/agentMessage/delta") {
      latestDelta = (latestDelta + text(params.delta)).slice(-2500);
      onDelta?.(latestDelta);
    }
    if (method === "turn/completed") settle(params.turn);
  } });
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timeout = setTimeout(() => cancel(new Error("Codex App Server 回合超时。")), timeoutMs);
  try {
    await rpc.initialize();
    controller.signal.throwIfAborted();
    const response = await rpc.request(threadId ? "thread/resume" : "thread/start", { ...threadConfig, ...(threadId ? { threadId, excludeTurns: true } : {}) });
    thread = response?.thread?.id;
    if (!thread) throw new Error("App Server 未返回 thread ID。");
    await onThread?.(thread);
    if (controller.signal.aborted) throw interruptError;
    const input = [{ type: "text", text: prompt, text_elements: [] }, ...imagePaths.map((path) => ({ type: "localImage", path }))];
    const started = await rpc.request("turn/start", { threadId: thread, cwd: workingDirectory, input, approvalPolicy, approvalsReviewer: "user", sandboxPolicy, ...(reasoningEffort ? { effort: reasoningEffort } : {}) });
    if (!started?.turn?.id || (turn && turn !== started.turn.id)) throw new Error("App Server 返回的 turn ID 不匹配。");
    turn = started.turn.id;
    interrupt();
    const result = await Promise.race([finished, rpc.failure]);
    await queued;
    if (controller.signal.aborted || result.status === "interrupted") throw interruptError ?? new Error("操作已停止。");
    if (result.status !== "completed") throw new Error(text(result.error?.message) || "Codex App Server 回合失败。");
    return { finalResponse };
  } finally {
    clearTimeout(timeout);
    clearTimeout(interruptTimer);
    controller.abort();
    signal?.removeEventListener("abort", onAbort);
    await rpc.close();
    await Promise.all(pendingApprovals);
    onDelta?.("");
  }
}
