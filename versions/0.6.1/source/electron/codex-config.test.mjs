import test from "node:test";
import assert from "node:assert/strict";
import { extractResponsesText, isCcswitchHealthy, readCodexProviderConfig, readCodexProviderRuntimeConfig, toResponsesBody } from "./codex-config.mjs";

test("detects a local CC Switch Codex Routing provider without returning credentials", () => {
  const result = readCodexProviderConfig(`
model_provider = "custom"
model = "kimi-for-coding"
[model_providers.custom]
name = "Kimi"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
experimental_bearer_token = "PROXY_MANAGED"
`);

  assert.deepEqual(result, {
    configFound: true,
    routingConfigured: true,
    model: "kimi-for-coding",
    provider: "Kimi",
    wireApi: "responses",
    providerBaseUrl: "http://127.0.0.1:15721/v1",
  });
});

test("uses only the active Codex provider when other providers include local URLs", () => {
  const result = readCodexProviderConfig(`
model_provider = "custom"
model = "remote-model"
[model_providers.local]
name = "CC Switch"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
[model_providers.custom]
name = "Remote"
base_url = "https://api.example.com/v1"
wire_api = "responses"
`);

  assert.equal(result.routingConfigured, false);
  assert.equal(result.model, "remote-model");
  assert.equal(result.provider, "Remote");
  assert.equal(result.providerBaseUrl, "https://api.example.com/v1");
});

test("does not treat a remote custom Codex provider as CC Switch Routing", () => {
  const result = readCodexProviderConfig(`
model_provider = "custom"
model = "model-a"
[model_providers.custom]
name = "Custom"
base_url = "https://api.example.com/v1"
wire_api = "responses"
experimental_bearer_token = "private-value"
`);

  assert.equal(result.routingConfigured, false);
  assert.equal(JSON.stringify(result).includes("private-value"), false);
});

test("reads the active Codex provider credential only in the runtime config", () => {
  const contents = `
model_provider = "custom"
model = "model-a"
[model_providers.custom]
name = "ModCon"
base_url = "https://modcon.example/v1"
wire_api = "responses"
experimental_bearer_token = "private-value"
`;
  const safe = readCodexProviderConfig(contents);
  const runtime = readCodexProviderRuntimeConfig(contents, {});

  assert.equal(safe.providerBaseUrl, "https://modcon.example/v1");
  assert.equal(JSON.stringify(safe).includes("private-value"), false);
  assert.equal(runtime.apiKey, "private-value");
  assert.equal(JSON.stringify(runtime).includes('"experimental_bearer_token"'), false);
});

test("resolves provider credentials from the configured environment key", () => {
  const runtime = readCodexProviderRuntimeConfig(`
model_provider = "custom"
[model_providers.custom]
base_url = "https://modcon.example/v1"
wire_api = "responses"
env_key = "MODCON_TOKEN"
`, { MODCON_TOKEN: "env-secret" });

  assert.equal(runtime.apiKey, "env-secret");
});

test("checks the CC Switch health response without sending authentication", async () => {
  let requestedUrl = "";
  let sentAuthorization = false;
  const healthy = await isCcswitchHealthy("http://127.0.0.1:15721/v1", async (url, options) => {
    requestedUrl = url.toString();
    sentAuthorization = Boolean(options.headers?.Authorization);
    return { ok: true, json: async () => ({ status: "healthy" }) };
  });

  assert.equal(healthy, true);
  assert.equal(requestedUrl, "http://127.0.0.1:15721/health");
  assert.equal(sentAuthorization, false);
  assert.equal(await isCcswitchHealthy("http://127.0.0.1:15721/v1", async () => ({ ok: false })), false);
});

test("creates a Responses API request and reads its generated text", () => {
  assert.deepEqual(toResponsesBody([{ role: "user", content: "Hello" }], "model-a"), {
    model: "model-a",
    input: [{ role: "user", content: "Hello" }],
    temperature: 0.25,
    store: false,
  });
  assert.deepEqual(toResponsesBody([{ role: "user", content: "Hello" }], "model-a", "high"), {
    model: "model-a",
    input: [{ role: "user", content: "Hello" }],
    temperature: 0.25,
    store: false,
    reasoning: { effort: "high" },
  });
  assert.equal(extractResponsesText({ output: [{ content: [{ type: "output_text", text: " Ready " }] }] }), "Ready");
});
