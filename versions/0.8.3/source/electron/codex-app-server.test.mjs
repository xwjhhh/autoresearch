import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { runCodexAppServer } from "./codex-app-server.mjs";

const mock = String.raw`
  const assert = require("node:assert/strict");
  const readline = require("node:readline").createInterface({ input: process.stdin });
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const respond = (id, result) => send({id, result});
  const threadId = "test-thread", turnId = "test-turn";
  const item = {type:"commandExecution", id:"item", command:"pwd"};
  const patch = {type:"fileChange", id:"patch", changes:[{path:"../outside.txt", kind:{type:"update", move_path:".git/config"}, diff:"patch for inspection"}, {path:"tests/e2e/electron-fixture.mjs", kind:{type:"update"}}]};
  const permissions = {network:{enabled:true}, fileSystem:{read:["../outside"], write:["../outside" ]}};
  const notify = (method, params) => send({method, params:{threadId, turnId, ...params}});
  const complete = (status) => notify("turn/completed", {turn:{id:turnId, status}});
  const approval = (id, method, params) => send({id, method, params:{threadId, turnId, itemId:item.id, ...params}});
  let initialized = false;
  const answered = new Set();
  readline.on("line", (line) => {
    const {id, method, params, result, error} = JSON.parse(line);
    switch (method) {
      case "initialize": assert.equal(params.capabilities.experimentalApi, false); respond(id, {}); break;
      case "initialized": initialized = true; break;
      case "thread/start":
      case "thread/resume":
        assert(initialized);
        assert.equal(params.approvalPolicy, process.env.MOCK_SCENARIO === "full" ? "never" : "untrusted");
        assert.equal(params.sandbox, process.env.MOCK_SCENARIO === "full" ? "danger-full-access" : "workspace-write");
        assert.equal(params.config.web_search, process.env.MOCK_SCENARIO === "full" ? "live" : "disabled");
        assert.deepEqual(params.config.mcp_servers, process.env.MOCK_SCENARIO === "full" ? undefined : {});
        assert.equal(params.config.shell_environment_policy.inherit, "none");
        assert.equal(params.config.shell_environment_policy.set.MOCK_PROVIDER_KEY, undefined);
        assert.equal(process.env.MOCK_PROVIDER_KEY, "synthetic");
        if (process.env.MOCK_SCENARIO === "resume") {
          assert.equal(method, "thread/resume");
          assert.equal(params.threadId, threadId);
        } else assert.equal(method, "thread/start");
        respond(id, {thread:{id:threadId}}); break;
      case "turn/start":
        if (process.env.MOCK_SCENARIO === "full") {
          assert.equal(params.approvalPolicy, "never");
          assert.deepEqual(params.sandboxPolicy, { type: "dangerFullAccess" });
          respond(id, {turn:{id:turnId}});
          notify("turn/started", {turn:{id:turnId}});
          notify("item/completed", {item:{type:"agentMessage", text:"Done", phase:"final_answer"}});
          complete("completed");
          break;
        }
        assert.equal(params.sandboxPolicy.networkAccess, false);
        assert.equal(params.sandboxPolicy.type, "workspaceWrite");
        notify("turn/started", {turn:{id:turnId}});
        respond(id, {turn:{id:turnId}});
        if (process.env.MOCK_SCENARIO === "disconnect") process.exit(3);
        if (process.env.MOCK_SCENARIO === "interrupt") { notify("item/agentMessage/delta", {delta:"started"}); break; }
        notify("item/started", {item});
        notify("item/started", {item:patch});
        approval("command", "item/commandExecution/requestApproval", {kind:"command", command:"npm test", cwd:"../outside", networkApprovalContext:{host:"example.invalid",protocol:"https"}, proposedExecpolicyAmendment:["npm"]});
        approval("wrong-turn", "item/commandExecution/requestApproval", {kind:"command", command:"pwd", cwd:params.cwd, turnId:"other"});
        approval("unsupported", "item/tool/call", {});
        approval("patch", "item/fileChange/requestApproval", {itemId:patch.id, grantRoot:"../outside"});
        approval("permission", "item/permissions/requestApproval", {permissions});
        break;
      case "turn/interrupt":
        assert.deepEqual(params, {threadId, turnId});
        respond(id, {}); complete("interrupted"); break;
      default:
        const approve = process.env.MOCK_SCENARIO !== "resume";
        if (id === "unsupported") assert.equal(error.code, -32601);
        if (id === "wrong-turn") assert.equal(result.decision, "decline");
        if (["command", "patch"].includes(id)) assert.equal(result.decision, approve ? "accept" : "decline");
        if (id === "permission") assert.deepEqual(result, {permissions:approve ? permissions : {}, scope:"turn"});
        answered.add(id);
        if (answered.size === 5) {
          notify("item/completed", {item:{...item, exitCode:0}});
          notify("item/agentMessage/delta", {delta:"partial"});
          notify("item/completed", {item:{type:"agentMessage", text:"Done", phase:"final_answer"}});
          complete("completed");
        }
    }
  });`;

async function workspace(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ar-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

for (const scenario of ["start", "resume", "interrupt", "disconnect", "full"]) {
  test(`App Server ${scenario} lifecycle`, async (t) => {
    const root = await workspace(t);
    const controller = new AbortController();
    const events = [], cards = [], deltas = [], threads = [];
    const operation = runCodexAppServer("synthetic input", {
      executable: process.execPath,
      spawnProcess: (executable, args, options) => {
        const disabled = args.flatMap((arg, index) => arg === "--disable" ? [args[index + 1]] : []);
        assert.equal(disabled.includes("hooks"), scenario !== "full");
        assert.equal(disabled.includes("multi_agent"), scenario !== "full");
        if (scenario === "full") assert.ok(args.includes(`projects.${JSON.stringify(root)}.trust_level="trusted"`));
        return spawn(executable, ["-e", mock], options);
      },
      env: { ...process.env, MOCK_SCENARIO: scenario },
      extraEnv: { MOCK_PROVIDER_KEY: "synthetic" },
      access: scenario === "full" ? "full" : "restricted",
      workingDirectory: root,
      ...(scenario === "resume" ? { threadId: "test-thread" } : {}),
      signal: controller.signal,
      timeoutMs: 5000,
      onThread: (value) => threads.push(value),
      onEvent: (value) => events.push(value),
      onApproval: (card) => { cards.push(card); return scenario !== "resume"; },
      onDelta: (value) => { deltas.push(value); if (value === "started") controller.abort(); },
    });
    if (scenario === "disconnect") await assert.rejects(operation, /已退出/);
    else if (scenario === "interrupt") await assert.rejects(operation, /操作已停止/);
    else if (scenario === "full") {
      assert.deepEqual(await operation, { finalResponse: "Done" });
      assert.deepEqual(cards, []);
    }
    else {
      assert.deepEqual(await operation, { finalResponse: "Done" });
      assert.deepEqual(cards.map(({ kind }) => kind), ["command", "patch", "permissions"]);
      assert.match(cards[0].detail, /npm test[\s\S]*\.\.\/outside[\s\S]*example\.invalid/);
      assert.match(cards[1].detail, /\.git\/config[\s\S]*tests\/e2e\/electron-fixture\.mjs/);
      assert.match(cards[2].detail, /"enabled": true[\s\S]*"\.\.\/outside"/);
      assert.deepEqual(deltas, ["partial", ""]);
      assert.deepEqual(events.map(({ type }) => type), ["item.started", "item.started", "item.completed"]);
    }
    assert.deepEqual(threads, ["test-thread"]);
  });
}

