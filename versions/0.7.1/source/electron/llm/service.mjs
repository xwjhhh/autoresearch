// 模型服务：保存服务商列表和当前选择，按选择发起调用，给 Codex Agent 生成注入配置。
// 所有对 settings.json 的写入都经过这里串行执行，避免并发写坏文件。
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { complete as adapterComplete, listModels as adapterListModels } from "./adapters.mjs";
import {
  CODEX_PROVIDER_ID, PROVIDER_PRESETS, cleanApiKey, makeProviderId, migrateLegacySettings, normalizeBaseUrl,
  normalizeProvider, protocolFor, sanitizeLlmConfig,
} from "./providers.mjs";

/** 注入给 Codex 的 provider 名称和密钥变量名；变量名含 KEY，Codex 默认不会把它传给 agent 执行的命令。 */
export const AGENT_PROVIDER_NAME = "autoresearch";
export const AGENT_KEY_ENV = "AUTORESEARCH_AGENT_API_KEY";
const STATUS_TTL_MS = 15_000;

export class LlmService {
  /**
   * @param {object} deps
   * @param {string} deps.settingsPath settings.json
   * @param {string} deps.keysDir 每个服务商一个加密密钥文件
   * @param {string} [deps.legacyKeyPath] 0.6.1 及以前的 api-key.bin
   * @param {{ available(): boolean, encrypt(text: string): Buffer, decrypt(data: Buffer): string }} deps.secrets
   * @param {() => Promise<object>} deps.readCodexStatus CC Switch / Codex 配置探测，返回 { ccswitch, codexSdk, runtime }
   * @param {(messages: object[], options: object) => Promise<{ content: string }>} deps.runCodexOnce 用 Codex CLI 跑一次纯文本调用
   * @param {typeof fetch} [deps.fetchImpl]
   */
  constructor({ settingsPath, keysDir, legacyKeyPath, secrets, readCodexStatus, runCodexOnce, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { settingsPath, keysDir, legacyKeyPath, secrets, readCodexStatus, runCodexOnce, fetchImpl, now });
    this.cache = null;
    this.keyCache = new Map();
    this.queue = Promise.resolve();
    this.status = null;
  }

  serialize(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async readFileJson() {
    try { return JSON.parse(await readFile(this.settingsPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }

  async writeFileJson(value) {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(this.settingsPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  async loadUnlocked() {
    if (this.cache) return this.cache;
    const stored = await this.readFileJson();
    if (stored.llm && Array.isArray(stored.llm.providers)) {
      this.cache = sanitizeLlmConfig(stored.llm);
      return this.cache;
    }
    const hasLegacyKey = this.legacyKeyPath ? await readFile(this.legacyKeyPath).then(() => true, () => false) : false;
    const { llm, legacyKeyProviderId } = migrateLegacySettings(stored, { hasLegacyKey });
    if (legacyKeyProviderId) {
      await mkdir(this.keysDir, { recursive: true });
      // 复制而不是移动：旧文件留着，回退到旧版本时仍然可用。
      await copyFile(this.legacyKeyPath, this.keyPath(legacyKeyProviderId));
    }
    await this.writeFileJson({ ...stored, llm });
    this.cache = sanitizeLlmConfig(llm);
    return this.cache;
  }

  load() {
    return this.cache ? Promise.resolve(this.cache) : this.serialize(() => this.loadUnlocked());
  }

  mutate(change) {
    return this.serialize(async () => {
      const current = structuredClone(await this.loadUnlocked());
      const next = sanitizeLlmConfig(change(current) ?? current);
      const stored = await this.readFileJson();
      await this.writeFileJson({ ...stored, llm: next });
      this.cache = next;
      return next;
    });
  }

  /** 思考强度、导入后自动分析等其他设置也写在 settings.json 里，同样串行写入。 */
  updatePreferences(patch) {
    return this.serialize(async () => {
      const stored = await this.readFileJson();
      const next = { ...stored, ...patch };
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
      await this.writeFileJson(next);
      return next;
    });
  }

  readPreferences() {
    return this.readFileJson();
  }

  // ---------------------------------------------------------------- 密钥
  keyPath(providerId) {
    return join(this.keysDir, `${providerId}.bin`);
  }

  async readKey(providerId) {
    if (this.keyCache.has(providerId)) return this.keyCache.get(providerId);
    let key = "";
    try {
      const data = await readFile(this.keyPath(providerId));
      if (this.secrets.available()) key = this.secrets.decrypt(data);
    } catch { /* 没有保存密钥 */ }
    this.keyCache.set(providerId, key);
    return key;
  }

  async hasKey(providerId) {
    return readFile(this.keyPath(providerId)).then(() => true, () => false);
  }

  async writeKey(providerId, apiKey) {
    if (!this.secrets.available()) throw new Error("系统凭据加密不可用，暂时无法安全保存 API 密钥。");
    await mkdir(this.keysDir, { recursive: true });
    await writeFile(this.keyPath(providerId), this.secrets.encrypt(apiKey));
    this.keyCache.set(providerId, apiKey);
  }

  async deleteKey(providerId) {
    await rm(this.keyPath(providerId), { force: true });
    this.keyCache.delete(providerId);
  }

  // ---------------------------------------------------------------- Codex 探测（缓存 15 秒，避免每次调用都做健康检查）
  async codexStatus({ refresh = false } = {}) {
    if (!refresh && this.status && this.now() - this.status.at < STATUS_TTL_MS) return this.status.value;
    const value = await this.readCodexStatus().catch(() => ({ ccswitch: {}, codexSdk: {}, runtime: null }));
    this.status = { at: this.now(), value };
    return value;
  }

  // ---------------------------------------------------------------- 给界面的状态
  async state({ refresh = false } = {}) {
    const llm = await this.load();
    const status = await this.codexStatus({ refresh });
    const providers = await Promise.all(llm.providers.map(async (provider) => ({ ...provider, hasKey: await this.hasKey(provider.id) })));
    const ccswitch = status.ccswitch ?? {};
    const codexSdk = status.codexSdk ?? {};
    const httpRoute = ccswitch.routingAvailable ? "routing" : ccswitch.providerAvailable ? "provider" : "";
    const cliReady = Boolean(codexSdk.cliAvailable && (codexSdk.configAvailable || codexSdk.authAvailable));
    return {
      presets: PROVIDER_PRESETS,
      providers,
      active: llm.active,
      agent: llm.agent,
      codex: {
        model: ccswitch.model || "",
        provider: ccswitch.provider || "",
        route: httpRoute || (cliReady ? "cli" : ""),
        available: Boolean(httpRoute || cliReady),
        cliAvailable: Boolean(codexSdk.cliAvailable),
        agentAvailable: cliReady,
        reason: ccswitch.error || ccswitch.providerReason || ccswitch.routingReason
          || (codexSdk.cliAvailable ? "已找到 Codex CLI，但没有发现 Codex 配置或登录信息。" : "没有检测到 Codex CLI 或 CC Switch 配置。"),
      },
    };
  }

  // ---------------------------------------------------------------- 服务商增删改
  async saveProvider(input) {
    const id = typeof input?.id === "string" && input.id ? input.id : makeProviderId();
    const provider = normalizeProvider({ ...input, id });
    if (typeof input.apiKey === "string" && input.apiKey.trim()) await this.writeKey(id, cleanApiKey(input.apiKey));
    if (input.clearKey === true) await this.deleteKey(id);
    await this.mutate((llm) => {
      const index = llm.providers.findIndex((item) => item.id === id);
      if (index < 0) llm.providers.push(provider);
      else llm.providers[index] = provider;
      // 当前选中的模型被删掉时，改用这个服务商的第一个模型。
      for (const slot of ["active", "agent"]) {
        if (llm[slot].providerId === id && !provider.models.includes(llm[slot].model)) llm[slot].model = provider.models[0] ?? "";
      }
      return llm;
    });
    return provider;
  }

  async deleteProvider(providerId) {
    await this.mutate((llm) => {
      llm.providers = llm.providers.filter((item) => item.id !== providerId);
      return llm;
    });
    await this.deleteKey(providerId);
  }

  /** slot: "active"（论文分析、讨论）或 "agent"（论文 Codex、实验复现）。 */
  async select(slot, { providerId, model = "" }) {
    if (slot !== "active" && slot !== "agent") throw new Error("模型选择位置无效。");
    const llm = await this.load();
    if (providerId !== CODEX_PROVIDER_ID) {
      const provider = llm.providers.find((item) => item.id === providerId);
      if (!provider) throw new Error("这个服务商不存在，可能已被删除。");
      if (!model || !provider.models.includes(model)) throw new Error("请先在服务商里添加这个模型。");
      if (slot === "agent" && !provider.protocols.includes("responses")) throw new Error(`${provider.name} 没有勾选 Responses 协议，不能用于 Agent。`);
    }
    return this.mutate((current) => {
      current[slot] = { providerId, model: providerId === CODEX_PROVIDER_ID ? "" : model };
      return current;
    });
  }

  /** 获取模型列表。可以传一个还没保存的草稿（baseUrl + apiKey）；apiKey 为空时用已保存的密钥。 */
  async listModels({ providerId, baseUrl, apiKey }) {
    const llm = await this.load();
    const saved = providerId ? llm.providers.find((item) => item.id === providerId) : null;
    const url = baseUrl ? normalizeBaseUrl(baseUrl) : saved?.baseUrl;
    if (!url) throw new Error("请先填写接口地址。");
    const key = typeof apiKey === "string" && apiKey.trim() ? cleanApiKey(apiKey) : saved ? await this.readKey(saved.id) : "";
    return adapterListModels({ baseUrl: url, apiKey: key, label: saved?.name || new URL(url).host }, { fetchImpl: this.fetchImpl });
  }

  // ---------------------------------------------------------------- 调用
  /** 选中“跟随 Codex”时，一次性调用先走 CC Switch 的 HTTP 接口，没有再用 Codex CLI。 */
  async codexConnection() {
    const status = await this.codexStatus();
    const { ccswitch = {}, codexSdk = {}, runtime } = status;
    if (ccswitch.routingAvailable && ccswitch.baseUrl) {
      return { kind: "http", baseUrl: ccswitch.baseUrl, apiKey: "", model: ccswitch.model || "", protocol: "responses", label: `CC Switch · ${ccswitch.model || "当前模型"}` };
    }
    if (ccswitch.providerAvailable && runtime?.providerBaseUrl && runtime.apiKey) {
      return { kind: "http", baseUrl: runtime.providerBaseUrl, apiKey: runtime.apiKey, model: runtime.model || ccswitch.model || "", protocol: "responses", label: `Codex · ${ccswitch.provider || "当前 provider"} · ${runtime.model || ccswitch.model || "当前模型"}` };
    }
    if (codexSdk.cliAvailable && (codexSdk.configAvailable || codexSdk.authAvailable)) return { kind: "codex-cli", label: `Codex CLI · ${ccswitch.model || "当前模型"}` };
    const reason = String(ccswitch.error || ccswitch.providerReason || ccswitch.routingReason || "没有检测到 Codex CLI 或 CC Switch").replace(/[。.]+$/, "");
    throw new Error(`没有可用的 Codex 配置：${reason}。请在“模型服务商”里添加一个服务商并选中它。`);
  }

  async connectionFor(selection) {
    if (selection.providerId === CODEX_PROVIDER_ID) return this.codexConnection();
    const llm = await this.load();
    const provider = llm.providers.find((item) => item.id === selection.providerId);
    if (!provider) throw new Error("选中的服务商不存在，请在顶栏重新选择模型。");
    if (!selection.model) throw new Error(`还没有为 ${provider.name} 选择模型。`);
    const protocol = protocolFor(provider, "complete");
    return { kind: "http", baseUrl: provider.baseUrl, apiKey: await this.readKey(provider.id), model: selection.model, protocol, label: `${provider.name} · ${selection.model}` };
  }

  async describeActive() {
    const llm = await this.load();
    try { return (await this.connectionFor(llm.active)).label; }
    catch { return ""; }
  }

  /** 一次性调用（论文分析、讨论）。返回 { content, source }。 */
  async complete(messages, options = {}) {
    const llm = await this.load();
    const connection = await this.connectionFor(options.selection ?? llm.active);
    if (connection.kind === "codex-cli") {
      const result = await this.runCodexOnce(messages, options);
      return { content: result.content, source: connection.label };
    }
    const { content } = await adapterComplete(connection, messages, { ...options, fetchImpl: this.fetchImpl });
    return { content, source: connection.label };
  }

  /** 测试某个服务商的某个模型（不改变当前选择）。 */
  async test({ providerId, model }) {
    return this.complete([{ role: "user", content: "只回复 OK。" }], { selection: { providerId, model }, timeoutMs: 30_000 });
  }

  /**
   * 给 Codex SDK 的注入参数。跟随 Codex 时返回空对象，沿用 ~/.codex/config.toml；
   * 选了应用里的服务商时，用 --config 临时指定 provider 和模型，不改用户的配置文件。
   */
  async agentRuntime() {
    const llm = await this.load();
    const { providerId, model } = llm.agent;
    if (providerId === CODEX_PROVIDER_ID) return { label: "跟随 Codex 配置" };
    const provider = llm.providers.find((item) => item.id === providerId);
    if (!provider || !provider.protocols.includes("responses")) throw new Error("Agent 选中的服务商不支持 Responses 协议，请在顶栏重新选择 Agent 模型。");
    if (!model) throw new Error(`还没有为 Agent 选择 ${provider.name} 的模型。`);
    const apiKey = await this.readKey(provider.id);
    return {
      label: `${provider.name} · ${model}`,
      model,
      configOverrides: {
        model_provider: AGENT_PROVIDER_NAME,
        model_providers: {
          [AGENT_PROVIDER_NAME]: {
            name: provider.name,
            base_url: provider.baseUrl,
            wire_api: "responses",
            ...(apiKey ? { env_key: AGENT_KEY_ENV } : {}),
          },
        },
      },
      env: apiKey ? { [AGENT_KEY_ENV]: apiKey } : {},
    };
  }
}
