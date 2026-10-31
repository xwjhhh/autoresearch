import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, BookOpen, Check, CircleAlert, FlaskConical, LoaderCircle, Play, RefreshCw } from "lucide-react";
import type { AnalysisDepth, ExperimentSummary, Paper, PaperAnalysisProgress, PaperRole, Project, ResearchNote } from "../../types";
import { analysisDepthLabels, formatDate, paperRoleLabels } from "../../uiText";
import { Markdown } from "../../components/markdown.jsx";
import { AnalysisTraceView, analysisAction, analysisState, canResumePaper } from "./PaperAnalysisWorkspace";
import { PaperCodexDock } from "./PaperCodexDock";

type DetailTab = "script" | "trace" | "notes";

export function PaperAnalysisDetailView({ project, paper, progress, analyzing, pdfPane, experiments, onBack, onAnalyze, onOpenPaper, onUpdatePaper, onReproduce, onOpenExperiment, onAgentMessage, onPaperChange, onSaveNote }: {
  project: Project;
  paper: Paper;
  progress: PaperAnalysisProgress | null;
  /** 这篇论文正在分析 */
  analyzing: boolean;
  pdfPane: ReactNode;
  /** 这个课题的实验摘要；null 表示还在读取 */
  experiments: ExperimentSummary[] | null;
  onBack: () => void;
  onAnalyze: (paper: Paper) => void;
  onOpenPaper: (paper: Paper, page?: number, quote?: string) => void;
  onUpdatePaper: (payload: { role?: PaperRole; analysisDepth?: AnalysisDepth }) => void;
  onReproduce: (paper: Paper) => void;
  onOpenExperiment: (experimentId: string) => void;
  onAgentMessage: (content: string) => Promise<{ answer: string; paper: Paper }>;
  onPaperChange: (paper: Paper) => void;
  onSaveNote: (text: string, options: { paperId?: string; fromMessageId?: string }) => Promise<ResearchNote | null>;
}) {
  const role = paper.role ?? "core";
  const depth = paper.analysisDepth ?? (role === "atypical" ? "light" : "full");
  const trace = progress?.trace ?? paper.analysisTrace;
  const state = analysisState(paper, analyzing);
  const action = analysisAction(paper, analyzing);
  const notes = (project.notes ?? []).filter((note) => note.paperId === paper.id).slice().reverse();
  const reproductions = (experiments ?? []).filter((item) => item.paperId === paper.id);
  const [tab, setTab] = useState<DetailTab>(paper.analysisScript?.trim() ? "script" : trace ? "trace" : "script");
  // 分析开始后切到“分析过程”，能看到进度；完成后回到讲解稿。
  const live = Boolean(progress);
  useEffect(() => { if (live) setTab("trace"); }, [live]);
  useEffect(() => { if (!analyzing && paper.analysisStatus === "complete") setTab((current) => current === "trace" ? "script" : current); }, [analyzing, paper.analysisStatus]);

  const citePaper = (paperId: string | null, page: number, raw: string) => {
    const target = (paperId && project.papers.find((item) => item.id === paperId)) || paper;
    return <button type="button" className="pa-cite" title={`在 PDF 中打开第 ${page} 页`} onClick={() => onOpenPaper(target, page)}><BookOpen size={10} />{paperId && paperId !== paper.id ? raw.slice(1, -1) : `p.${page}`}</button>;
  };

  const tabs: Array<{ id: DetailTab; label: ReactNode }> = [
    { id: "script", label: "讲解稿" },
    { id: "trace", label: <>{analyzing && <LoaderCircle className="spin" size={11} />}分析过程</> },
    { id: "notes", label: notes.length ? `笔记 ${notes.length}` : "笔记" },
  ];

  return <div className="pa-detail">
    <header className="pa-detail-head">
      <button type="button" className="pa-link-button" onClick={onBack}><ArrowLeft size={14} />文献</button>
      <h1 title={paper.title}>{paper.title}</h1>
      <span className={`pa-pill pa-pill--${state.tone}`}>{state.label}</span>
      <label className="pa-select">角色<select value={role} onChange={(event) => onUpdatePaper({ role: event.target.value as PaperRole })} disabled={analyzing}>{(["core", "atypical"] as const).map((value) => <option key={value} value={value}>{paperRoleLabels[value]}</option>)}</select></label>
      <label className="pa-select">分析深度<select value={depth} onChange={(event) => onUpdatePaper({ analysisDepth: event.target.value as AnalysisDepth })} disabled={analyzing}>{(["full", "light"] as const).map((value) => <option key={value} value={value}>{analysisDepthLabels[value]}</option>)}</select></label>
      <button type="button" className="button button--small" disabled={action.disabled} onClick={() => onAnalyze(paper)}>{analyzing ? <LoaderCircle className="spin" size={13} /> : canResumePaper(paper) ? <Play size={13} /> : <RefreshCw size={13} />}{action.label}</button>
      {reproductions[0]
        ? <button type="button" className="button button--small" onClick={() => onOpenExperiment(reproductions[0].id)}><FlaskConical size={13} />查看复现</button>
        : <button type="button" className="button button--small button--primary" disabled={paper.status !== "parsed"} onClick={() => onReproduce(paper)}><FlaskConical size={13} />复现这篇论文</button>}
    </header>

    <div className="pa-detail-split">
      <div className="pa-detail-pdf">{pdfPane}</div>
      <section className="pa-detail-side">
        <div className="pa-tabs" role="tablist" aria-label="论文内容">
          {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}
        </div>
        <div className="pa-tab-body" role="tabpanel">
          {tab === "script" && (paper.analysisScript?.trim()
            ? <article className="pa-markdown pa-script"><Markdown source={paper.analysisScript} renderCitation={citePaper} /></article>
            : <div className="pa-empty">
              {paper.analysisStatus === "failed" ? <CircleAlert size={18} /> : <BookOpen size={18} />}
              <h3>{analyzing ? "正在生成讲解稿" : paper.analysisStatus === "failed" ? "分析没有完成" : "还没有讲解稿"}</h3>
              <p>{analyzing ? "进度在“分析过程”里。分析在后台进行，可以先去别的页面。" : paper.analysisStatus === "failed" ? paper.error || "已完成的步骤会保留，可以接着分析。" : paper.status !== "parsed" ? "这篇论文没有可检索的文本，不能分析。" : "点上方的按钮开始分析，讲解稿会显示在这里。"}</p>
              {!action.disabled && <button type="button" className="button button--primary button--small" onClick={() => onAnalyze(paper)}>{action.label}</button>}
            </div>)}
          {tab === "trace" && (trace
            ? <AnalysisTraceView className="pa-trace" trace={trace} projectId={project.id} papers={project.papers} paperId={paper.id} onOpenPaper={onOpenPaper} progress={progress} />
            : <div className="pa-empty"><BookOpen size={18} /><h3>还没有分析记录</h3><p>开始分析后，每一步读了哪些原文、调用了几次 AI，都会记在这里。</p></div>)}
          {tab === "notes" && <PaperNotes paper={paper} notes={notes} onSaveNote={onSaveNote} />}
        </div>
        <PaperCodexDock key={paper.id} project={project} paper={paper} onAgentMessage={onAgentMessage} onPaperChange={onPaperChange} onSaveNote={onSaveNote} />
      </section>
    </div>
  </div>;
}

function PaperNotes({ paper, notes, onSaveNote }: { paper: Paper; notes: ResearchNote[]; onSaveNote: (text: string, options: { paperId?: string }) => Promise<ResearchNote | null> }) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || saving) return;
    setSaving(true);
    try { if (await onSaveNote(draft.trim(), { paperId: paper.id })) setDraft(""); }
    finally { setSaving(false); }
  };
  return <div className="pa-notes">
    <form onSubmit={save}>
      <label htmlFor={`note-${paper.id}`}>写一条这篇论文的笔记</label>
      <textarea id={`note-${paper.id}`} rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="你的观察：复现结果、发现的问题、和其他论文的联系" />
      <div><button className="button button--small" disabled={saving || !draft.trim()}>{saving ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}保存笔记</button></div>
    </form>
    {notes.length ? notes.map((note) => <article key={note.id} className="pa-note"><p>{note.text}</p><small>{formatDate(note.createdAt)}{note.fromMessageId ? " · 来自 Codex 对话" : ""}</small></article>)
      : <p className="pa-muted">还没有笔记。Codex 的回答也可以直接存为本文笔记。</p>}
  </div>;
}
