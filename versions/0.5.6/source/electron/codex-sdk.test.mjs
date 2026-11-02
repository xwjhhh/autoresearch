import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCodexCli, getCodexSdkStatus, runCodexSdk } from "./codex-sdk.mjs";

function tempDirectory() {
  return mkdtempSync(join(tmpdir(), "autoresearch-codex-sdk-"));
}

function fakeCli(path) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "test executable placeholder");
  return path;
}

test("desktop launches prefer the installed Codex desktop runtime over an unrelated global CLI", () => {
  const root = tempDirectory();
  try {
    const local = join(root, "local");
    const appData = join(root, "roaming");
    const desktopOld = fakeCli(join(local, "OpenAI", "Codex", "bin", "older", "codex.exe"));
    const desktop = fakeCli(join(local, "OpenAI", "Codex", "bin", "current", "codex.exe"));
    utimesSync(desktopOld, new Date(0), new Date(0));
    const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const global = fakeCli(join(appData, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", `codex-win32-${process.arch}`, "vendor", target, "bin", "codex.exe"));
    const env = { USERPROFILE: root, LOCALAPPDATA: local, APPDATA: appData, PATH: "" };
    assert.equal(findCodexCli(env), desktop);
    assert.equal(findCodexCli({ ...env, AUTORESEARCH_CODEX_PATH: global }), global);
    assert.equal(findCodexCli({ ...env, PATH: join(global, "..") }), global);
    rmSync(join(local, "OpenAI"), { recursive: true });
    assert.equal(findCodexCli(env), global);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prefers explicit Codex paths, then PATH, home bin, and editor extensions", () => {
  const root = tempDirectory();
  try {
    const explicit = fakeCli(join(root, "explicit", "codex.exe"));
    const explicitFallback = fakeCli(join(root, "explicit-fallback", "codex.exe"));
    const pathCli = fakeCli(join(root, "path", "codex.exe"));
    const homeCli = fakeCli(join(root, "profile", ".codex", "bin", "codex.exe"));
    const npmProfile = join(root, "npm-profile");
    const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const npmCli = process.arch === "arm64" || process.arch === "x64"
      ? fakeCli(join(npmProfile, "AppData", "npm", "node_modules", "@openai", `codex-win32-${process.arch}`, "vendor", target, "bin", "codex.exe"))
      : undefined;
    const env = {
      AUTORESEARCH_CODEX_PATH: explicit,
      CODEX_CLI_PATH: explicitFallback,
      PATH: join(root, "path"),
      USERPROFILE: join(root, "profile"),
    };

    assert.equal(findCodexCli(env), explicit);
    assert.equal(findCodexCli({ ...env, AUTORESEARCH_CODEX_PATH: "" }), explicitFallback);
    assert.equal(findCodexCli({ ...env, AUTORESEARCH_CODEX_PATH: "", CODEX_CLI_PATH: "" }), pathCli);
    assert.equal(findCodexCli({ ...env, PATH: "", AUTORESEARCH_CODEX_PATH: "", CODEX_CLI_PATH: "" }), homeCli);
    if (npmCli) {
      assert.equal(findCodexCli({
        PATH: "",
        USERPROFILE: npmProfile,
        APPDATA: join(npmProfile, "AppData"),
      }), npmCli);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds the Codex CLI bundled in a matching VS Code or Cursor extension", () => {
  const root = tempDirectory();
  try {
    const home = join(root, "profile");
    const extensionRoot = join(home, ".cursor", "extensions");
    const extensionDirectory = join(extensionRoot, "openai.chatgpt-test");
    const archDirectory = process.arch === "arm64" ? "windows-aarch64" : "windows-x86_64";
    const cli = fakeCli(join(extensionDirectory, "bin", archDirectory, "codex.exe"));

    assert.equal(findCodexCli({ USERPROFILE: home, PATH: "" }), cli);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports only availability and the CLI path without reading Codex credentials", () => {
  const root = tempDirectory();
  try {
    const home = join(root, "codex-home");
    const cli = fakeCli(join(root, "bin", "codex.exe"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), "config marker");
    writeFileSync(join(home, "auth.json"), "credential marker that must not be returned");
    const status = getCodexSdkStatus({
      env: { PATH: join(root, "bin"), USERPROFILE: root },
      codexHome: home,
    });

    assert.deepEqual(status, {
      cliAvailable: true,
      configAvailable: true,
      authAvailable: true,
      cliPath: cli,
    });
    assert.equal(JSON.stringify(status).includes("credential marker"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects environment credentials without returning their values", () => {
  const root = tempDirectory();
  try {
    const status = getCodexSdkStatus({
      env: { PATH: "", USERPROFILE: root, CODEX_API_KEY: "secret-codex-token" },
      codexHome: join(root, "empty-codex-home"),
    });

    assert.equal(status.authAvailable, true);
    assert.equal(JSON.stringify(status).includes("secret-codex-token"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs one read-only thread with the configured Codex home and returns its final response", async () => {
  const root = tempDirectory();
  try {
    const cli = fakeCli(join(root, "bin", "codex.exe"));
    const workingDirectory = join(root, "project");
    const codexHome = join(root, "custom-codex-home");
    mkdirSync(workingDirectory, { recursive: true });
    let sdkOptions;
    let threadOptions;
    let receivedPrompt;
    let runOptions;
    let threadStarts = 0;
    const response = await runCodexSdk("分析这篇论文", {
      env: { PATH: join(root, "bin"), USERPROFILE: root, OPENAI_API_KEY: "private-env-value" },
      codexHome,
      workingDirectory,
      reasoningEffort: "high",
      sdkFactory: (options) => {
        sdkOptions = options;
        return {
          startThread: (optionsForThread) => {
            threadStarts += 1;
            threadOptions = optionsForThread;
            return {
              run: async (prompt, options) => {
                receivedPrompt = prompt;
                runOptions = options;
                return { finalResponse: "分析结果" };
              },
            };
          },
        };
      },
    });

    assert.deepEqual(response, { finalResponse: "分析结果" });
    assert.equal(receivedPrompt, "分析这篇论文");
    assert.equal(threadStarts, 1);
    assert.equal(sdkOptions.codexPathOverride, cli);
    assert.equal(sdkOptions.env.CODEX_HOME, codexHome);
    assert.deepEqual(sdkOptions.config, {
      mcp_servers: {},
      shell_environment_policy: { set: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } },
    });
    assert.equal(sdkOptions.env.PYTHONUTF8, "1");
    assert.equal(sdkOptions.env.PYTHONIOENCODING, "utf-8");
    assert.ok(runOptions.signal instanceof AbortSignal);
    assert.deepEqual(threadOptions, {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      modelReasoningEffort: "high",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enables writable project access, live web search, and configured MCP tools when requested", async () => {
  const root = tempDirectory();
  try {
    fakeCli(join(root, "bin", "codex.exe"));
    const workingDirectory = join(root, "project");
    mkdirSync(workingDirectory, { recursive: true });
    let sdkOptions;
    let threadOptions;
    const response = await runCodexSdk("处理课题文件并搜索资料", {
      env: { PATH: join(root, "bin"), USERPROFILE: root },
      workingDirectory,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      webSearchMode: "live",
      enableMcpServers: true,
      sdkFactory: (options) => {
        sdkOptions = options;
        return {
          startThread: (optionsForThread) => {
            threadOptions = optionsForThread;
            return { run: async () => ({ finalResponse: "已完成" }) };
          },
        };
      },
    });

    assert.deepEqual(response, { finalResponse: "已完成" });
    assert.deepEqual(sdkOptions.config, {
      shell_environment_policy: { set: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } },
    });
    assert.deepEqual(threadOptions, {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      webSearchMode: "live",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported sandbox, approval, and web search values", async () => {
  const options = { workingDirectory: tempDirectory(), sdkFactory: () => { throw new Error("must not construct"); } };
  try {
    await assert.rejects(runCodexSdk("test", { ...options, sandboxMode: "unrestricted" }), /沙箱模式设置无效/);
    await assert.rejects(runCodexSdk("test", { ...options, approvalPolicy: "allow-everything" }), /审批策略设置无效/);
    await assert.rejects(runCodexSdk("test", { ...options, webSearchMode: "always" }), /网络搜索模式设置无效/);
  } finally {
    rmSync(options.workingDirectory, { recursive: true, force: true });
  }
});

test("resumes an interrupted streamed Codex turn with the same thread before returning output", async () => {
  const root = tempDirectory();
  try {
    const cli = fakeCli(join(root, "bin", "codex.exe"));
    const workingDirectory = join(root, "project");
    mkdirSync(workingDirectory, { recursive: true });
    let started = 0;
    let resumed = 0;
    let attempts = 0;
    const response = await runCodexSdk("生成研究候选", {
      env: { PATH: join(root, "bin"), USERPROFILE: root }, workingDirectory,
      wait: async () => {},
      sdkFactory: () => ({
        startThread: () => { started += 1; return thread(); },
        resumeThread: (id) => { assert.equal(id, "thread-1"); resumed += 1; return thread(); },
      }),
    });
    function thread() {
      return {
        id: "thread-1",
        runStreamed: async () => ({ events: (async function* () {
          attempts += 1;
          yield { type: "thread.started", thread_id: "thread-1" };
          if (attempts === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
          yield { type: "item.completed", item: { type: "agent_message", text: "恢复后的完整输出" } };
          yield { type: "turn.completed" };
        })() }),
      };
    }
    assert.deepEqual(response, { finalResponse: "恢复后的完整输出" });
    assert.equal(started, 1);
    assert.equal(resumed, 1);
    assert.equal(attempts, 2);
    assert.equal(cli, findCodexCli({ PATH: join(root, "bin"), USERPROFILE: root }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("starts a fresh thread when the saved thread already has an active writer", async () => {
  const root = tempDirectory();
  try {
    const cli = fakeCli(join(root, "bin", "codex.exe"));
    const workingDirectory = join(root, "project");
    mkdirSync(workingDirectory, { recursive: true });
    let started = 0;
    let resumed = 0;
    let attempts = 0;
    const savedThreadIds = [];
    const resumedIds = [];
    const response = await runCodexSdk("生成研究候选", {
      env: { PATH: join(root, "bin"), USERPROFILE: root }, workingDirectory,
      threadId: "thread-owned-elsewhere",
      wait: async () => {},
      onThread: async (id) => savedThreadIds.push(id),
      sdkFactory: () => ({
        startThread: () => {
          started += 1;
          const id = `fresh-thread-${started}`;
          return {
            id,
            runStreamed: async () => ({ events: (async function* () {
              attempts += 1;
              yield { type: "thread.started", thread_id: id };
              if (attempts === 1) throw new Error("Codex Exec exited with code 1: thread-store conflict: thread already has an active writer");
              yield { type: "item.completed", item: { type: "agent_message", text: "新线程的完整输出" } };
              yield { type: "turn.completed" };
            })() }),
          };
        },
        resumeThread: (id) => { resumed += 1; resumedIds.push(id); throw new Error("thread-store conflict: thread already has an active writer"); },
      }),
    });

    assert.deepEqual(response, { finalResponse: "新线程的完整输出" });
    assert.equal(started, 2);
    assert.equal(resumed, 1);
    assert.deepEqual(resumedIds, ["thread-owned-elsewhere"]);
    assert.equal(attempts, 2);
    assert.deepEqual(savedThreadIds, [null, "fresh-thread-1", null, "fresh-thread-2", "fresh-thread-2"]);
    assert.equal(cli, findCodexCli({ PATH: join(root, "bin"), USERPROFILE: root }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fails clearly when no external Codex CLI is available", async () => {
  const root = tempDirectory();
  try {
    await assert.rejects(
      runCodexSdk("分析", { env: { PATH: "", USERPROFILE: root }, workingDirectory: tmpdir(), sdkFactory: () => { throw new Error("must not construct"); } }),
      /未找到 Codex CLI/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("experiment turns can use a writable sandbox and receive every streamed event", async () => {
  const root = tempDirectory();
  try {
    fakeCli(join(root, "bin", "codex.exe"));
    const workingDirectory = join(root, "workspace");
    mkdirSync(workingDirectory, { recursive: true });
    let threadOptions;
    const seen = [];
    const response = await runCodexSdk("复现实验", {
      env: { PATH: join(root, "bin"), USERPROFILE: root },
      workingDirectory,
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
      onEvent: (event) => { seen.push(event.type); },
      sdkFactory: () => ({
        startThread: (options) => {
          threadOptions = options;
          return {
            id: "thread-x",
            runStreamed: async () => ({ events: (async function* () {
              yield { type: "thread.started", thread_id: "thread-x" };
              yield { type: "item.completed", item: { type: "command_execution", command: "ls", exit_code: 0 } };
              yield { type: "item.completed", item: { type: "agent_message", text: "完成" } };
              yield { type: "turn.completed" };
            })() }),
          };
        },
      }),
    });
    assert.deepEqual(response, { finalResponse: "完成" });
    assert.equal(threadOptions.sandboxMode, "workspace-write");
    assert.equal(threadOptions.networkAccessEnabled, true);
    assert.deepEqual(seen, ["thread.started", "item.completed", "item.completed", "turn.completed"]);
    await assert.rejects(runCodexSdk("x", { env: { PATH: join(root, "bin"), USERPROFILE: root }, workingDirectory, sandboxMode: "unrestricted" }), /沙箱模式设置无效/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex SDK accepts a task-scoped local question MCP server", async () => {
  const root = tempDirectory();
  try {
    fakeCli(join(root, "bin", "codex.exe"));
    const workingDirectory = join(root, "workspace");
    mkdirSync(workingDirectory, { recursive: true });
    const mcpServers = {
      autoresearch_questions: {
        command: "node.exe",
        args: [join(workingDirectory, ".ar", "question-server.mjs")],
        env: { AUTORESEARCH_QUESTION_REQUESTS: join(workingDirectory, ".ar", "questions") },
        default_tools_approval_mode: "approve",
        required: true,
        tool_timeout_sec: 2700,
      },
    };
    let sdkOptions;
    await runCodexSdk("先问研究者", {
      env: { PATH: join(root, "bin"), USERPROFILE: root },
      workingDirectory,
      shellEnvironment: { AUTORESEARCH_CONVERSATION_ID: "conv_secondary123" },
      mcpServers,
      sdkFactory: (options) => {
        sdkOptions = options;
        return {
          startThread: () => ({
            runStreamed: async () => ({ events: (async function* () {
              yield { type: "item.completed", item: { type: "agent_message", text: "完成" } };
              yield { type: "turn.completed" };
            })() }),
          }),
        };
      },
    });
    assert.deepEqual(sdkOptions.config, {
      mcp_servers: mcpServers,
      shell_environment_policy: { set: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", AUTORESEARCH_CONVERSATION_ID: "conv_secondary123" } },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
