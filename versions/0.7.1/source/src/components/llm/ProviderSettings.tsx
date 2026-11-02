import { useState } from "react";
import { Check, CircleAlert, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { LlmProtocol, LlmProvider, LlmProviderDraft, LlmState } from "../../types";
import { codexRouteText } from "./labels";
import "./llm.css";

type Slot = "active" | "agent";
const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(error);
const newId = () => `p_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
const protocolLabels: Record<LlmProtocol, string> = { chat: "Chat Completions", responses: "Responses" };

/** 和后端 cleanApiKey 同样的规则，输入时就提示。 */
function apiKeyProblem(value: string): string {
  const key = value.trim().replace(/^(['"])(.*)\1$/s, "$2").trim().replace(/^bearer\s+/i, "").trim();
  if (!key) return "";
  if (key.length > 2000) return "密钥太长了，可能把别的内容也粘贴进去了。请只粘贴密钥本身。";
  const chars = [...key];
  const bad = chars.findIndex((char) => char.codePointAt(0)! < 0x21 || char.codePointAt(0)! > 0x7e);
  if (bad < 0) return "";
  const shown = /\s/.test(chars[bad]) ? "空格或换行" : `“${chars[bad]}”`;
  return `第 ${bad + 1} 个字符是${shown}，密钥里不能有中文、空格或换行。请只粘贴密钥本身（通常以 sk- 开头）。`;
}

export interface ProviderActions {
  onSave: (draft: LlmProviderDraft) => Promise<LlmState>;
  onDelete: (providerId: string) => Promise<void>;
  onSelect: (slot: Slot, providerId: string, model: string) => Promise<void>;
  onTest: (providerId: string, model: string) => Promise<{ content: string; source: string }>;
  onRefresh: () => Promise<void>;
}

/** 设置页里的“模型服务商”：添加、编辑、删除服务商，获取模型列表，测试连接。 */
export function ProviderSettings({ state, ...actions }: { state: LlmState } & ProviderActions) {
  // 新建时先生成 id：编辑器里“保存并测试”后服务商已经存在，但编辑器仍留在原位，不重新挂载。
  const [editing, setEditing] = useState<string | null>(null);
  const [newDraftId, setNewDraftId] = useState<string | null>(null);
  const closeEditor = () => { setEditing(null); setNewDraftId(null); };
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const remove = async (providerId: string) => {
    setError("");
    try { await actions.onDelete(providerId); setConfirmDelete(null); if (editing === providerId) setEditing(null); }
    catch (reason) { setError(errorText(reason)); }
  };
  const refresh = async () => {
    setRefreshing(true);
    try { await actions.onRefresh(); } finally { setRefreshing(false); }
  };

  return <section className="settings-section llm-settings">
    <div className="llm-settings-head">
      <div className="settings-section-title"><KeyRound size={15} /><strong>模型服务商</strong></div>
      {editing === null && <button type="button" className="button button--small" onClick={() => { const id = newId(); setNewDraftId(id); setEditing(id); }}><Plus size={14} />添加服务商</button>}
    </div>
    <p className="settings-help">官方接口和中转站都在这里添加。添加后在顶栏右上角切换模型，立即生效。密钥用 Windows 系统凭据加密保存在本机。</p>

    <div className="llm-provider llm-provider--codex">
      <div className="llm-provider-main">
        <strong>Codex / CC Switch</strong>
        <span className="llm-provider-url">跟随 ~/.codex/config.toml，在 CC Switch 里切换的 provider 会同步过来</span>
        <span className={`llm-provider-status ${state.codex.available ? "is-ready" : ""}`}><span className={`connection-dot ${state.codex.available ? "is-on" : ""}`} />{codexRouteText(state)}</span>
      </div>
      <button type="button" className="icon-button" aria-label="重新检测 Codex 配置" title="重新检测" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button>
    </div>

    {state.providers.filter((provider) => provider.id !== newDraftId).map((provider) => editing === provider.id
      ? <ProviderEditor key={provider.id} state={state} provider={provider} actions={actions} onClose={closeEditor} />
      : <div className="llm-provider" key={provider.id}>
        <div className="llm-provider-main">
          <strong>{provider.name}</strong>
          <span className="llm-provider-url">{provider.baseUrl}</span>
          <span className="llm-provider-tags">
            {provider.protocols.map((protocol) => <span key={protocol} className={`llm-tag ${protocol === "responses" ? "llm-tag--agent" : ""}`}>{protocolLabels[protocol]}</span>)}
            <span className="llm-tag">{provider.models.length} 个模型</span>
            {!provider.hasKey && <span className="llm-tag llm-tag--warn">未填密钥</span>}
          </span>
        </div>
        {confirmDelete === provider.id
          ? <span className="llm-confirm">删除 {provider.name}？<button type="button" className="button button--small llm-danger" onClick={() => void remove(provider.id)}>删除</button><button type="button" className="button button--small" onClick={() => setConfirmDelete(null)}>取消</button></span>
          : <span className="llm-provider-actions">
            <button type="button" className="icon-button" aria-label={`编辑 ${provider.name}`} title="编辑" disabled={editing !== null} onClick={() => setEditing(provider.id)}><Pencil size={14} /></button>
            <button type="button" className="icon-button" aria-label={`删除 ${provider.name}`} title="删除" disabled={editing !== null} onClick={() => setConfirmDelete(provider.id)}><Trash2 size={14} /></button>
          </span>}
      </div>)}

    {newDraftId && <ProviderEditor key={newDraftId} state={state} draftId={newDraftId} actions={actions} onClose={closeEditor} />}
    {error && <p className="llm-error"><CircleAlert size={13} />{error}</p>}
  </section>;
}

function ProviderEditor({ state, provider, draftId, actions, onClose }: { state: LlmState; provider?: LlmProvider; draftId?: string; actions: ProviderActions; onClose: () => void }) {
  const [draft, setDraft] = useState<LlmProviderDraft>(() => provider
    ? { id: provider.id, name: provider.name, preset: provider.preset, baseUrl: provider.baseUrl, protocols: [...provider.protocols], models: [...provider.models] }
    : { id: draftId ?? newId(), name: "", preset: "", baseUrl: "", protocols: ["chat"], models: [] });
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [newModel, setNewModel] = useState("");
  const [fetched, setFetched] = useState<string[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "models" | "test">("");
  const [error, setError] = useState("");
  const [testModel, setTestModel] = useState(provider?.models[0] ?? "");
  const [tested, setTested] = useState<string>("");
  const saved = state.providers.find((item) => item.id === draft.id);
  const hasKey = Boolean(saved?.hasKey) && !clearKey;
  const preset = state.presets.find((item) => item.id === draft.preset);

  const patch = (value: Partial<LlmProviderDraft>) => setDraft((current) => ({ ...current, ...value }));
  const choosePreset = (id: string) => {
    const next = state.presets.find((item) => item.id === id);
    if (!next) return;
    setDraft((current) => ({
      ...current,
      preset: next.id,
      name: !current.name || state.presets.some((item) => item.name === current.name) ? next.name : current.name,
      baseUrl: next.baseUrl || current.baseUrl,
      protocols: [...next.protocols],
      models: current.models.length ? current.models : [...next.models],
    }));
    if (!testModel && next.models[0]) setTestModel(next.models[0]);
  };
  const toggleProtocol = (protocol: LlmProtocol) => patch({ protocols: draft.protocols.includes(protocol) ? draft.protocols.filter((item) => item !== protocol) : [...draft.protocols, protocol] });
  const toggleModel = (model: string) => {
    const models = draft.models.includes(model) ? draft.models.filter((item) => item !== model) : [...draft.models, model];
    patch({ models });
    if (!testModel || !models.includes(testModel)) setTestModel(models[0] ?? "");
  };
  const addModel = () => {
    const model = newModel.trim();
    if (!model) return;
    if (!draft.models.includes(model)) patch({ models: [...draft.models, model] });
    if (!testModel) setTestModel(model);
    setNewModel("");
  };

  const fetchModels = async () => {
    setBusy("models");
    setError("");
    try {
      const models = await window.autoresearch.listLlmModels({ providerId: saved ? draft.id : undefined, baseUrl: draft.baseUrl, apiKey: apiKey.trim() || undefined });
      setFetched(models);
      if (!models.length) setError("接口返回了空的模型列表，可以手动添加模型名称。");
    } catch (reason) { setError(`获取模型列表失败：${errorText(reason)}。可以手动添加模型名称。`); }
    finally { setBusy(""); }
  };

  const persist = async () => {
    await actions.onSave({ ...draft, name: draft.name.trim() || preset?.name || "未命名服务商", ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(clearKey ? { clearKey: true } : {}) });
    setApiKey("");
    setClearKey(false);
  };
  const save = async () => {
    setBusy("save");
    setError("");
    try { await persist(); onClose(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(""); }
  };
  const test = async () => {
    if (!testModel) { setError("先添加一个模型再测试。"); return; }
    setBusy("test");
    setError("");
    setTested("");
    try {
      await persist();
      const result = await actions.onTest(draft.id!, testModel);
      setTested(`连接正常 · ${result.source}`);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(""); }
  };
  const useModel = async (slot: Slot) => {
    setError("");
    try { await actions.onSelect(slot, draft.id!, testModel); setTested((current) => `${current} · ${slot === "active" ? "已设为分析与讨论模型" : "已设为 Agent 模型"}`); }
    catch (reason) { setError(errorText(reason)); }
  };

  const keyProblem = apiKeyProblem(apiKey);
  const visibleFetched = (fetched ?? []).filter((model) => !filter.trim() || model.toLowerCase().includes(filter.trim().toLowerCase()));
  const agentCapable = draft.protocols.includes("responses");

  return <div className="llm-editor">
    <div className="llm-editor-head"><strong>{provider ? `编辑 ${provider.name}` : "添加服务商"}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={15} /></button></div>

    <div className="llm-presets" role="group" aria-label="选择预设">
      {state.presets.map((item) => <button type="button" key={item.id} className={draft.preset === item.id ? "is-active" : ""} aria-pressed={draft.preset === item.id} onClick={() => choosePreset(item.id)}>{item.name}</button>)}
    </div>
    {preset && <p className="settings-help">{preset.help}</p>}

    <div className="llm-grid">
      <label>名称<input value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder={preset?.name || "例如：我的中转站"} maxLength={60} /></label>
      <label>接口地址<input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} /></label>
    </div>
    <label className="llm-field">API 密钥
      <input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); if (event.target.value) setClearKey(false); }} placeholder={hasKey ? "已保存，留空保持不变" : "sk-..."} spellCheck={false} />
    </label>
    {keyProblem && <p className="llm-error"><CircleAlert size={13} />{keyProblem}</p>}
    {saved?.hasKey && <label className="llm-check"><input type="checkbox" checked={clearKey} onChange={(event) => { setClearKey(event.target.checked); if (event.target.checked) setApiKey(""); }} />删除已保存的密钥（本地接口不需要密钥时使用）</label>}

    <div className="llm-protocols">
      <span>接口协议</span>
      {(["chat", "responses"] as const).map((protocol) => <label key={protocol} className="llm-check"><input type="checkbox" checked={draft.protocols.includes(protocol)} onChange={() => toggleProtocol(protocol)} />{protocolLabels[protocol]}{protocol === "responses" && <small>（Agent 需要）</small>}</label>)}
    </div>

    <div className="llm-models">
      <div className="llm-models-head">
        <span>模型 <small>{draft.models.length} 个</small></span>
        <button type="button" className="button button--small" disabled={busy !== "" || !draft.baseUrl.trim()} onClick={() => void fetchModels()}>{busy === "models" ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}获取模型列表</button>
      </div>
      {draft.models.length ? <div className="llm-chips">{draft.models.map((model) => <span className="llm-chip" key={model}>{model}<button type="button" aria-label={`移除 ${model}`} onClick={() => toggleModel(model)}><X size={11} /></button></span>)}</div>
        : <p className="settings-help">还没有模型。点“获取模型列表”从接口拉取，或在下面手动输入。</p>}
      <div className="llm-add-model">
        <input value={newModel} onChange={(event) => setNewModel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addModel(); } }} placeholder="手动输入模型名称，例如 deepseek-chat" spellCheck={false} />
        <button type="button" className="button button--small" disabled={!newModel.trim()} onClick={addModel}><Plus size={13} />添加</button>
      </div>
      {fetched && fetched.length > 0 && <div className="llm-fetched">
        <div className="llm-fetched-head">
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={`在 ${fetched.length} 个模型中搜索`} />
          <button type="button" className="text-button" onClick={() => patch({ models: [...new Set([...draft.models, ...visibleFetched])] })}>全选{filter ? "筛选结果" : ""}</button>
          <button type="button" className="text-button" onClick={() => setFetched(null)}>收起</button>
        </div>
        <div className="llm-fetched-list">{visibleFetched.map((model) => <label key={model} className="llm-check"><input type="checkbox" checked={draft.models.includes(model)} onChange={() => toggleModel(model)} />{model}</label>)}</div>
      </div>}
    </div>

    <div className="llm-test">
      <select value={testModel} onChange={(event) => setTestModel(event.target.value)} aria-label="测试用的模型" disabled={!draft.models.length}>
        {draft.models.length ? draft.models.map((model) => <option key={model} value={model}>{model}</option>) : <option value="">先添加模型</option>}
      </select>
      <button type="button" className="button button--small" disabled={busy !== "" || !testModel} onClick={() => void test()}>{busy === "test" ? <LoaderCircle className="spin" size={13} /> : <CircleAlert size={13} />}保存并测试</button>
      {tested && <span className="llm-test-ok"><Check size={13} />{tested}</span>}
    </div>
    {tested && <div className="llm-use">
      <button type="button" className="button button--small" onClick={() => void useModel("active")}>设为分析与讨论模型</button>
      <button type="button" className="button button--small" disabled={!agentCapable} title={agentCapable ? "" : "需要勾选 Responses 协议"} onClick={() => void useModel("agent")}>设为 Agent 模型</button>
    </div>}
    {error && <p className="llm-error"><CircleAlert size={13} />{error}</p>}

    <div className="llm-editor-actions">
      <button type="button" className="button" onClick={onClose}>取消</button>
      <button type="button" className="button button--primary" disabled={busy !== ""} onClick={() => void save()}>{busy === "save" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存服务商</button>
    </div>
  </div>;
}

