import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, LoaderCircle, Settings2, Sparkles } from "lucide-react";
import { CODEX_PROVIDER_ID, type LlmSelection, type LlmState } from "../../types";
import { selectionLabel, selectionReady, supportsAgent } from "./labels";
import "./llm.css";

type Slot = "active" | "agent";

/** 顶栏的模型切换器：点一下切换论文分析/讨论用的模型，以及 Agent（论文 Codex、实验复现）用的模型。 */
export function ModelSwitcher({ state, onSelect, onManage }: {
  state: LlmState | null;
  onSelect: (slot: Slot, providerId: string, model: string) => Promise<void>;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState<Slot>("active");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  if (!state) return <button type="button" className="llm-switch" disabled><LoaderCircle className="spin" size={13} />正在读取模型</button>;

  const selection: LlmSelection = state[slot];
  const ready = selectionReady(state, state.active, "active");
  const needle = query.trim().toLowerCase();
  const pick = async (providerId: string, model: string) => {
    const key = `${providerId}:${model}`;
    setBusy(key);
    try { await onSelect(slot, providerId, model); setOpen(false); }
    finally { setBusy(""); }
  };
  const isCurrent = (providerId: string, model: string) => selection.providerId === providerId && (providerId === CODEX_PROVIDER_ID || selection.model === model);
  const agentWarning = slot === "agent" && !state.codex.cliAvailable;

  return <div className="llm-switch-wrap" ref={root}>
    <button type="button" className={`llm-switch ${open ? "is-open" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)} title={`论文分析和讨论：${selectionLabel(state, state.active)}\nAgent：${selectionLabel(state, state.agent)}`}>
      <span className={`connection-dot ${ready ? "is-on" : ""}`} />
      <span className="llm-switch-label">{selectionLabel(state, state.active)}</span>
      <ChevronDown size={13} />
    </button>
    {open && <div className="llm-pop" role="dialog" aria-label="切换模型">
      <div className="llm-pop-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={slot === "active"} className={slot === "active" ? "is-active" : ""} onClick={() => setSlot("active")}><Sparkles size={13} /><span><strong>分析与讨论</strong><small>{selectionLabel(state, state.active)}</small></span></button>
        <button type="button" role="tab" aria-selected={slot === "agent"} className={slot === "agent" ? "is-active" : ""} onClick={() => setSlot("agent")}><Bot size={13} /><span><strong>Agent</strong><small>{selectionLabel(state, state.agent)}</small></span></button>
      </div>
      <p className="llm-pop-hint">{slot === "active" ? "论文分析、研究讨论使用。可以选任何服务商。" : "论文 Codex、实验复现使用。需要本机 Codex CLI，且服务商支持 Responses 协议。"}</p>
      {agentWarning && <p className="llm-pop-warn">没有检测到 Codex CLI，Agent 暂时不能运行。请先安装 Codex。</p>}
      <input className="llm-pop-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" aria-label="搜索模型" autoFocus />
      <div className="llm-pop-list">
        {(!needle || "codex".includes(needle)) && <section>
          <h4>Codex / CC Switch</h4>
          <button type="button" className={`llm-option ${isCurrent(CODEX_PROVIDER_ID, "") ? "is-current" : ""}`} disabled={Boolean(busy)} onClick={() => void pick(CODEX_PROVIDER_ID, "")}>
            <span className="llm-option-name">跟随 Codex 配置{state.codex.model ? ` · ${state.codex.model}` : ""}</span>
            {busy === `${CODEX_PROVIDER_ID}:` ? <LoaderCircle className="spin" size={13} /> : isCurrent(CODEX_PROVIDER_ID, "") ? <Check size={13} /> : <span className={`connection-dot ${(slot === "agent" ? state.codex.agentAvailable : state.codex.available) ? "is-on" : ""}`} />}
          </button>
        </section>}
        {state.providers.map((provider) => {
          const usable = slot === "active" || supportsAgent(provider);
          const models = provider.models.filter((model) => !needle || model.toLowerCase().includes(needle) || provider.name.toLowerCase().includes(needle));
          if (needle && !models.length) return null;
          return <section key={provider.id}>
            <h4>{provider.name}{!usable && <small>不支持 Responses</small>}{!provider.hasKey && <small>未填密钥</small>}</h4>
            {models.length ? models.map((model) => <button type="button" key={model} className={`llm-option ${isCurrent(provider.id, model) ? "is-current" : ""}`} disabled={!usable || Boolean(busy)} onClick={() => void pick(provider.id, model)}>
              <span className="llm-option-name">{model}</span>
              {busy === `${provider.id}:${model}` ? <LoaderCircle className="spin" size={13} /> : isCurrent(provider.id, model) ? <Check size={13} /> : null}
            </button>) : <p className="llm-pop-empty">还没有添加模型，<button type="button" onClick={() => { setOpen(false); onManage(); }}>去添加</button></p>}
          </section>;
        })}
        {!state.providers.length && <p className="llm-pop-empty">还没有添加服务商。添加 OpenAI、DeepSeek 或中转站后，就能在这里切换。</p>}
      </div>
      <button type="button" className="llm-pop-manage" onClick={() => { setOpen(false); onManage(); }}><Settings2 size={13} />管理模型服务商</button>
    </div>}
  </div>;
}
