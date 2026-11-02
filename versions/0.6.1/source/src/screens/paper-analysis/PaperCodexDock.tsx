import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, ChevronUp, LoaderCircle, Send, Sparkles, Square, StickyNote } from "lucide-react";
import type { DesktopBridge, Paper, PaperAgentMessage, PaperAgentState, Project, ResearchNote } from "../../types";
import { AgentQuestionDialog } from "../../components/AgentQuestionDialog";
import { Markdown } from "../../components/markdown.jsx";

interface PaperCodexDockProps {
  project: Project;
  paper: Paper;
  onAgentMessage: (content: string) => Promise<{ answer: string; paper: Paper }>;
  /** 回答 Codex 的问题后，把更新过的论文（含对话）交回课题数据 */
  onPaperChange: (paper: Paper) => void;
  onSaveNote: (text: string, options: { paperId?: string; fromMessageId?: string }) => Promise<ResearchNote | null>;
  api?: DesktopBridge;
}

/**
 * 论文详情右栏底部的 Codex 对话，可以收起。
 * Codex 可读写数据目录、联网；需要研究者决定时会弹出问题（与实验复现相同），可以随时停止。
 */
export function PaperCodexDock({ project, paper, onAgentMessage, onPaperChange, onSaveNote, api = window.autoresearch }: PaperCodexDockProps) {
  const [open, setOpen] = useState(() => (paper.agentMessages?.length ?? 0) > 0);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [agent, setAgent] = useState<PaperAgentState | null>(null);
  const [answering, setAnswering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<PaperAgentMessage[]>(paper.agentMessages ?? []);
  const scroller = useRef<HTMLDivElement>(null);

  // 离开页面再回来时，从主进程取回 Codex 是否仍在运行、有没有待回答的问题。
  useEffect(() => {
    let active = true;
    api.getPaperAgentState({ projectId: project.id, paperId: paper.id }).then((state) => { if (active) setAgent(state); }).catch(() => {});
    const stop = api.onPaperAgentUpdate((state) => { if (state.projectId === project.id && state.paperId === paper.id) setAgent(state); });
    return () => { active = false; stop(); };
  }, [api, project.id, paper.id]);
  useEffect(() => { setMessages(paper.agentMessages ?? []); }, [paper.agentMessages]);

  const working = sending || Boolean(agent?.running);
  useEffect(() => { if (working) setOpen(true); }, [working]);
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, working, open]);

  const savedMessageIds = new Set((project.notes ?? []).map((note) => note.fromMessageId).filter((id): id is string => Boolean(id)));

  const ask = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = question.trim();
    if (!content || working) return;
    const userMessage: PaperAgentMessage = { id: crypto.randomUUID(), role: "user", content, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setSending(true);
    setError("");
    try {
      const result = await onAgentMessage(content);
      setMessages(result.paper.agentMessages ?? [...messages, userMessage, { id: crypto.randomUUID(), role: "assistant", content: result.answer, createdAt: new Date().toISOString() }]);
    } catch { /* App 已显示错误；对话以保存的记录为准。 */ }
    finally { setSending(false); }
  };

  const answer = async (answers: Record<string, string>) => {
    const pending = agent?.pendingQuestion;
    if (!pending) return false;
    setAnswering(true);
    setError("");
    try {
      const result = await api.answerPaperAgentQuestion({ projectId: project.id, paperId: paper.id, requestId: pending.requestId, answers });
      onPaperChange(result.paper);
      setAgent(result.state);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally { setAnswering(false); }
  };

  const stop = async () => {
    setStopping(true);
    try { setAgent(await api.stopPaperAgent({ projectId: project.id, paperId: paper.id })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setStopping(false); }
  };

  const status = agent?.pendingQuestion ? { label: "等你回答", tone: "amber" } : working ? { label: "正在处理", tone: "blue" } : { label: "空闲", tone: "gray" };

  return <section className={`pa-dock ${open ? "is-open" : ""}`} aria-label="论文 Codex">
    <header className="pa-dock-head">
      <span className="pa-dock-mark" aria-hidden="true"><Sparkles size={12} /></span>
      <strong>Codex</strong>
      <span className="pa-dock-caps">可读写数据目录 · 联网 · 需要你决定时会先问</span>
      <span className={`pa-pill pa-pill--${status.tone}`}>{status.label}</span>
      {working && <button type="button" className="pa-link-button pa-link-button--danger" disabled={stopping} onClick={() => void stop()}><Square size={10} />停止</button>}
      <button type="button" className="pa-link-button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? <><ChevronDown size={13} />收起</> : <><ChevronUp size={13} />展开对话{messages.length ? ` · ${messages.length}` : ""}</>}</button>
    </header>
    {open && <>
      <div className="pa-dock-messages" ref={scroller} aria-live="polite">
        {messages.length ? messages.map((message) => <article className={`pa-dock-message pa-dock-message--${message.role}`} key={message.id}>
          <div className="pa-dock-bubble">{message.role === "assistant" ? <div className="pa-markdown"><Markdown source={message.content} /></div> : message.content}</div>
          {message.role === "assistant" && <button type="button" className="pa-link-button" disabled={savedMessageIds.has(message.id)} onClick={() => void onSaveNote(message.content, { paperId: paper.id, fromMessageId: message.id })}>{savedMessageIds.has(message.id) ? <><Check size={12} />已存为笔记</> : <><StickyNote size={12} />存为本文笔记</>}</button>}
        </article>) : <p className="pa-dock-empty">问这篇论文的问题，或者让 Codex 帮你整理、计算、查资料。</p>}
        {working && <div className="pa-dock-working"><LoaderCircle className="spin" size={13} />{agent?.pendingQuestion ? "Codex 在等你回答问题" : "Codex 正在处理"}</div>}
        {error && <p className="pa-dock-error" role="alert">{error}</p>}
      </div>
      <form className="pa-dock-composer" onSubmit={ask}>
        <label className="sr-only" htmlFor={`codex-${paper.id}`}>向 Codex 发送消息</label>
        <textarea id={`codex-${paper.id}`} value={question} rows={2} disabled={working} placeholder={working ? "Codex 正在处理，结束后再发下一条" : "向 Codex 发送消息"} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => {
          // 中文输入法用回车上屏时不发送。
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(); }
        }} />
        <button className="button button--primary pa-send" aria-label="发送消息" disabled={!question.trim() || working}>{sending ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}</button>
      </form>
      <p className="pa-dock-hint">Enter 发送 · Shift + Enter 换行</p>
    </>}
    {agent?.pendingQuestion && <AgentQuestionDialog
      key={agent.pendingQuestion.requestId}
      question={agent.pendingQuestion}
      busy={answering || stopping}
      title="论文 Codex 需要你决定"
      description="Codex 已暂停。回答后会在同一轮继续；停止本轮则不再执行这次请求。"
      onSubmit={answer}
      onStop={() => void stop()}
    />}
  </section>;
}

