import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, FolderOpen, Globe2, LoaderCircle, Play, RefreshCw, Send, Square, StickyNote } from "lucide-react";
import type { DesktopBridge, Paper, PaperAgentMessage, PaperAgentState, PaperAnalysisProgress, Project, ResearchNote } from "../../types";
import { AgentQuestionDialog } from "../../components/AgentQuestionDialog";
import { AnalysisTraceView, canResumePaper } from "./PaperAnalysisWorkspace";

interface PaperReviewRailProps {
  project: Project;
  paper: Paper;
  progress: PaperAnalysisProgress | null;
  /** 这篇论文正在分析 */
  analyzing: boolean;
  onAnalyze: () => void;
  onAgentMessage: (content: string) => Promise<{ answer: string; paper: Paper }>;
  /** 回答 Codex 的问题后，把更新过的论文（含对话）交回课题数据 */
  onPaperChange: (paper: Paper) => void;
  api?: DesktopBridge;
  onSaveNote: (text: string, options: { paperId?: string; fromMessageId?: string }) => Promise<ResearchNote | null>;
  onOpenPaper: (paper: Paper, page?: number, quote?: string) => void;
}

/** 论文分析页右侧的通用 Codex 对话、分析过程与研究笔记。 */
export function PaperReviewRail({ project, paper, progress, analyzing, onAnalyze, onAgentMessage, onPaperChange, onSaveNote, onOpenPaper, api = window.autoresearch }: PaperReviewRailProps) {
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [agent, setAgent] = useState<PaperAgentState | null>(null);
  const [answering, setAnswering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [messages, setMessages] = useState<PaperAgentMessage[]>(paper.agentMessages ?? []);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  // 离开页面再回来时，从主进程取回 Codex 是否仍在运行、有没有待回答的问题。
  useEffect(() => {
    let active = true;
    api.getPaperAgentState({ projectId: project.id, paperId: paper.id }).then((state) => { if (active) setAgent(state); }).catch(() => {});
    const stop = api.onPaperAgentUpdate((state) => { if (state.projectId === project.id && state.paperId === paper.id) setAgent(state); });
    return () => { active = false; stop(); };
  }, [api, project.id, paper.id]);
  useEffect(() => { setMessages(paper.agentMessages ?? []); }, [paper.agentMessages]);
  const asking = sending || Boolean(agent?.running);
  useEffect(() => { messageEnd.current?.scrollIntoView({ block: "end" }); }, [messages.length, asking]);
  const notes = (project.notes ?? []).filter((note) => note.paperId === paper.id).slice().reverse();
  const savedMessageIds = new Set(notes.map((note) => note.fromMessageId).filter((id): id is string => Boolean(id)));
  const trace = progress?.trace ?? paper.analysisTrace;

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const content = question.trim();
    if (!content || asking) return;
    const userMessage: PaperAgentMessage = { id: crypto.randomUUID(), role: "user", content, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setSending(true);
    setAgentError("");
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
    setAgentError("");
    try {
      const result = await api.answerPaperAgentQuestion({ projectId: project.id, paperId: paper.id, requestId: pending.requestId, answers });
      onPaperChange(result.paper);
      setAgent(result.state);
      return true;
    } catch (reason) {
      setAgentError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally { setAnswering(false); }
  };
  const stopAgent = async () => {
    setStopping(true);
    try { setAgent(await api.stopPaperAgent({ projectId: project.id, paperId: paper.id })); }
    catch (reason) { setAgentError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setStopping(false); }
  };
  const saveAnswer = async (message: PaperAgentMessage) => {
    await onSaveNote(message.content, { paperId: paper.id, fromMessageId: message.id });
  };
  const saveDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!noteDraft.trim()) return;
    setNoteBusy(true);
    try { if (await onSaveNote(noteDraft.trim(), { paperId: paper.id })) setNoteDraft(""); }
    finally { setNoteBusy(false); }
  };

  return <aside className="right-rail paper-review-rail">
    <div className="right-rail-head"><div><span className="eyebrow">CODEX AGENT</span><h2>Codex</h2></div><div className="review-agent-capabilities"><span><Globe2 size={11} />联网</span><span><FolderOpen size={11} />数据目录</span></div></div>

    <section className="review-analysis">
      {trace ? <AnalysisTraceView className="analysis-trace--rail" trace={trace} projectId={project.id} papers={project.papers} paperId={paper.id} onOpenPaper={onOpenPaper} progress={progress} /> : <><div className="section-kicker"><span>分析过程</span>{paper.analysisStatus === "running" && <small>正在准备</small>}</div><p className="review-empty">当前暂无分析记录。</p></>}
      {paper.analysisStatus === "failed" && !progress && <button type="button" className="button button--small" disabled={analyzing || asking} onClick={onAnalyze}>{canResumePaper(paper) ? <><Play size={13} />继续分析已完成批次</> : <><RefreshCw size={13} />从头重试分析</>}</button>}
    </section>

    <section className="review-ask review-agent-chat">
      <div className="review-agent-messages" aria-live="polite">
        {messages.length ? messages.map((message) => <article className={`review-agent-message review-agent-message--${message.role}`} key={message.id}>
          <div className="review-agent-message-copy">{message.content}</div>
          {message.role === "assistant" && <button type="button" className="text-icon-button" disabled={savedMessageIds.has(message.id)} onClick={() => void saveAnswer(message)}>{savedMessageIds.has(message.id) ? <><Check size={12} />已存为笔记</> : <><StickyNote size={12} />存为本文笔记</>}</button>}
        </article>) : <p className="review-empty">{`围绕「${paper.title}」开始对话`}</p>}
        {asking && <div className="review-agent-working"><LoaderCircle className="spin" size={13} /><span>{agent?.pendingQuestion ? "Codex 在等你回答问题" : "Codex 正在处理"}</span><button type="button" className="text-icon-button" disabled={stopping} onClick={() => void stopAgent()}><Square size={11} />停止</button></div>}
        {agentError && <p className="review-agent-error" role="alert">{agentError}</p>}
        <div ref={messageEnd} />
      </div>
      <form className="review-composer" onSubmit={ask}>
        <label htmlFor="review-question" className="sr-only">向 Codex 发送消息</label>
        <textarea id="review-question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} placeholder="向 Codex 发送消息" disabled={asking} onKeyDown={(event) => {
          // 中文输入法用回车上屏时不发送。
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
        <button className="send-button" aria-label="发送消息" disabled={!question.trim() || asking}>{asking ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}</button>
      </form>
    </section>

    <section className="review-notes">
      <div className="section-kicker"><span>这篇论文的笔记</span><small>{notes.length}</small></div>
      <form className="review-note-form" onSubmit={saveDraft}>
        <textarea aria-label="写一条笔记" value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} rows={3} placeholder="你的观察：复现结果、发现的问题、和其他论文的联系" />
        <button className="button button--small" disabled={noteBusy || !noteDraft.trim()}>{noteBusy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}保存笔记</button>
      </form>
      {notes.map((note) => <article className="review-note" key={note.id}><p>{note.text}</p></article>)}
    </section>
    {agent?.pendingQuestion && <AgentQuestionDialog
      key={agent.pendingQuestion.requestId}
      question={agent.pendingQuestion}
      busy={answering || stopping}
      title="论文 Codex 需要你决定"
      description="Codex 已暂停。回答后会在同一轮继续；停止本轮则不再执行这次请求。"
      onSubmit={answer}
      onStop={() => void stopAgent()}
    />}
  </aside>;
}
