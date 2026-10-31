import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BookOpen, Check, ChevronDown, FlaskConical, Lightbulb, LoaderCircle, MessageSquareText, Pencil, Plus, Send, Sparkles, StickyNote, Trash2, X } from "lucide-react";
import type { DesktopBridge, Discussion, DiscussionScope, EvidenceSource, Message, Paper, Project } from "../../types";
import { formatDate } from "../../uiText";
import { Markdown } from "../../components/markdown.jsx";
import "./screen.css";

// 后端只区分两种上下文：只给原文片段，或原文片段加上选定论文的分析稿和研究笔记。
const scopes: Array<{ id: DiscussionScope; label: string; help: string }> = [
  { id: "snippets", label: "只看原文", help: "只参考从勾选论文里检索到的原文片段，适合核对细节和引用。" },
  { id: "analysis", label: "原文 + 分析稿和笔记", help: "在原文片段之外，加入勾选论文的分析稿和你的研究笔记，适合讨论思路。" },
];

const timeOf = (value: string) => {
  const date = new Date(value);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
};

export interface DiscussionSendInput {
  discussionId: string | null;
  content: string;
  paperIds: string[];
  scope: DiscussionScope;
}

export function DiscussionView({ project, activeId, onSelect, question, setQuestion, pending, sending, onSend, onRename, onDelete, onOpenPaper, onSaveNote, onSaveIdea, onBuildExperiment, api = window.autoresearch }: {
  project: Project;
  /** 当前讨论；null 表示一个还没发送过消息的新讨论 */
  activeId: string | null;
  onSelect: (discussionId: string | null) => void;
  question: string;
  setQuestion: (value: string) => void;
  /** 当前讨论里正在等回答的问题 */
  pending: string | null;
  sending: boolean;
  onSend: (input: DiscussionSendInput) => Promise<Discussion | null>;
  onRename: (discussionId: string, title: string) => Promise<boolean>;
  onDelete: (discussionId: string) => Promise<boolean>;
  onOpenPaper: (paper: Paper, page?: number, quote?: string) => void;
  onSaveNote: (text: string, options: { fromMessageId?: string }) => Promise<unknown>;
  onSaveIdea: (answer: Message, question: Message | undefined) => void;
  /** 据此建实验：实验必须绑定论文，默认用回答里引用最多的那篇 */
  onBuildExperiment: (input: { paperId?: string; goal: string }) => void;
  api?: DesktopBridge;
}) {
  const summaries = useMemo(() => [...(project.discussions ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [project.discussions]);
  const summary = summaries.find((item) => item.id === activeId) ?? null;
  const parsedPapers = useMemo(() => project.papers.filter((paper) => paper.status === "parsed"), [project.papers]);
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [paperIds, setPaperIds] = useState<string[]>(() => parsedPapers.map((paper) => paper.id));
  const [scope, setScope] = useState<DiscussionScope>("snippets");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // 读取当前讨论；别处更新了它（例如离开页面期间回答回来了）也会重新读取。
  useEffect(() => {
    setError("");
    if (!activeId) { setDiscussion(null); return; }
    let alive = true;
    setLoading(true);
    api.getDiscussion({ projectId: project.id, discussionId: activeId })
      .then((next) => { if (alive) setDiscussion(next); })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, project.id, activeId, summary?.updatedAt]);

  // 每个讨论记住自己的引用范围和上下文；新讨论默认勾选全部已解析的论文。
  useEffect(() => {
    const parsed = new Set(parsedPapers.map((paper) => paper.id));
    const saved = discussion?.id === activeId ? discussion?.paperIds : null;
    setPaperIds(saved ? saved.filter((id) => parsed.has(id)) : [...parsed]);
    setScope(discussion?.id === activeId && discussion?.scope === "analysis" ? "analysis" : "snippets");
  }, [activeId, discussion?.id]);

  const messages = discussion?.id === activeId ? discussion?.messages ?? [] : [];
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, pending, activeId]);

  useEffect(() => {
    if (!pickerOpen) return;
    const close = (event: MouseEvent) => { if (!(event.target as Element | null)?.closest?.(".ds-picker, .ds-picker-trigger")) setPickerOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPickerOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [pickerOpen]);

  const savedMessageIds = new Set((project.notes ?? []).map((note) => note.fromMessageId).filter((id): id is string => Boolean(id)));
  const papersById = new Map(project.papers.map((paper) => [paper.id, paper]));
  const currentScope = scopes.find((item) => item.id === scope) ?? scopes[0];
  const title = summary?.title ?? (activeId ? "讨论" : "新讨论");

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = question.trim();
    if (!content || sending) return;
    setError("");
    const saved = await onSend({ discussionId: activeId, content, paperIds, scope });
    if (saved) setDiscussion(saved);
  };

  const cite = (sources: EvidenceSource[]) => (paperId: string | null, page: number, raw: string) => {
    const source = sources.find((item) => (!paperId || item.paperId === paperId) && item.page === page);
    const paper = papersById.get(paperId ?? source?.paperId ?? "");
    const label = paper ? `${paper.title.split(/[:：]/)[0].slice(0, 18)} p.${page}` : raw.slice(1, -1);
    return <button type="button" className="ds-cite" disabled={!paper} title={paper ? `在 PDF 中打开第 ${page} 页` : "找不到这篇论文"} onClick={() => paper && onOpenPaper(paper, page, source?.excerpt)}><BookOpen size={10} />{label}</button>;
  };

  const buildExperiment = (answer: Message, asked: Message | undefined) => {
    const counts = new Map<string, number>();
    for (const source of answer.sources ?? []) if (papersById.get(source.paperId)?.status === "parsed") counts.set(source.paperId, (counts.get(source.paperId) ?? 0) + 1);
    const paperId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const excerpt = answer.content.replace(/\s+\n/g, "\n").trim().slice(0, 700);
    onBuildExperiment({ paperId, goal: `来自研究讨论「${title}」${asked ? `\n问题：${asked.content.trim().slice(0, 200)}` : ""}\n\n讨论结论：\n${excerpt}` });
  };

  return <div className="ds-page">
    <aside className="ds-threads" aria-label="讨论列表">
      <div className="ds-threads-head">
        <strong>研究讨论</strong>
        <button type="button" className="button button--small" onClick={() => onSelect(null)}><Plus size={13} />新讨论</button>
      </div>
      <div className="ds-thread-list">
        {activeId === null && <button type="button" className="ds-thread is-active" aria-current="true"><strong>新讨论</strong><small>还没有发送消息</small></button>}
        {summaries.map((item) => <button type="button" key={item.id} className={`ds-thread ${item.id === activeId ? "is-active" : ""}`} aria-current={item.id === activeId ? "true" : undefined} onClick={() => onSelect(item.id)}>
          <strong>{item.title}</strong>
          <small>{item.messageCount} 条 · {formatDate(item.updatedAt)}</small>
        </button>)}
        {!summaries.length && activeId !== null && <p className="ds-muted ds-thread-empty">还没有讨论。</p>}
      </div>
    </aside>

    <section className="ds-main">
      <header className="ds-head">
        {renaming !== null && activeId ? <form className="ds-rename" onSubmit={async (event) => { event.preventDefault(); if (await onRename(activeId, renaming)) setRenaming(null); }}>
          <input aria-label="讨论标题" value={renaming} autoFocus maxLength={60} onChange={(event) => setRenaming(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }} />
          <button className="button button--small button--primary" disabled={!renaming.trim()}><Check size={12} />保存</button>
          <button type="button" className="button button--small" onClick={() => setRenaming(null)}>取消</button>
        </form> : <>
          <h1 title={title}>{title}</h1>
          {activeId && <button type="button" className="ds-icon-button" aria-label="重命名讨论" title="重命名" onClick={() => setRenaming(summary?.title ?? "")}><Pencil size={13} /></button>}
          <span className="ds-head-meta">{messages.length ? `${messages.length} 条 · ` : ""}引用 {paperIds.length} 篇 · {currentScope.label}</span>
          {activeId && <button type="button" className="ds-icon-button ds-icon-button--danger" aria-label="删除讨论" title="删除讨论" onClick={async () => { if (window.confirm(`删除讨论「${title}」？删除后不能恢复。`)) await onDelete(activeId); }}><Trash2 size={13} /></button>}
        </>}
      </header>

      <div className="ds-stream" ref={scroller}>
        <div className="ds-stream-inner">
          {loading && !messages.length && <div className="ds-muted ds-loading"><LoaderCircle className="spin" size={14} />正在读取讨论</div>}
          {!loading && !messages.length && !pending && <div className="ds-intro">
            <span className="ds-intro-icon"><MessageSquareText size={18} /></span>
            <h2>问一个关于这些论文的问题</h2>
            <p>回答只依据勾选论文里检索到的原文{scope === "analysis" ? "、分析稿和你的笔记" : ""}，引用会标出页码，点一下就能打开原文。</p>
          </div>}
          {messages.map((message, index) => message.role === "user"
            ? <article className="ds-msg ds-msg--user" key={message.id}>
              <header><strong>你</strong><time>{timeOf(message.createdAt)}</time></header>
              <div className="ds-bubble">{message.content}</div>
            </article>
            : <article className="ds-msg ds-msg--assistant" key={message.id}>
              <header><span className="ds-avatar" aria-hidden="true"><Sparkles size={11} /></span><strong>研究助手</strong><time>{timeOf(message.createdAt)}</time>{message.scope && <span className="ds-scope-tag">{message.scope === "snippets" ? "只看原文" : "原文 + 分析稿和笔记"}</span>}</header>
              <div className="ds-answer ds-markdown"><Markdown source={message.content} renderCitation={cite(message.sources ?? [])} /></div>
              <div className="ds-actions">
                <button type="button" className="ds-action" disabled={savedMessageIds.has(message.id)} onClick={() => void onSaveNote(message.content, { fromMessageId: message.id })}>{savedMessageIds.has(message.id) ? <><Check size={12} />已存为笔记</> : <><StickyNote size={12} />存为笔记</>}</button>
                <button type="button" className="ds-action" onClick={() => onSaveIdea(message, messages[index - 1]?.role === "user" ? messages[index - 1] : undefined)}><Lightbulb size={12} />存为 Idea</button>
                <button type="button" className="ds-action" disabled={!parsedPapers.length} title={parsedPapers.length ? "带着这条结论去新建实验；实验需要绑定一篇论文" : "先导入并解析论文"} onClick={() => buildExperiment(message, messages[index - 1]?.role === "user" ? messages[index - 1] : undefined)}><FlaskConical size={12} />据此建实验</button>
                {message.sources?.length ? <details className="ds-sources">
                  <summary>检索到 {message.sources.length} 个片段</summary>
                  <ul>{message.sources.map((source) => {
                    const paper = papersById.get(source.paperId);
                    return <li key={source.chunkId}>
                      <button type="button" disabled={!paper} onClick={() => paper && onOpenPaper(paper, source.page, source.excerpt)}><BookOpen size={11} />{source.title.split(/[:：]/)[0].slice(0, 30)} · p.{source.page}</button>
                      <p>{source.excerpt.slice(0, 220)}{source.excerpt.length > 220 ? "…" : ""}</p>
                    </li>;
                  })}</ul>
                </details> : <span className="ds-muted ds-no-sources">没有检索到原文片段</span>}
              </div>
            </article>)}
          {pending && <>
            <article className="ds-msg ds-msg--user"><header><strong>你</strong></header><div className="ds-bubble">{pending}</div></article>
            <div className="ds-thinking"><LoaderCircle className="spin" size={13} />正在检索原文、整理回答</div>
          </>}
          {error && <p className="ds-error" role="alert">{error}</p>}
        </div>
      </div>

      <form className="ds-composer" onSubmit={submit}>
        <div className="ds-composer-tools">
          <button type="button" className="button button--small ds-picker-trigger" aria-expanded={pickerOpen} aria-haspopup="dialog" onClick={() => setPickerOpen((value) => !value)}><BookOpen size={12} />引用 {paperIds.length}/{parsedPapers.length} 篇<ChevronDown size={12} /></button>
          <div className="ds-scope" role="group" aria-label="上下文">
            {scopes.map((item) => <button type="button" key={item.id} aria-pressed={scope === item.id} className={scope === item.id ? "is-active" : ""} title={item.help} onClick={() => setScope(item.id)}>{item.label}</button>)}
          </div>
          <span className="ds-muted ds-scope-help">{paperIds.length ? currentScope.help : "没有勾选论文：回答只能依据课题方向" + (scope === "analysis" ? "和你的笔记" : "") + "，不会引用原文。"}</span>
          {pickerOpen && <div className="ds-picker" role="dialog" aria-label="引用范围">
            <div className="ds-picker-head"><strong>引用范围</strong><span><button type="button" className="ds-link" onClick={() => setPaperIds(parsedPapers.map((paper) => paper.id))}>全选</button><button type="button" className="ds-link" onClick={() => setPaperIds([])}>清空</button><button type="button" className="ds-icon-button" aria-label="关闭" onClick={() => setPickerOpen(false)}><X size={13} /></button></span></div>
            <div className="ds-picker-list">
              {project.papers.length ? project.papers.map((paper) => {
                const usable = paper.status === "parsed";
                return <label key={paper.id} className={usable ? "" : "is-disabled"}>
                  <input type="checkbox" disabled={!usable} checked={usable && paperIds.includes(paper.id)} onChange={() => setPaperIds((ids) => ids.includes(paper.id) ? ids.filter((id) => id !== paper.id) : [...ids, paper.id])} />
                  <span><strong>{paper.title}</strong><small>{usable ? `${paper.pageCount || "--"} 页${paper.analysisScript?.trim() ? " · 有分析稿" : " · 没有分析稿"}` : "没有可检索的文本，不能引用"}</small></span>
                </label>;
              }) : <p className="ds-muted">还没有导入论文。</p>}
            </div>
            <p className="ds-muted">只在勾选的论文里检索原文。这个讨论会记住你的选择。</p>
          </div>}
        </div>
        <div className="ds-input-row">
          <label className="sr-only" htmlFor="ds-question">研究问题</label>
          <textarea id="ds-question" value={question} rows={2} placeholder="讨论文献、比较方法，或提出研究方向" onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => {
            // 中文输入法用回车上屏时不发送。
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
          }} />
          <button className="button button--primary ds-send" aria-label="发送" disabled={!question.trim() || sending}>{sending ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}</button>
        </div>
        <p className="ds-muted ds-hint">Enter 发送 · Shift + Enter 换行 · 引用会标出论文和页码，推断会注明是推断</p>
      </form>
    </section>
  </div>;
}
