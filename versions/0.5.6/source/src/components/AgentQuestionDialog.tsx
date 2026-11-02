import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CircleHelp, LoaderCircle, Send, Square } from "lucide-react";
import type { AgentQuestionRequest } from "../types";
import "./agent-question.css";

/** Codex 需要研究者决定时弹出的问题。实验复现和论文页 Codex 共用。 */
type QuestionSelection = { kind: "option" | "other"; value: string };

export function AgentQuestionDialog({ question, busy, onSubmit, onStop, title = "需要你决定", description = "Agent 已暂停。回答后会在当前会话继续。" }: {
  question: AgentQuestionRequest;
  title?: string;
  description?: string;
  busy: boolean;
  onSubmit: (answers: Record<string, string>) => Promise<boolean>;
  onStop: () => void;
}) {
  const [selections, setSelections] = useState<Record<string, QuestionSelection>>({});
  const dialog = useRef<HTMLElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled)")?.focus();
    return () => priorFocus.current?.focus();
  }, []);

  const ready = question.questions.every((item) => {
    const selection = selections[item.id];
    return selection?.kind === "option"
      ? item.options.some((option) => option.label === selection.value)
      : Boolean(item.isOther && selection?.value.trim());
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    const answers = Object.fromEntries(question.questions.map((item) => [item.id, selections[item.id].value.trim()]));
    await onSubmit(answers);
  };

  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); return; }
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  return <div className="modal-backdrop exp-question-backdrop">
    <section ref={dialog} className="modal modal--wide exp-question-modal" role="dialog" aria-modal="true" aria-labelledby="exp-question-title" onKeyDown={trapFocus}>
      <header className="exp-question-header">
        <span className="exp-question-icon"><CircleHelp size={18} /></span>
        <div>
          <h2 id="exp-question-title">{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <form onSubmit={submit}>
        <div className="exp-question-list">
          {question.questions.map((item, index) => {
            const selection = selections[item.id];
            return <fieldset className="exp-question-item" key={item.id}>
              <legend><span>{index + 1}</span><strong>{item.header}</strong></legend>
              <p>{item.question}</p>
              {item.options.length > 0 && <div className="exp-question-options" role="radiogroup" aria-label={item.header}>
                {item.options.map((option) => <label className={`exp-question-option ${selection?.kind === "option" && selection.value === option.label ? "is-selected" : ""}`} key={option.label}>
                  <input type="radio" name={`question-${item.id}`} checked={selection?.kind === "option" && selection.value === option.label} disabled={busy} onChange={() => setSelections((current) => ({ ...current, [item.id]: { kind: "option", value: option.label } }))} />
                  <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                </label>)}
              </div>}
              {item.isOther && <div className={`exp-question-other ${selection?.kind === "other" ? "is-selected" : ""}`}>
                {item.options.length > 0 && <label className="exp-question-option exp-question-other-choice">
                  <input type="radio" name={`question-${item.id}`} checked={selection?.kind === "other"} disabled={busy} onChange={() => setSelections((current) => ({ ...current, [item.id]: { kind: "other", value: "" } }))} />
                  <span><strong>其他</strong><small>填写自己的回答</small></span>
                </label>}
                <textarea aria-label={`${item.header}，其他回答`} rows={2} maxLength={2000} disabled={busy} value={selection?.kind === "other" ? selection.value : ""} onFocus={() => setSelections((current) => ({ ...current, [item.id]: { kind: "other", value: current[item.id]?.kind === "other" ? current[item.id].value : "" } }))} onChange={(event) => setSelections((current) => ({ ...current, [item.id]: { kind: "other", value: event.target.value } }))} placeholder="输入你的回答" />
              </div>}
            </fieldset>;
          })}
        </div>
        <footer className="exp-question-actions">
          <button type="button" className="button" disabled={busy} onClick={onStop}><Square size={11} />停止本轮</button>
          <button type="submit" className="button button--primary" disabled={!ready || busy}>{busy ? <LoaderCircle className="spin" size={13} /> : <Send size={13} />}提交答案并继续</button>
        </footer>
      </form>
    </section>
  </div>;
}
