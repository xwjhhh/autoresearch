import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { isRetryable, retryDelay, waitForRetry } from "./retry.mjs";
import { CODEX_CONTINUATION_PROMPT, codexRecoveryDelay, isTransientCodexFailure } from "./codex-recovery.mjs";
import { environmentVariables } from "./environments/runtime.mjs";

const CODEX_BINARY = "codex.exe";
const THREAD_WRITER_CONFLICT = /thread-store conflict|already has an active writer|thread\/resume.*active writer/i;

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function homeDirectory(env) {
  return env.USERPROFILE || env.HOME || homedir();
}

function envValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function normalizeExplicitPath(value) {
  const path = typeof value === "string" ? value.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted) : "";
  return path ? resolve(path) : undefined;
}

function extensionCandidates(env) {
  const archDirectory = process.arch === "arm64" ? "windows-aarch64"
    : process.arch === "x64" ? "windows-x86_64" : undefined;
  if (!archDirectory) return [];

  const home = homeDirectory(env);
  const roots = [
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
    join(home, ".vscode-oss", "extensions"),
    join(home, ".cursor", "extensions"),
  ];
  const candidates = [];
  for (const root of roots) {
    let extensions;
    try {
      extensions = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith("openai.chatgpt-"))
        .map((entry) => join(root, entry.name))
        .sort((a, b) => {
          try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
        });
    } catch {
      continue;
    }
    candidates.push(...extensions.map((extension) => join(extension, "bin", archDirectory, CODEX_BINARY)));
  }
  return candidates;
}

function installedCliCandidates(env) {
  const home = homeDirectory(env);
  const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc"
    : process.arch === "x64" ? "x86_64-pc-windows-msvc" : undefined;
  const candidates = [
    ...(envValue(env, "CODEX_HOME") ? [join(envValue(env, "CODEX_HOME"), "bin", CODEX_BINARY)] : []),
    join(home, ".codex", "bin", CODEX_BINARY),
    join(home, ".local", "bin", CODEX_BINARY),
  ];

  // 桌面应用启动时通常没有 Codex 注入的 PATH。优先使用其已安装运行时，
  // 避免退回另一份全局 CLI，与当前 Windows 沙箱 / 桌面工具运行时不兼容。
  const localAppData = envValue(env, "LOCALAPPDATA");
  if (localAppData) {
    const desktopBin = join(localAppData, "OpenAI", "Codex", "bin");
    try {
      const runtimes = readdirSync(desktopBin, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(desktopBin, entry.name, CODEX_BINARY))
        .filter(isFile)
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      candidates.push(...runtimes);
    } catch { /* 没有安装 Codex 桌面版时，继续查找现有 CLI。 */ }
  }

  if (target) {
    const npmRoots = [
      envValue(env, "NPM_CONFIG_PREFIX") ? join(envValue(env, "NPM_CONFIG_PREFIX"), "node_modules") : undefined,
      envValue(env, "APPDATA") ? join(envValue(env, "APPDATA"), "npm", "node_modules") : undefined,
      join(envValue(env, "BUN_INSTALL") || join(home, ".bun"), "install", "global", "node_modules"),
      envValue(env, "LOCALAPPDATA") ? join(envValue(env, "LOCALAPPDATA"), "pnpm", "global", "5", "node_modules") : undefined,
    ].filter(Boolean);
    for (const root of npmRoots) {
      const platformPackage = join(root, "@openai", `codex-win32-${process.arch}`);
      candidates.push(
        join(platformPackage, "vendor", target, "bin", CODEX_BINARY),
        join(root, "@openai", "codex", "node_modules", "@openai", `codex-win32-${process.arch}`, "vendor", target, "bin", CODEX_BINARY),
      );
    }
  }

  return [...candidates, ...extensionCandidates(env)];
}

function addAdjacentCodexPath(executable, env) {
  const binaryDirectory = dirname(executable);
  const vendorRoot = /[\\/]bin$/i.test(binaryDirectory) ? dirname(binaryDirectory) : binaryDirectory;
  const helperDirectory = join(vendorRoot, "codex-path");
  try { if (!statSync(helperDirectory).isDirectory()) return; }
  catch { return; }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const entries = (env[pathKey] || "").split(delimiter).filter(Boolean);
  if (!entries.some((entry) => resolve(entry).toLowerCase() === resolve(helperDirectory).toLowerCase())) {
    env[pathKey] = [helperDirectory, ...entries].join(delimiter);
  }
}

export function findCodexCli(env = process.env) {
  for (const name of ["AUTORESEARCH_CODEX_PATH", "OMNISCI_CODEX_PATH", "CODEX_CLI_PATH"]) {
    const candidate = normalizeExplicitPath(envValue(env, name));
    if (candidate && isFile(candidate)) return candidate;
  }

  const pathValue = envValue(env, "PATH") ?? "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted), CODEX_BINARY);
    if (isFile(candidate)) return resolve(candidate);
  }

  return installedCliCandidates(env).map((candidate) => resolve(candidate)).find(isFile);
}

function resolveCodexHome(env, codexHome) {
  const configured = codexHome || envValue(env, "CODEX_HOME") || join(homeDirectory(env), ".codex");
  return resolve(configured);
}

export function getCodexSdkStatus({ env = process.env, codexHome } = {}) {
  const cliPath = findCodexCli(env);
  const home = resolveCodexHome(env, codexHome);
  return {
    cliAvailable: Boolean(cliPath),
    configAvailable: isFile(join(home, "config.toml")),
    authAvailable: isFile(join(home, "auth.json")) || ["CODEX_API_KEY", "OPENAI_API_KEY"].some((name) => {
      const value = envValue(env, name);
      return typeof value === "string" && Boolean(value.trim());
    }),
    ...(cliPath ? { cliPath } : {}),
  };
}

export async function runCodexSdk(prompt, {
  env = process.env,
  codexHome,
  workingDirectory,
  reasoningEffort,
  sandboxMode = "read-only",
  approvalPolicy = "never",
  networkAccessEnabled = false,
  webSearchMode,
  additionalDirectories,
  enableMcpServers = false,
  mcpServers,
  sdkFactory,
  signal,
  threadId,
  onThread,
  onRetry,
  onEvent,
  shellEnvironment = {},
  maxRecoveryAttempts = 0,
  maxAttempts = 6,
  timeoutMs = 600_000,
  wait = waitForRetry,
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("研究任务不能为空。");
  if (typeof workingDirectory !== "string" || !workingDirectory.trim()) throw new Error("工作目录不能为空。");
  if (reasoningEffort !== undefined && !["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"].includes(reasoningEffort)) {
    throw new Error("Codex 思考强度设置无效。");
  }
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandboxMode)) throw new Error("Codex 沙箱模式设置无效。");
  if (!["never", "on-request", "on-failure", "untrusted"].includes(approvalPolicy)) throw new Error("Codex 审批策略设置无效。");
  if (webSearchMode !== undefined && !["disabled", "cached", "live"].includes(webSearchMode)) throw new Error("Codex 网络搜索模式设置无效。");

  const cliPath = findCodexCli(env);
  if (!cliPath) throw new Error("未找到 Codex CLI。请安装 Codex，或设置 AUTORESEARCH_CODEX_PATH。");

  let factory = sdkFactory;
  if (!factory) {
    let Codex;
    try {
      ({ Codex } = await import("@openai/codex-sdk"));
    } catch {
      throw new Error("Codex SDK 未安装。请安装 @openai/codex-sdk 后重试。");
    }
    factory = (options) => new Codex(options);
  }

  const sdkEnv = environmentVariables(Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")), null);
  sdkEnv.CODEX_HOME = resolveCodexHome(env, codexHome);
  addAdjacentCodexPath(cliPath, sdkEnv);
  const mcpConfig = mcpServers && Object.keys(mcpServers).length
    ? { mcp_servers: mcpServers }
    : enableMcpServers ? undefined : { mcp_servers: {} };
  const shellConversationId = typeof shellEnvironment.AUTORESEARCH_CONVERSATION_ID === "string"
    && /^conv_[A-Za-z0-9_-]{3,64}$/.test(shellEnvironment.AUTORESEARCH_CONVERSATION_ID)
    ? shellEnvironment.AUTORESEARCH_CONVERSATION_ID
    : undefined;
  const client = factory({
    env: sdkEnv,
    codexPathOverride: cliPath,
    config: {
      ...mcpConfig,
      // CLI shell inheritance can filter PYTHON* from its process environment.
      // Override only these leaves, retaining the user's inherit/include/exclude policy.
      shell_environment_policy: { set: {
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        ...(shellConversationId ? { AUTORESEARCH_CONVERSATION_ID: shellConversationId } : {}),
      } },
    },
  });
  const threadOptions = {
    workingDirectory: resolve(workingDirectory),
    skipGitRepoCheck: true,
    sandboxMode,
    approvalPolicy,
    networkAccessEnabled,
    ...(webSearchMode ? { webSearchMode } : {}),
    ...(additionalDirectories?.length ? { additionalDirectories } : {}),
    ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
  };
  let thread;
  if (threadId) {
    try { thread = client.resumeThread(threadId, threadOptions); }
    catch (error) {
      if (!THREAD_WRITER_CONFLICT.test(String(error?.message ?? error))) throw error;
      await onThread?.(null);
      thread = client.startThread(threadOptions);
    }
  } else thread = client.startThread(threadOptions);
  const attempts = Math.max(1, Math.min(20, Math.floor(maxAttempts) || 1));
  const recoveries = Math.max(0, Math.min(5, Math.floor(maxRecoveryAttempts) || 0));
  let recoveryCount = 0;
  let knownThreadId = threadId || thread?.id;
  let attemptPrompt = prompt;
  let hasAcceptedTurn = false;
  const deadline = Date.now() + timeoutMs;
  let writerConflictRetries = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("Codex 本轮等待已达到时间上限，会话已保留，请稍后继续。");
    const turnSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]) : AbortSignal.timeout(remainingMs);
    const pendingTools = new Set();
    try {
      let finalResponse = "";
      if (typeof thread.runStreamed === "function") {
        const { events } = await thread.runStreamed(attemptPrompt, { signal: turnSignal });
        let completed = false;
        let lastStreamError;
        for await (const event of events) {
          signal?.throwIfAborted();
          await onEvent?.(event);
          if (event.type === "thread.started") {
            knownThreadId = event.thread_id;
            await onThread?.(event.thread_id);
          }
          if (event.type === "turn.started" || event.type.startsWith("item.")) hasAcceptedTurn = true;
          if (["command_execution", "file_change", "mcp_tool_call", "collab_tool_call"].includes(event.item?.type)) {
            const key = event.item.id || event.item.type;
            if (event.type === "item.completed") pendingTools.delete(key);
            else if (event.type === "item.started" || event.type === "item.updated") pendingTools.add(key);
          }
          if (event.type === "item.completed" && event.item.type === "agent_message") finalResponse = event.item.text;
          if (event.type === "turn.failed") throw new Error(event.error.message);
          if (event.type === "error") {
            const error = new Error(event.message);
            const reconnecting = /^Reconnecting\.\.\.\s*(\d+)\/(\d+)/i.exec(event.message);
            // CLI emits progress errors while its own reconnect loop is alive.
            // Throwing here closes the SDK iterator and kills that CLI process.
            if (recoveries && reconnecting && isTransientCodexFailure(error)) {
              lastStreamError = error;
              await onRetry?.({ attempt: Number(reconnecting[1]), maxAttempts: Number(reconnecting[2]), delayMs: 0, error, recovery: true, phase: "reconnecting" });
              continue;
            }
            throw error;
          }
          if (event.type === "turn.completed") completed = true;
        }
        if (!completed) throw lastStreamError ?? new Error("Codex 回复流在完成前中断。");
      } else {
        const turn = await thread.run(attemptPrompt, { signal: turnSignal });
        finalResponse = turn?.finalResponse;
      }
      if (thread.id) await onThread?.(thread.id);
      if (typeof finalResponse !== "string" || !finalResponse.trim()) throw new Error("Codex CLI 没有返回最终回复。");
      return { finalResponse };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const writerConflict = THREAD_WRITER_CONFLICT.test(String(error?.message ?? error));
      if (writerConflict) {
        // A thread with another active writer cannot be resumed by this process.
        thread = null;
        knownThreadId = undefined;
        hasAcceptedTurn = false;
        attemptPrompt = prompt;
        await onThread?.(null);
        if (writerConflictRetries < 1) {
          writerConflictRetries += 1;
          await wait(250, signal);
          thread = client.startThread(threadOptions);
          attempt -= 1;
          continue;
        }
      } else {
        knownThreadId = thread?.id || knownThreadId;
        if (knownThreadId) await onThread?.(knownThreadId);
      }
      if (recoveries && !turnSignal.aborted && isTransientCodexFailure(error)) {
        // An unfinished tool may still be running. Never retry its side effects.
        if (typeof thread?.runStreamed !== "function" || pendingTools.size || (!knownThreadId && hasAcceptedTurn)) throw error;
        const delayMs = codexRecoveryDelay(recoveryCount + 1);
        if (recoveryCount >= recoveries || Date.now() + delayMs >= deadline) {
          throw new Error(`上游并发限额或连接异常，自动恢复未成功；会话及已完成操作已保留，请稍后继续。原始错误：${error.message}`, { cause: error });
        }
        recoveryCount += 1;
        await onRetry?.({ attempt: recoveryCount, maxAttempts: recoveries, delayMs, error, recovery: true, phase: "waiting" });
        await wait(delayMs, signal);
        signal?.throwIfAborted();
        if (knownThreadId) {
          thread = client.resumeThread(knownThreadId, threadOptions);
          // Do not resend the original tool-using task after it has started.
          attemptPrompt = hasAcceptedTurn ? CODEX_CONTINUATION_PROMPT : prompt;
        } else thread = client.startThread(threadOptions);
        await onRetry?.({ attempt: recoveryCount, maxAttempts: recoveries, delayMs: 0, error, recovery: true, phase: "resuming" });
        attempt -= 1;
        continue;
      }
      if (attempt >= attempts || !isRetryable(error)) throw error;
      const delayMs = retryDelay(attempt);
      await onRetry?.({ attempt, maxAttempts: attempts, delayMs, error });
      await wait(delayMs, signal);
      // Retain interrupted context unless another process owns that thread.
      if (thread?.id) thread = client.resumeThread(thread.id, threadOptions);
      else thread = client.startThread(threadOptions);
    }
  }
}
