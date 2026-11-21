// 模型服务商：预设、校验和旧设置迁移。这里只有纯逻辑，不读写文件、不联网。
import { randomUUID } from "node:crypto";

/** "codex" 是保留 id：表示“跟随本机 Codex / CC Switch 的当前配置”，不存在服务商列表里。 */
export const CODEX_PROVIDER_ID = "codex";
export const PROTOCOLS = ["chat", "responses"];

export const PROVIDER_PRESETS = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", protocols: ["chat", "responses"], models: ["gpt-4.1", "gpt-4.1-mini"], help: "官方接口，同时支持 Chat Completions 和 Responses，可用于 Agent。" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", protocols: ["chat"], models: ["deepseek-chat", "deepseek-reasoner"], help: "官方接口只支持 Chat Completions，可用于论文分析和讨论，不能直接用于 Agent。" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", protocols: ["chat"], models: [], help: "聚合多家模型，模型名形如 openai/gpt-4.1。" },
  { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", protocols: ["chat"], models: [], help: "国内聚合服务，OpenAI 兼容。" },
  { id: "relay", name: "中转站", baseUrl: "", protocols: ["chat"], models: [], help: "填写中转站给你的地址（通常以 /v1 结尾）。如果中转站支持 /v1/responses，勾选 Responses 后可用于 Agent。" },
  { id: "custom", name: "自定义", baseUrl: "", protocols: ["chat"], models: [], help: "任何 OpenAI 兼容接口，例如本地 Ollama（http://127.0.0.1:11434/v1）。" },
];
const presetIds = new Set(PROVIDER_PRESETS.map((preset) => preset.id));

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_MODELS = 300;

export const makeProviderId = () => `p_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

function cleanText(value, max, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空。`);
  const clean = value.trim();
  if (clean.length > max) throw new Error(`${label}不能超过 ${max} 个字符。`);
  return clean;
}

/** 规范接口地址：只允许 http(s)，不带账号、查询串；用户粘贴了完整端点时去掉末尾的 /chat/completions 等。 */
export function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(cleanText(value, 300, "接口地址")); }
  catch (error) { throw error instanceof Error && error.message.includes("接口地址") ? error : new Error("接口地址格式无效，应形如 https://api.example.com/v1。"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("接口地址必须以 http:// 或 https:// 开头。");
  if (url.username || url.password) throw new Error("接口地址里不能包含账号或密码，请把密钥填在“API 密钥”里。");
  if (url.search || url.hash) throw new Error("接口地址不能带 ? 或 # 后面的参数。");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|models)$/i, "");
  return `${url.origin}${path}`;
}

/**
 * 清理用户粘贴的 API 密钥：去掉首尾空白、引号和多余的 "Bearer " 前缀。
 * 密钥会放进 HTTP 请求头，只能是可见的 ASCII 字符；混进中文、空格等时给出能看懂的提示。
 */
export function cleanApiKey(value) {
  let key = String(value ?? "").trim().replace(/^(['"])(.*)\1$/s, "$2").trim().replace(/^bearer\s+/i, "").trim();
  if (key.length > 2000) throw new Error("API 密钥太长了，可能把别的内容也粘贴进去了。请只粘贴密钥本身。");
  const bad = [...key].findIndex((char) => char.codePointAt(0) < 0x21 || char.codePointAt(0) > 0x7e);
  if (bad >= 0) {
    const char = [...key][bad];
    const shown = /\s/.test(char) ? "空格或换行" : `“${char}”`;
    throw new Error(`API 密钥第 ${bad + 1} 个字符是${shown}，密钥里不能有中文、空格或换行。请只粘贴密钥本身（通常以 sk- 开头）。`);
  }
  return key;
}

export function normalizeModels(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const models = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const model = item.trim();
    if (!model || model.length > 160 || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

export function normalizeProvider(input) {
  if (!input || typeof input !== "object") throw new Error("服务商设置无效。");
  const id = String(input.id ?? "");
  if (!ID_PATTERN.test(id) || id === CODEX_PROVIDER_ID) throw new Error("服务商编号无效。");
  const preset = presetIds.has(input.preset) ? input.preset : "custom";
  const protocols = PROTOCOLS.filter((protocol) => Array.isArray(input.protocols) && input.protocols.includes(protocol));
  if (!protocols.length) throw new Error("至少选择一种接口协议。");
  return {
    id,
    name: cleanText(input.name, 60, "名称"),
    preset,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    protocols,
    models: normalizeModels(input.models),
  };
}

const emptySelection = () => ({ providerId: CODEX_PROVIDER_ID, model: "" });

function cleanSelection(value) {
  if (!value || typeof value !== "object") return emptySelection();
  const providerId = typeof value.providerId === "string" ? value.providerId : CODEX_PROVIDER_ID;
  const model = typeof value.model === "string" ? value.model.trim().slice(0, 160) : "";
  return { providerId, model };
}

/** 读到的配置可能是手改的或旧版本写的：丢掉无效服务商，选择指向不存在的服务商时退回 Codex。 */
export function sanitizeLlmConfig(raw) {
  const providers = [];
  for (const item of Array.isArray(raw?.providers) ? raw.providers : []) {
    try {
      const provider = normalizeProvider(item);
      if (!providers.some((existing) => existing.id === provider.id)) providers.push(provider);
    } catch { /* 跳过无效条目，不影响其余服务商。 */ }
  }
  const fix = (selection, protocol) => {
    const clean = cleanSelection(selection);
    if (clean.providerId === CODEX_PROVIDER_ID) return { providerId: CODEX_PROVIDER_ID, model: "" };
    const provider = providers.find((item) => item.id === clean.providerId);
    if (!provider || (protocol && !provider.protocols.includes(protocol))) return emptySelection();
    return clean;
  };
  return { version: 1, providers, active: fix(raw?.active), agent: fix(raw?.agent, "responses") };
}

const presetForUrl = (baseUrl) => {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "api.openai.com") return "openai";
    if (host === "api.deepseek.com") return "deepseek";
    if (host === "openrouter.ai") return "openrouter";
    if (host === "api.siliconflow.cn") return "siliconflow";
  } catch { /* 无效地址按自定义处理 */ }
  return "custom";
};

/**
 * 把 0.6.1 及以前的单一“手动接口”设置迁移成服务商列表。
 * 返回 { llm, legacyKeyProviderId }：后者不为空时，调用方要把旧的 api-key.bin 复制给这个服务商。
 */
export function migrateLegacySettings(stored, { hasLegacyKey = false } = {}) {
  if (stored?.llm && Array.isArray(stored.llm.providers)) return { llm: sanitizeLlmConfig(stored.llm), legacyKeyProviderId: null };
  const providers = [];
  let manual = null;
  if (typeof stored?.baseUrl === "string" && stored.baseUrl.trim() && (hasLegacyKey || stored.providerMode === "manual")) {
    try {
      const baseUrl = normalizeBaseUrl(stored.baseUrl);
      const preset = presetForUrl(baseUrl);
      const model = typeof stored.model === "string" ? stored.model.trim() : "";
      manual = {
        id: "manual",
        name: preset === "custom" ? "手动接口" : PROVIDER_PRESETS.find((item) => item.id === preset).name,
        preset,
        baseUrl,
        protocols: ["chat"],
        models: normalizeModels(model ? [model] : []),
      };
      providers.push(manual);
    } catch { /* 旧地址无效时不迁移 */ }
  }
  const useManual = manual && manual.models.length && stored?.providerMode === "manual";
  return {
    llm: {
      version: 1,
      providers,
      active: useManual ? { providerId: manual.id, model: manual.models[0] } : emptySelection(),
      agent: emptySelection(),
    },
    legacyKeyProviderId: manual && hasLegacyKey ? manual.id : null,
  };
}

/** 一次性调用优先用 Chat Completions（兼容面最广）；Agent 只能用 Responses。 */
export function protocolFor(provider, kind) {
  if (kind === "agent") return provider.protocols.includes("responses") ? "responses" : null;
  return provider.protocols.includes("chat") ? "chat" : provider.protocols.includes("responses") ? "responses" : null;
}
