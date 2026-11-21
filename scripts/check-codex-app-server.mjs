import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppServer, runCodexAppServer } from "../electron/codex-app-server.mjs";
import { runCommand } from "../electron/iteration-github.mjs";
import { withIterationEnvironment } from "../electron/iteration-runtime.mjs";

const root = await mkdtemp(join(await realpath(tmpdir()), "ar-codex-contract-"));
const codexHome = join(root, "codex-home"), workingDirectory = join(root, "workspace"), types = join(root, "protocol");
let hold = false;
let requestApproval = null;
const requestedPermissions = { network: { enabled: true } };
const received = [];
const server = createServer(async (request, reply) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.method !== "POST" || request.url !== "/responses") { reply.writeHead(404).end(); return; }
  received.push(JSON.parse(Buffer.concat(chunks)));
  const counter = received.length;
  const approval = requestApproval;
  const tools = received.at(-1).tools;
  const tool = approval === "permissions"
    ? tools.find(({ name }) => name === "request_permissions")
    : ["command", "full-command"].includes(approval) ? tools.find(({ name }) => ["shell_command", "exec_command"].includes(name)) : null;
  if (approval && !tool) { reply.writeHead(400).end(`Missing ${approval} tool`); return; }
  requestApproval = null;
  const args = approval === "permissions"
    ? { permissions: requestedPermissions, justification: "Synthetic network permission contract" }
    : approval === "full-command" ? { [tool?.name === "exec_command" ? "cmd" : "command"]: "echo AR_FULL_COMMAND_RAN", workdir: workingDirectory }
    : { [tool?.name === "exec_command" ? "cmd" : "command"]: "pwd", workdir: workingDirectory, sandbox_permissions: "require_escalated", justification: "Synthetic command approval contract" };
  const item = tool
    ? { type: "function_call", id: `fc_${counter}`, call_id: `call_${counter}`, name: tool.name, arguments: JSON.stringify(args), status: "completed" }
    : { type: "message", id: `msg_${counter}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Contract OK", annotations: [] }] };
  const response = { id: `resp_${counter}`, output: [item], status: "completed", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
  reply.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, fields) => reply.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  send("response.created", { response: { ...response, output: [], status: "in_progress" } });
  send("response.output_item.added", { output_index: 0, item: { ...item, content: [], status: "in_progress" } });
  if (!tool) send("response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: "Contract OK" });
  if (hold) return;
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", { response });
  reply.end();
});

try {
  await Promise.all([codexHome, workingDirectory, types].map((path) => mkdir(path)));
  await mkdir(join(workingDirectory, ".codex"));
  await writeFile(join(workingDirectory, ".codex", "config.toml"), 'developer_instructions = "AR_TRUSTED_PROJECT_CONFIG"\n');
  await mkdir(join(workingDirectory, ".agents", "skills", "contract-skill"), { recursive: true });
  await writeFile(join(workingDirectory, ".agents", "skills", "contract-skill", "SKILL.md"), '---\nname: contract-skill\ndescription: AR_PROJECT_SKILL_DISCOVERED\n---\n\nSynthetic skill.\n');
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await withIterationEnvironment(async (baseEnv) => {
    const executable = await resolveAppServer(baseEnv);
    const version = (await runCommand(executable, ["--version"], { env: baseEnv, timeout: 5000 })).trim();
    const proxy = "http://127.0.0.1:1";
    const env = { ...baseEnv, HOME: root, USERPROFILE: root, CODEX_HOME: codexHome, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: "127.0.0.1" };
    await runCommand(executable, ["app-server", "generate-ts", "--out", types], { env, cwd: root, timeout: 20000 });
    const checkType = async (name, pattern) => assert.match(await readFile(join(types, `${name}.ts`), "utf8"), pattern);
    await checkType("ClientRequest", /"thread\/resume"[\s\S]*"turn\/start"[\s\S]*"turn\/interrupt"/);
    await checkType("ServerRequest", /"item\/commandExecution\/requestApproval"/);
    await checkType("ServerRequest", /"item\/fileChange\/requestApproval"/);
    await checkType("ServerRequest", /"item\/permissions\/requestApproval"/);
    await checkType("v2/PermissionsRequestApprovalResponse", /permissions: GrantedPermissionProfile, scope: PermissionGrantScope/);
    await checkType("ServerNotification", /"item\/agentMessage\/delta"/);
    await checkType("ServerNotification", /"turn\/completed"/);
    await checkType("v2/SandboxPolicy", /"workspaceWrite"[^}]*networkAccess: boolean/);
    await checkType("v2/ThreadResumeParams", /excludeTurns\?: boolean/);
    await checkType("v2/SandboxPolicy", /"dangerFullAccess"/);
    await checkType("v2/AskForApproval", /"never"/);
    await checkType("v2/SandboxMode", /"danger-full-access"/);

    const model = "gpt-5.2-codex";
    const options = { executable, workingDirectory, codexHome, env, model, timeoutMs: 30000,
      configOverrides: { model_provider: "contract", model_providers: { contract: { name: "Loopback", base_url: `http://127.0.0.1:${server.address().port}`, wire_api: "responses", stream_max_retries: 0 } } },
    };
    let threadId;
    const deltas = [];
    const result = await runCodexAppServer("First contract turn", { ...options, onThread: (id) => { threadId = id; }, onDelta: (delta) => deltas.push(delta) });
    assert.ok(threadId);
    assert.deepEqual(result, { finalResponse: "Contract OK" });
    assert.ok(deltas.some((delta) => delta.includes("Contract OK")));
    assert.equal(received[0].model, model);
    assert.deepEqual(await runCodexAppServer("Second contract turn", { ...options, threadId, onThread: (id) => assert.equal(id, threadId) }), result);
    assert.match(JSON.stringify(received[1].input), /First contract turn/);

    hold = true;
    const controller = new AbortController();
    await assert.rejects(runCodexAppServer("Interrupt contract turn", { ...options, threadId, signal: controller.signal, onDelta: (delta) => { if (delta) controller.abort(); } }), /操作已停止/);
    assert.equal(received.length, 3);

    hold = false;
    for (const kind of ["command", "permissions"]) {
      requestApproval = kind;
      const approvals = [];
      assert.deepEqual(await runCodexAppServer("Approval contract turn", { ...options, onApproval: (card) => { approvals.push(card); return kind === "permissions"; } }), result);
      const outputs = received.at(-1).input.filter(({ type }) => type === "function_call_output");
      assert.deepEqual(approvals.map((card) => card.kind), [kind], JSON.stringify(outputs));
      assert.match(approvals[0].detail, kind === "command" ? /pwd/ : /"enabled": true/);
      if (kind === "permissions") {
        const granted = JSON.parse(outputs.at(-1).output);
        assert.equal(granted.permissions.network.enabled, true);
        assert.equal(granted.scope, "turn");
      }
    }
    assert.equal(received.length, 7);
    await runCommand("git", ["init", "--quiet"], { cwd: workingDirectory, env });
    const imagePath = join(root, "contract.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAF0lEQVR4nGNUifZkYGBgYGBgYoABBAsAFjMAzjCHkQ4AAAAASUVORK5CYII=", "base64"));
    requestApproval = "full-command";
    assert.deepEqual(await runCodexAppServer("Full contract turn", { ...options, access: "full", imagePaths: [imagePath], onApproval: () => assert.fail("Full mode should run directly") }), result);
    assert.match(JSON.stringify(received[7].input), /AR_TRUSTED_PROJECT_CONFIG/);
    assert.match(JSON.stringify(received[7].input), /AR_PROJECT_SKILL_DISCOVERED/);
    assert.ok(received[7].input.some((item) => item.content?.some((part) => part.type === "input_image" && part.image_url?.startsWith("data:image/"))));
    const output = received.at(-1).input.find(({ type }) => type === "function_call_output");
    assert.match(output?.output ?? "", /AR_FULL_COMMAND_RAN/);
    console.log(`${version} (${executable}): generated types, lifecycle, native approval, direct execution, project config and skills verified against loopback.`);
  });
} finally {
  server.closeAllConnections();
  server.close();
  await rm(root, { recursive: true, force: true });
}
