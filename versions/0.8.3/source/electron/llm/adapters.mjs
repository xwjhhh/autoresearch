// 两种 OpenAI 兼容协议的请求适配：Chat Completions 和 Responses，以及获取模型列表。
// 只负责拼请求、发请求、取文本、把错误整理成可读信息；用哪个服务商由 service.mjs 决定。
import { extractResponsesText } from "../codex-config.mjs";
import { safeError } from "../retry.mjs";

/** HTTP 接口只认这几档；Codex 专有的更高档位按 high 发送。 */
const HTTP_EFFORTS = new Set(["minimal", "low", "medium", "high"]);
export function httpReasoningEffort(effort) {
  if (!effort) return undefined;
  return HTTP_EFFORTS.has(effort) ? effort : "high";
}

export function endpointFor(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${path}`;
}

const authHeaders = (apiKey) => {
  // 已保存的旧密钥可能含中文或空格；fetch 会报难懂的 ByteString 错误，这里先给出能看懂的提示。
  if (apiKey && /[^\x21-\x7e]/.test(apiKey)) throw Object.assign(new Error("保存的 API 密钥里有中文、空格或换行，请在“模型服务商”里重新粘贴密钥（只粘贴密钥本身）。"), { permanent: true });
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
};

export function buildChatBody({ model, messages, temperature, reasoningEffort }) {
  return {
    model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    ...(temperature === undefined ? {} : { temperature }),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}

export function buildResponsesBody({ model, messages, temperature, reasoningEffort }) {
  return {
    model,
    input: messages.map(({ role, content }) => ({ role, content })),
    store: false,
    ...(temperature === undefined ? {} : { temperature }),
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
  };
}

export function chatText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === "string" ? part.text : "").join("").trim();
  return "";
}

/** 有些模型（如推理模型）不接受 temperature 或 reasoning_effort，返回 400 时去掉这两个参数再试一次。 */
const UNSUPPORTED_OPTION = /temperature|reasoning|unsupported (?:parameter|value)|not support|不支持/i;

function httpError(label, status, detail) {
  const text = safeError(detail || "").slice(0, 400);
  const hint = status === 401 || status === 403 ? "（请检查 API 密钥）"
    : status === 404 ? "（请检查接口地址和模型名称；中转站地址通常以 /v1 结尾）"
    : status === 429 ? "（请求过于频繁或额度不足）" : "";
  return Object.assign(new Error(`${label} 返回 ${status}${hint}：${text || "没有错误详情"}`), { status });
}

async function send(fetchImpl, url, init, label, signal) {
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (signal?.aborted && signal.reason?.name !== "TimeoutError") throw signal.reason ?? error;
    if (error?.name === "TimeoutError" || signal?.reason?.name === "TimeoutError") throw new Error(`${label} 请求超时。`);
    throw new Error(`${label} 连接失败：${safeError(error?.message ?? error)}`);
  }
}

/**
 * 发一次模型调用。connection: { baseUrl, apiKey, model, protocol, label }。
 * 返回 { content }。
 */
export async function complete(connection, messages, { temperature = 0.25, reasoningEffort, timeoutMs = 120_000, signal, fetchImpl = fetch } = {}) {
  const { baseUrl, apiKey, model, protocol, label = model } = connection;
  const isResponses = protocol === "responses";
  const url = endpointFor(baseUrl, isResponses ? "responses" : "chat/completions");
  const effort = httpReasoningEffort(reasoningEffort);
  const timeout = AbortSignal.timeout(Math.max(1_000, timeoutMs));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const build = (options) => JSON.stringify((isResponses ? buildResponsesBody : buildChatBody)({ model, messages, ...options }));

  let response = await send(fetchImpl, url, { method: "POST", headers: authHeaders(apiKey), body: build({ temperature, reasoningEffort: effort }) }, label, combined);
  if (response.status === 400 && (temperature !== undefined || effort)) {
    const detail = await response.text();
    if (!UNSUPPORTED_OPTION.test(detail)) throw httpError(label, 400, detail);
    response = await send(fetchImpl, url, { method: "POST", headers: authHeaders(apiKey), body: build({}) }, label, combined);
  }
  if (!response.ok) throw httpError(label, response.status, await response.text());
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${label} 返回的不是 JSON，请检查接口地址是否正确。`); }
  const content = isResponses ? extractResponsesText(data) : chatText(data);
  if (!content) throw new Error(`${label} 没有返回可读文本。${isResponses ? "" : "如果这是推理模型，可以换成对应的对话模型再试。"}`);
  return { content };
}

/** GET {baseUrl}/models。OpenAI、DeepSeek 和大多数中转站都支持。 */
export async function listModels({ baseUrl, apiKey, label = "接口" }, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const response = await send(fetchImpl, endpointFor(baseUrl, "models"), { method: "GET", headers: authHeaders(apiKey) }, label, AbortSignal.timeout(timeoutMs));
  if (!response.ok) throw httpError(label, response.status, await response.text());
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${label} 的模型列表不是 JSON，请检查接口地址。`); }
  const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const ids = items.map((item) => typeof item === "string" ? item : item?.id ?? item?.name).filter((id) => typeof id === "string" && id.trim());
  return [...new Set(ids.map((id) => id.trim()))].sort((a, b) => a.localeCompare(b));
}
