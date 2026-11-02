import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanApiKey, migrateLegacySettings, normalizeBaseUrl, normalizeProvider, protocolFor, sanitizeLlmConfig } from "./llm/providers.mjs";
import { complete, httpReasoningEffort, listModels } from "./llm/adapters.mjs";
import { AGENT_KEY_ENV, LlmService } from "./llm/service.mjs";

// ---------------------------------------------------------------- 测试工具
const jsonResponse = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call, calls.length);
  };
  return Object.assign(impl, { calls });
}

// 用可逆的假加密代替 safeStorage，确保写到磁盘的不是明文。
const fakeSecrets = { available: () => true, encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).toString("base64")}`), decrypt: (data) => Buffer.from(String(data).slice(4), "base64").toString() };

function makeService(root, { fetchImpl, codexStatus, runCodexOnce } = {}) {
  return new LlmService({
    settingsPath: join(root, "settings.json"),
    keysDir: join(root, "provider-keys"),
    legacyKeyPath: join(root, "api-key.bin"),
    secrets: fakeSecrets,
    readCodexStatus: async () => codexStatus ?? { ccswitch: {}, codexSdk: {}, runtime: null },
    runCodexOnce: runCodexOnce ?? (async () => { throw new Error("must not call Codex"); }),
    fetchImpl: fetchImpl ?? fakeFetch(() => jsonResponse(500, "unexpected")),
  });
}

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), "autoresearch-llm-"));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const deepseek = { id: "ds", name: "DeepSeek", preset: "deepseek", baseUrl: "https://api.deepseek.com", protocols: ["chat"], models: ["deepseek-chat", "deepseek-reasoner"] };
const relay = { id: "relay", name: "中转站", preset: "relay", baseUrl: "https://relay.example/v1", protocols: ["chat", "responses"], models: ["gpt-4.1", "claude-sonnet"] };

// ---------------------------------------------------------------- providers.mjs
test("normalizes pasted endpoints back to a base URL and rejects credentials in the URL", () => {
  assert.equal(normalizeBaseUrl("https://relay.example/v1/"), "https://relay.example/v1");
  assert.equal(normalizeBaseUrl(" https://relay.example/v1/chat/completions "), "https://relay.example/v1");
  assert.equal(normalizeBaseUrl("https://api.openai.com/v1/responses"), "https://api.openai.com/v1");
  assert.equal(normalizeBaseUrl("https://api.deepseek.com"), "https://api.deepseek.com");
  assert.throws(() => normalizeBaseUrl("ftp://x.example"), /http/);
  assert.throws(() => normalizeBaseUrl("https://user:pass@x.example/v1"), /账号或密码/);
  assert.throws(() => normalizeBaseUrl("https://x.example/v1?key=abc"), /参数/);
  assert.throws(() => normalizeBaseUrl("not a url"), /格式无效/);
});

test("cleans pasted API keys and explains non-ASCII characters instead of failing in fetch", () => {
  assert.equal(cleanApiKey("  sk-abc123  "), "sk-abc123");
  assert.equal(cleanApiKey('"sk-abc123"'), "sk-abc123");
  assert.equal(cleanApiKey("Bearer sk-abc123"), "sk-abc123");
  assert.throws(() => cleanApiKey("模型密钥：sk-abc123"), /第 1 个字符是“模”/);
  assert.throws(() => cleanApiKey("sk-abc 123"), /第 7 个字符是空格或换行/);
  assert.throws(() => cleanApiKey("sk-" + "a".repeat(2100)), /太长/);
});

test("a stored key with Chinese characters gives a readable error before any request", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { data: [] }));
  await assert.rejects(listModels({ baseUrl: "https://relay.example/v1", apiKey: "模型sk-abc" }, { fetchImpl }), /重新粘贴密钥/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("saving a provider with a bad key is refused and nothing is written", () => withRoot(async (root) => {
  const service = makeService(root);
  await assert.rejects(service.saveProvider({ ...deepseek, apiKey: "模型 sk-abc" }), /不能有中文/);
  assert.equal(existsSync(join(root, "provider-keys", "ds.bin")), false);
  assert.equal((await service.state()).providers.length, 0);
}));

test("validates providers: reserved id, protocols and de-duplicated models", () => {
  assert.throws(() => normalizeProvider({ ...deepseek, id: "codex" }), /编号无效/);
  assert.throws(() => normalizeProvider({ ...deepseek, protocols: [] }), /协议/);
  const provider = normalizeProvider({ ...deepseek, preset: "unknown", models: [" deepseek-chat ", "deepseek-chat", "", 3] });
  assert.equal(provider.preset, "custom");
  assert.deepEqual(provider.models, ["deepseek-chat"]);
});

test("one-shot calls prefer Chat Completions; agents require Responses", () => {
  assert.equal(protocolFor(relay, "complete"), "chat");
  assert.equal(protocolFor({ ...relay, protocols: ["responses"] }, "complete"), "responses");
  assert.equal(protocolFor(relay, "agent"), "responses");
  assert.equal(protocolFor(deepseek, "agent"), null);
});

test("sanitizing drops broken providers and resets selections that point at missing or non-Responses providers", () => {
  const llm = sanitizeLlmConfig({ providers: [deepseek, { id: "bad" }], active: { providerId: "gone", model: "x" }, agent: { providerId: "ds", model: "deepseek-chat" } });
  assert.deepEqual(llm.providers.map((item) => item.id), ["ds"]);
  assert.deepEqual(llm.active, { providerId: "codex", model: "" });
  assert.deepEqual(llm.agent, { providerId: "codex", model: "" });
});

test("migrates the 0.6.1 manual interface into a provider and keeps auto users on Codex", () => {
  const manual = migrateLegacySettings({ providerMode: "manual", baseUrl: "https://api.deepseek.com/", model: "deepseek-chat" }, { hasLegacyKey: true });
  assert.equal(manual.legacyKeyProviderId, "manual");
  assert.equal(manual.llm.providers[0].name, "DeepSeek");
  assert.deepEqual(manual.llm.active, { providerId: "manual", model: "deepseek-chat" });

  const auto = migrateLegacySettings({ providerMode: "auto", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" }, { hasLegacyKey: true });
  assert.equal(auto.llm.providers.length, 1, "保留手动接口，方便以后切换");
  assert.deepEqual(auto.llm.active, { providerId: "codex", model: "" });

  const fresh = migrateLegacySettings({ baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" }, { hasLegacyKey: false });
  assert.equal(fresh.llm.providers.length, 0, "默认地址且没有密钥时不生成服务商");
  assert.equal(fresh.legacyKeyProviderId, null);
});

// ---------------------------------------------------------------- adapters.mjs
test("sends Chat Completions with bearer auth and reads the reply", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { choices: [{ message: { content: " 你好 " } }] }));
  const result = await complete({ baseUrl: "https://api.deepseek.com", apiKey: "sk-test", model: "deepseek-chat", protocol: "chat" }, [{ role: "system", content: "s" }, { role: "user", content: "u" }], { reasoningEffort: "xhigh", fetchImpl });
  assert.equal(result.content, "你好");
  const [call] = fetchImpl.calls;
  assert.equal(call.url, "https://api.deepseek.com/chat/completions");
  assert.equal(call.headers.Authorization, "Bearer sk-test");
  assert.deepEqual(call.body, { model: "deepseek-chat", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], temperature: 0.25, reasoning_effort: "high" });
});

test("sends Responses requests and omits auth when no key is set", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { output: [{ content: [{ type: "output_text", text: "结果" }] }] }));
  const result = await complete({ baseUrl: "http://127.0.0.1:15721/v1", apiKey: "", model: "gpt-5", protocol: "responses" }, [{ role: "user", content: "u" }], { fetchImpl });
  assert.equal(result.content, "结果");
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:15721/v1/responses");
  assert.equal(fetchImpl.calls[0].headers.Authorization, undefined);
  assert.equal(fetchImpl.calls[0].body.store, false);
});

test("retries once without temperature/reasoning when the model rejects them", async () => {
  const fetchImpl = fakeFetch((_call, index) => index === 1
    ? jsonResponse(400, { error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } })
    : jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
  const result = await complete({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "o3", protocol: "chat" }, [{ role: "user", content: "u" }], { reasoningEffort: "low", fetchImpl });
  assert.equal(result.content, "ok");
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(Object.keys(fetchImpl.calls[1].body).sort(), ["messages", "model"]);
});

test("reports HTTP errors with a hint and hides keys from the message", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(401, { error: { message: "Incorrect API key provided: sk-abcdefgh12345678" } }));
  await assert.rejects(
    complete({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4.1", protocol: "chat", label: "OpenAI · gpt-4.1" }, [{ role: "user", content: "u" }], { fetchImpl }),
    (error) => error.status === 401 && /OpenAI · gpt-4\.1 返回 401（请检查 API 密钥）/.test(error.message) && !error.message.includes("sk-abcdefgh12345678"),
  );
});

test("lists models from the OpenAI-style data array", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { data: [{ id: "gpt-4.1" }, { id: "deepseek-chat" }, { id: "gpt-4.1" }] }));
  const models = await listModels({ baseUrl: "https://relay.example/v1", apiKey: "k" }, { fetchImpl });
  assert.deepEqual(models, ["deepseek-chat", "gpt-4.1"]);
  assert.equal(fetchImpl.calls[0].url, "https://relay.example/v1/models");
  assert.equal(fetchImpl.calls[0].method, "GET");
});

test("caps Codex-only reasoning levels at high for HTTP APIs", () => {
  assert.equal(httpReasoningEffort("medium"), "medium");
  assert.equal(httpReasoningEffort("ultra"), "high");
  assert.equal(httpReasoningEffort(undefined), undefined);
});

// ---------------------------------------------------------------- service.mjs
test("migration copies the legacy key, keeps the old file and other settings", () => withRoot(async (root) => {
  writeFileSync(join(root, "settings.json"), JSON.stringify({ providerMode: "manual", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", workspacePath: "D:/data", reasoningEffort: "high" }));
  writeFileSync(join(root, "api-key.bin"), fakeSecrets.encrypt("sk-legacy"));
  const service = makeService(root);
  const state = await service.state();
  assert.deepEqual(state.active, { providerId: "manual", model: "deepseek-chat" });
  assert.equal(state.providers[0].hasKey, true);
  assert.equal(await service.readKey("manual"), "sk-legacy");
  assert.ok(existsSync(join(root, "api-key.bin")), "旧密钥文件保留");
  const stored = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
  assert.equal(stored.workspacePath, "D:/data");
  assert.equal(stored.reasoningEffort, "high");
}));

test("state never exposes API keys; keys are stored encrypted per provider", () => withRoot(async (root) => {
  const service = makeService(root);
  await service.saveProvider({ ...deepseek, apiKey: "sk-deepseek-secret" });
  const state = await service.state();
  assert.equal(JSON.stringify(state).includes("sk-deepseek-secret"), false);
  assert.equal(state.providers[0].hasKey, true);
  assert.equal(readFileSync(join(root, "provider-keys", "ds.bin"), "utf8").includes("sk-deepseek-secret"), false);
  assert.equal(readFileSync(join(root, "settings.json"), "utf8").includes("sk-deepseek-secret"), false);
}));

test("one-shot calls go to the selected provider and model", () => withRoot(async (root) => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { choices: [{ message: { content: "回答" } }] }));
  const service = makeService(root, { fetchImpl });
  await service.saveProvider({ ...deepseek, apiKey: "sk-ds" });
  await service.saveProvider({ ...relay, apiKey: "sk-relay" });
  await service.select("active", { providerId: "ds", model: "deepseek-chat" });
  assert.deepEqual(await service.complete([{ role: "user", content: "q" }]), { content: "回答", source: "DeepSeek · deepseek-chat" });
  await service.select("active", { providerId: "relay", model: "claude-sonnet" });
  await service.complete([{ role: "user", content: "q" }]);
  const [first, second] = fetchImpl.calls;
  assert.equal(first.url, "https://api.deepseek.com/chat/completions");
  assert.equal(first.headers.Authorization, "Bearer sk-ds");
  assert.equal(second.url, "https://relay.example/v1/chat/completions");
  assert.equal(second.body.model, "claude-sonnet");
  assert.equal(second.headers.Authorization, "Bearer sk-relay");
}));

test("selection is validated: unknown models and non-Responses agents are refused", () => withRoot(async (root) => {
  const service = makeService(root);
  await service.saveProvider(deepseek);
  await assert.rejects(service.select("active", { providerId: "ds", model: "gpt-4.1" }), /添加这个模型/);
  await assert.rejects(service.select("agent", { providerId: "ds", model: "deepseek-chat" }), /Responses/);
  await assert.rejects(service.select("active", { providerId: "nope", model: "x" }), /不存在/);
}));

test("deleting the selected provider falls back to Codex and removes its key", () => withRoot(async (root) => {
  const service = makeService(root);
  await service.saveProvider({ ...relay, apiKey: "sk-relay" });
  await service.select("active", { providerId: "relay", model: "gpt-4.1" });
  await service.select("agent", { providerId: "relay", model: "gpt-4.1" });
  await service.deleteProvider("relay");
  const state = await service.state();
  assert.deepEqual(state.active, { providerId: "codex", model: "" });
  assert.deepEqual(state.agent, { providerId: "codex", model: "" });
  assert.equal(existsSync(join(root, "provider-keys", "relay.bin")), false);
}));

test("removing the selected model from a provider moves the selection to its first model", () => withRoot(async (root) => {
  const service = makeService(root);
  await service.saveProvider(relay);
  await service.select("active", { providerId: "relay", model: "claude-sonnet" });
  await service.saveProvider({ ...relay, models: ["gpt-4.1"] });
  assert.deepEqual((await service.state()).active, { providerId: "relay", model: "gpt-4.1" });
}));

test("Codex mode uses CC Switch routing over HTTP, then the Codex CLI, then fails clearly", () => withRoot(async (root) => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { output_text: "经由 Routing" }));
  const routed = makeService(root, { fetchImpl, codexStatus: { ccswitch: { routingAvailable: true, baseUrl: "http://127.0.0.1:15721/v1", model: "gpt-5" }, codexSdk: { cliAvailable: true }, runtime: null } });
  assert.deepEqual(await routed.complete([{ role: "user", content: "q" }]), { content: "经由 Routing", source: "CC Switch · gpt-5" });
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:15721/v1/responses");

  let cliCalls = 0;
  const cli = makeService(root, { codexStatus: { ccswitch: { model: "gpt-5" }, codexSdk: { cliAvailable: true, authAvailable: true }, runtime: null }, runCodexOnce: async () => { cliCalls += 1; return { content: "经由 CLI" }; } });
  assert.deepEqual(await cli.complete([{ role: "user", content: "q" }]), { content: "经由 CLI", source: "Codex CLI · gpt-5" });
  assert.equal(cliCalls, 1);

  const loggedOut = makeService(root, { codexStatus: { ccswitch: {}, codexSdk: { cliAvailable: true, configAvailable: false, authAvailable: false }, runtime: null } });
  await assert.rejects(loggedOut.complete([{ role: "user", content: "q" }]), /没有可用的 Codex 配置/, "CLI 没登录时不应去跑 CLI");

  const none = makeService(root, { codexStatus: { ccswitch: { routingReason: "健康检查未通过。" }, codexSdk: { cliAvailable: false }, runtime: null } });
  await assert.rejects(none.complete([{ role: "user", content: "q" }]), /健康检查未通过。请在“模型服务商”里添加/);
}));

test("agent runtime injects the selected Responses provider and keeps the key in env only", () => withRoot(async (root) => {
  const service = makeService(root);
  assert.deepEqual(await service.agentRuntime(), { label: "跟随 Codex 配置" });
  await service.saveProvider({ ...relay, apiKey: "sk-relay" });
  await service.select("agent", { providerId: "relay", model: "gpt-4.1" });
  const runtime = await service.agentRuntime();
  assert.equal(runtime.model, "gpt-4.1");
  assert.equal(runtime.configOverrides.model_provider, "autoresearch");
  assert.deepEqual(runtime.configOverrides.model_providers.autoresearch, { name: "中转站", base_url: "https://relay.example/v1", wire_api: "responses", env_key: AGENT_KEY_ENV });
  assert.deepEqual(runtime.env, { [AGENT_KEY_ENV]: "sk-relay" });
  assert.equal(JSON.stringify(runtime.configOverrides).includes("sk-relay"), false);
}));

test("listModels can use an unsaved draft key or the saved key", () => withRoot(async (root) => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { data: [{ id: "m1" }] }));
  const service = makeService(root, { fetchImpl });
  assert.deepEqual(await service.listModels({ baseUrl: "https://relay.example/v1/", apiKey: "sk-draft" }), ["m1"]);
  assert.equal(fetchImpl.calls[0].headers.Authorization, "Bearer sk-draft");
  await service.saveProvider({ ...relay, apiKey: "sk-saved" });
  await service.listModels({ providerId: "relay" });
  assert.equal(fetchImpl.calls[1].headers.Authorization, "Bearer sk-saved");
}));

test("concurrent writes from preferences and provider edits do not lose each other", () => withRoot(async (root) => {
  mkdirSync(root, { recursive: true });
  const service = makeService(root);
  await Promise.all([
    service.updatePreferences({ workspacePath: "E:/research" }),
    service.saveProvider(deepseek),
    service.updatePreferences({ reasoningEffort: "medium" }),
    service.saveProvider(relay),
  ]);
  const stored = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
  assert.equal(stored.workspacePath, "E:/research");
  assert.equal(stored.reasoningEffort, "medium");
  assert.deepEqual(stored.llm.providers.map((item) => item.id).sort(), ["ds", "relay"]);
}));
