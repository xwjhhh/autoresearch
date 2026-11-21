import { parse } from "smol-toml";

const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parseActiveProvider(contents) {
  let config;
  try {
    config = parse(contents);
  } catch {
    return { error: "Codex 配置文件无法解析。" };
  }

  const providerId = typeof config.model_provider === "string" ? config.model_provider : "";
  const provider = config.model_providers?.[providerId] ?? {};
  const model = typeof config.model === "string" ? config.model : "";
  const name = typeof provider.name === "string" ? provider.name : providerId;
  const wireApi = typeof provider.wire_api === "string" ? provider.wire_api : "";
  let url;
  try {
    url = new URL(typeof provider.base_url === "string" ? provider.base_url : "");
  } catch {
    return { configFound: true, model, name, wireApi, provider, routingConfigured: false, providerBaseUrl: "" };
  }

  const local = localHosts.has(url.hostname.toLowerCase());
  const validBaseUrl = ["http:", "https:"].includes(url.protocol)
    && !url.username && !url.password && !url.search && !url.hash;
  const providerBaseUrl = validBaseUrl ? url.toString().replace(/\/+$/, "") : "";
  const routingConfigured = local && url.protocol === "http:" && wireApi === "responses" && Boolean(providerBaseUrl);
  return { configFound: true, model, name, wireApi, provider, routingConfigured, providerBaseUrl };
}

function readProviderApiKey(provider, env) {
  const token = typeof provider.experimental_bearer_token === "string" ? provider.experimental_bearer_token.trim() : "";
  if (token && token !== "PROXY_MANAGED") return token;
  const envKey = typeof provider.env_key === "string" ? provider.env_key.trim() : "";
  const envToken = envKey && typeof env[envKey] === "string" ? env[envKey].trim() : "";
  return envToken && envToken !== "PROXY_MANAGED" ? envToken : "";
}

export function readCodexProviderConfig(contents) {
  const active = parseActiveProvider(contents);
  if (active.error) return { configFound: true, routingConfigured: false, error: active.error };

  const { provider, name, model, wireApi, routingConfigured, providerBaseUrl } = active;
  const local = providerBaseUrl ? localHosts.has(new URL(providerBaseUrl).hostname.toLowerCase()) : false;
  let routingReason = "";
  if (!providerBaseUrl) {
    routingReason = "当前活动 Codex provider 没有可用的服务地址。请检查 CC Switch 中的 Codex 配置。";
  } else if (local && new URL(providerBaseUrl).protocol !== "http:") {
    routingReason = "当前本地服务不是 HTTP Routing 地址。请检查 CC Switch 的 Codex Routing 配置。";
  } else if (local && wireApi !== "responses") {
    routingReason = "当前本地 provider 未配置 Responses API。请检查 CC Switch 的 Codex Routing 配置。";
  }

  return {
    configFound: true,
    routingConfigured,
    model,
    provider: name,
    wireApi,
    providerBaseUrl,
    ...(routingReason ? { routingReason } : {}),
  };
}

export function readCodexProviderRuntimeConfig(contents, env = process.env) {
  const active = parseActiveProvider(contents);
  if (active.error) return { configFound: true, routingConfigured: false, error: active.error, apiKey: "" };
  const { provider, ...safe } = active;
  return { ...safe, apiKey: readProviderApiKey(provider, env) };
}

export async function isCcswitchHealthy(baseUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(new URL("/health", baseUrl), { signal: AbortSignal.timeout(1000) });
    const health = response.ok ? await response.json() : null;
    return health?.status === "healthy";
  } catch {
    return false;
  }
}

export function toResponsesBody(messages, model, reasoningEffort) {
  return {
    model,
    input: messages.map(({ role, content }) => ({ role, content })),
    temperature: 0.25,
    store: false,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
  };
}

export function extractResponsesText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const text = (data?.output ?? [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");
  return text || "";
}
