import { useEffect, useState } from "react";
import { BookOpen, Check, CircleAlert, FilePlus2, FileText, FlaskConical, LoaderCircle, MoreHorizontal, Play, RefreshCw, Sparkles } from "lucide-react";
import type { ExperimentSummary, Paper, PaperAnalysisAiCall, PaperAnalysisCallLog, PaperAnalysisProgress, PaperAnalysisTrace, Project } from "../../types";
import { analysisStatusLabels, formatDate, paperRoleLabels, paperStatusLabels } from "../../uiText";
import { EmptyState } from "../../components/Shared";
import { anyAnalysis, isAnalyzing, isLiveProgress, taskKeys } from "../../app/tasks";

export function canResumePaper(paper: Paper): boolean {
  const checkpoint = paper.analysisCheckpoint;
  const depth = paper.analysisDepth ?? (paper.role === "atypical" ? "light" : "full");
  const expectedParts = depth === "light" ? ["light"] : ["A", "B"];
  const hasFullTextResult = expectedParts.some((part) => {
    const output = checkpoint?.fullTextParts?.[part];
    return Boolean(output && typeof output === "object" && !Array.isArray(output));
  });
  const fullTextMatches = checkpoint?.readMode === "full-text"
    && Array.isArray(checkpoint.expectedParts)
    && checkpoint.expectedParts.length === expectedParts.length
    && checkpoint.expectedParts.every((part, index) => part === expectedParts[index])
    && hasFullTextResult;
  const batchMatches = Number.isInteger(checkpoint?.batchCount)
    && (checkpoint?.batchCount ?? 0) > 0
    && typeof checkpoint?.batches?.["0"] === "string";
  return Boolean(
    checkpoint
    && checkpoint.sourceSha256 === paper.sourceSha256
    && checkpoint.depth === depth
    && (fullTextMatches || batchMatches),
  );
}

type Tone = "green" | "amber" | "red" | "blue" | "gray";

/** 论文的分析状态：文字和颜色，列表和详情共用。 */
export function analysisState(paper: Paper, analyzing: boolean): { label: string; tone: Tone } {
  if (analyzing || paper.analysisStatus === "running") return { label: "分析中", tone: "blue" };
  if (paper.status !== "parsed") return { label: paperStatusLabels[paper.status], tone: "red" };
  if (paper.analysisStatus === "failed") return canResumePaper(paper) ? { label: "可继续", tone: "amber" } : { label: "失败", tone: "red" };
  if (paper.analysisStatus === "stale") return { label: "需更新", tone: "amber" };
  if (paper.analysisStatus === "complete") return { label: "已完成", tone: "green" };
  return { label: analysisStatusLabels[paper.analysisStatus ?? "none"], tone: "gray" };
}

/** 这篇论文现在能做的分析操作。 */
export function analysisAction(paper: Paper, analyzing: boolean): { label: string; disabled: boolean; primary: boolean } {
  if (analyzing) return { label: "分析中", disabled: true, primary: false };
  if (paper.status !== "parsed") return { label: "无法分析", disabled: true, primary: false };
  if (canResumePaper(paper)) return { label: "继续分析", disabled: false, primary: true };
  if (paper.analysisScript?.trim()) return { label: "重新生成", disabled: false, primary: false };
  if (paper.analysisStatus === "failed") return { label: "从头重试", disabled: false, primary: true };
  return { label: "开始分析", disabled: false, primary: true };
}

/** 补上句末标点，方便和后面的说明连在一起。 */
export const sentence = (text: string) => /[。！？.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}。`;

/** 显示在论文那一行下面的说明：为什么不能分析、哪里出错、能不能继续。 */
function paperNotice(paper: Paper): { text: string; tone: "amber" | "red" } | null {
  if (paper.status !== "parsed") return { text: "没有可检索的文本（例如扫描版 PDF），不能分析，也不能在讨论里引用。", tone: "red" };
  if (paper.analysisStatus === "failed") return { text: `${sentence(paper.error || "分析没有完成")}${canResumePaper(paper) ? "已完成的步骤会保留，继续分析会接着做。" : ""}`, tone: canResumePaper(paper) ? "amber" : "red" };
  if (paper.analysisStatus === "stale") return { text: "原文或分析设置有变化，旧分析稿可能不准确。", tone: "amber" };
  return null;
}

const experimentStatusLabels: Record<string, { label: string; tone: Tone }> = {
  needs_input: { label: "等你作答", tone: "amber" },
  waiting: { label: "等你批准", tone: "amber" },
  running: { label: "运行中", tone: "blue" },
  idle: { label: "空闲", tone: "gray" },
};

type Filter = "all" | "todo" | "attention" | "done";
const filterOf = (paper: Paper, analyzing: boolean): Exclude<Filter, "all"> => {
  if (analyzing || paper.analysisStatus === "running" || (paper.status === "parsed" && (paper.analysisStatus ?? "none") === "none")) return "todo";
  if (paper.status !== "parsed" || paper.analysisStatus === "failed" || paper.analysisStatus === "stale") return "attention";
  return "done";
};

export function PapersView({ project, papers, tasks, progressFor, experiments, onImport, onAnalyze, onAnalyzeAll, onOpen, onOpenExternal, onToggleRole, onReproduce, onOpenExperiment }: {
  project: Project;
  papers: Paper[];
  tasks: ReadonlySet<string>;
  progressFor: (paperId: string) => PaperAnalysisProgress | null;
  experiments: ExperimentSummary[] | null;
  onImport: () => void;
  onAnalyze: (paper: Paper) => void;
  onAnalyzeAll: () => void;
  onOpen: (paper: Paper) => void;
  onOpenExternal: (paper: Paper) => void;
  onToggleRole: (paper: Paper) => void;
  onReproduce: (paper: Paper) => void;
  onOpenExperiment: (experimentId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const importing = tasks.has(taskKeys.importPapers(project.id));
  const rows = papers.map((paper) => {
    const analyzing = isAnalyzing(tasks, project.id, paper.id) || isLiveProgress(progressFor(paper.id));
    return { paper, analyzing, group: filterOf(paper, analyzing) };
  });
  const counts = { all: rows.length, todo: 0, attention: 0, done: 0 } as Record<Filter, number>;
  for (const row of rows) counts[row.group] += 1;
  const analysisCount = papers.filter((paper) => paper.analysisScript?.trim()).length;
  const runningCount = rows.filter((row) => row.analyzing).length;
  const analyzingAny = anyAnalysis(tasks, project.id) || runningCount > 0;
  const visible = rows.filter((row) => filter === "all" || row.group === filter);

  useEffect(() => {
    if (!menuFor) return;
    const close = (event: MouseEvent) => { if (!(event.target as Element | null)?.closest?.(".pa-menu, .pa-menu-trigger")) setMenuFor(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuFor(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [menuFor]);

  const filters: Array<{ id: Filter; label: string }> = [{ id: "all", label: "全部" }, { id: "todo", label: "待分析" }, { id: "attention", label: "需要处理" }, { id: "done", label: "已完成" }];

  return <div className="pa-page">
    <header className="pa-page-head">
      <div>
        <h1>文献分析</h1>
        <p>{papers.length} 篇 · {analysisCount} 篇有分析稿{runningCount ? ` · ${runningCount} 篇正在分析` : ""}</p>
      </div>
      <div className="pa-page-actions">
        <button className="button" onClick={onAnalyzeAll} disabled={analyzingAny || !papers.some((paper) => paper.status === "parsed")}><Sparkles size={14} />分析全部未完成的</button>
        <button className="button button--primary" onClick={onImport} disabled={importing}>{importing ? <LoaderCircle className="spin" size={14} /> : <FilePlus2 size={14} />}导入 PDF</button>
      </div>
    </header>

    {papers.length ? <>
      <div className="pa-filters" role="group" aria-label="筛选论文">
        {filters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} className={filter === item.id ? "is-active" : ""} onClick={() => setFilter(item.id)}>{item.label}<span>{counts[item.id]}</span></button>)}
      </div>
      <section className="pa-table" aria-label="论文列表">
        <div className="pa-row pa-row--head"><span>论文</span><span>角色</span><span>分析</span><span>复现</span><span>页数 · 导入</span><span /></div>
        {visible.length ? visible.map(({ paper, analyzing }) => {
          const role = paper.role ?? "core";
          const state = analysisState(paper, analyzing);
          const action = analysisAction(paper, analyzing);
          const progress = analyzing ? progressFor(paper.id) : null;
          const notice = analyzing ? null : paperNotice(paper);
          const reproductions = (experiments ?? []).filter((item) => item.paperId === paper.id);
          const reproduction = reproductions[0];
          const reproductionState = reproduction ? experimentStatusLabels[reproduction.status ?? "idle"] ?? experimentStatusLabels.idle : null;
          return <div className="pa-row-wrap" key={paper.id}>
            <div className="pa-row">
              <button type="button" className="pa-title" onClick={() => onOpen(paper)}><FileText size={15} aria-hidden="true" /><span><strong>{paper.title}</strong><small>{paper.filename}</small></span></button>
              <span><span className={`pa-role pa-role--${role}`}>{paperRoleLabels[role]}</span></span>
              <span className="pa-state">
                <span className={`pa-pill pa-pill--${state.tone}`}>{state.label}</span>
                {progress && <span className="pa-progress"><span><i style={{ width: `${progress.total ? Math.round((progress.current / progress.total) * 100) : 5}%` }} /></span>第 {progress.current}/{progress.total} 批</span>}
              </span>
              <span className="pa-repro">{reproduction && reproductionState
                ? <button type="button" className="pa-link-button" onClick={() => onOpenExperiment(reproduction.id)} title={reproduction.title}><span className="pa-repro-title">{reproduction.title}</span><span className={`pa-pill pa-pill--${reproductionState.tone}`}>{reproductionState.label}</span>{reproductions.length > 1 && <small>+{reproductions.length - 1}</small>}</button>
                : <span className="pa-muted">—</span>}</span>
              <span className="pa-meta">{paper.pageCount || "--"} 页 · {formatDate(paper.importedAt)}</span>
              <span className="pa-actions">
                <button type="button" className={`button button--small ${action.primary ? "pa-button-strong" : ""}`} disabled={action.disabled} onClick={() => onAnalyze(paper)}>{analyzing ? <LoaderCircle className="spin" size={12} /> : canResumePaper(paper) ? <Play size={12} /> : paper.analysisScript ? <RefreshCw size={12} /> : <Sparkles size={12} />}{action.label}</button>
                <button type="button" className="button button--small pa-menu-trigger" aria-label="更多操作" aria-haspopup="menu" aria-expanded={menuFor === paper.id} onClick={() => setMenuFor((current) => current === paper.id ? null : paper.id)}><MoreHorizontal size={15} /></button>
              </span>
            </div>
            {notice && <p className={`pa-notice pa-notice--${notice.tone}`}><CircleAlert size={13} />{notice.text}</p>}
            {menuFor === paper.id && <div className="pa-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenuFor(null); onOpen(paper); }}>打开详情</button>
              <button type="button" role="menuitem" className="pa-menu-strong" disabled={paper.status !== "parsed"} onClick={() => { setMenuFor(null); onReproduce(paper); }}><FlaskConical size={14} />复现这篇论文</button>
              <button type="button" role="menuitem" disabled={analyzing} onClick={() => { setMenuFor(null); onToggleRole(paper); }}>{role === "core" ? "设为非常规（简化分析）" : "设为核心论文"}</button>
              <button type="button" role="menuitem" onClick={() => { setMenuFor(null); onOpenExternal(paper); }}>用系统程序打开 PDF</button>
            </div>}
          </div>;
        }) : <p className="pa-table-empty">这个筛选下没有论文。</p>}
      </section>
      <p className="pa-footnote">点论文只会打开详情。分析在后台进行，可以先去别的页面，完成后会提示你。</p>
    </> : <EmptyState icon={<BookOpen size={22} />} title="还没有文献" action="导入 PDF" onAction={onImport} />}
  </div>;
}

function AnalysisAiCallLog({ projectId, paperId, call }: { projectId: string; paperId: string; call: PaperAnalysisAiCall }) {
  const [log, setLog] = useState<PaperAnalysisCallLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);
  const status = call.status === "complete" ? "完成" : call.status === "failed" ? "失败" : "进行中";

  useEffect(() => {
    if (!opened) return;
    let active = true;
    setLoading(true);
    setError("");
    window.autoresearch.readPaperAnalysisCallLog({ projectId, paperId, callId: call.id })
      .then((result) => { if (active) setLog(result); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [call.id, call.status, opened, paperId, projectId]);

  return <details className="analysis-ai-call" onToggle={(event) => setOpened(event.currentTarget.open)}>
    <summary><span>{call.label}</span><small>{status} · {new Date(call.startedAt).toLocaleString("zh-CN")}</small></summary>
    {loading && <p className="analysis-ai-call-state">正在读取调用日志…</p>}
    {error && <p className="analysis-ai-call-error">读取失败：{error}</p>}
    {log && <div className="analysis-ai-call-body">
      {log.request.messages.map((message, index) => <section key={`${message.role}-${index}`}>
        <strong>{message.role === "system" ? "系统指令" : message.role === "user" ? "本次输入" : message.role}</strong>
        <pre>{message.content}</pre>
      </section>)}
      <section>
        <strong>模型原始返回</strong>
        {log.source && <small>来源：{log.source}</small>}
        <pre>{log.rawResponse || "（没有收到可读返回）"}</pre>
      </section>
      {log.error && <p className="analysis-ai-call-error">调用失败：{log.error}</p>}
    </div>}
  </details>;
}

export function AnalysisTraceView({ trace, projectId, papers, paperId, onOpenPaper, progress, className }: {
  trace: PaperAnalysisTrace;
  projectId: string;
  papers: Paper[];
  paperId?: string;
  onOpenPaper: (paper: Paper, page?: number, quote?: string) => void;
  progress?: PaperAnalysisProgress | null;
  className?: string;
}) {
  const stateLabel = trace.status === "complete" ? "已完成" : trace.status === "failed" ? "失败" : "进行中";
  const stateIcon = (status: PaperAnalysisTrace["steps"][number]["status"]) => status === "complete"
    ? <Check size={13} />
    : status === "failed" ? <CircleAlert size={13} /> : <LoaderCircle className="spin" size={13} />;
  const tracePaper = paperId ? papers.find((item) => item.id === paperId) : undefined;

  return <section className={`analysis-trace${progress ? " is-live" : ""}${className ? ` ${className}` : ""}`}>
    <header className="analysis-trace-head">
      <div><h2>分析过程</h2><span className={`analysis-trace-state is-${trace.status}`}>{stateLabel}</span></div>
      <small>{progress ? `${progress.current}/${progress.total} 批 · ${progress.section || "准备中"}` : new Date(trace.startedAt).toLocaleString("zh-CN")}</small>
    </header>
    <ol className="analysis-trace-list">
      {trace.steps.map((step) => <li className={`analysis-trace-step is-${step.status}`} key={step.id}>
        <div className="analysis-trace-step-head"><span className="analysis-trace-mark">{stateIcon(step.status)}</span><div><h3>{step.title}</h3><small>{step.status === "complete" ? "完成" : step.status === "failed" ? "失败" : "正在执行"}</small></div></div>
        <p className="analysis-trace-input">输入：{step.inputSummary}</p>
        {step.outputSummary && <p className="analysis-trace-output">产出：{step.outputSummary}</p>}
        {step.aiCalls?.length ? <details className="analysis-ai-calls" open={step.status === "running" && step.aiCalls.some((call) => call.status === "running")}>
          <summary>AI 调用记录（{step.aiCalls.length}）</summary>
          <div>{step.aiCalls.map((call) => <AnalysisAiCallLog key={call.id} projectId={projectId} paperId={paperId ?? tracePaper?.id ?? ""} call={call} />)}</div>
        </details> : null}
        {step.inputChunks?.length ? <details className="analysis-trace-inputs" open={step.status === "running"}>
          <summary>查看输入原文（{step.inputChunks.length}）</summary>
          <div className="analysis-trace-input-list">{step.inputChunks.map((chunk) => {
            const refPaperId = chunk.chunkId.includes("#") ? chunk.chunkId.split("#")[0] : paperId;
            const paper = papers.find((item) => item.id === refPaperId) ?? tracePaper;
            return <article className="analysis-trace-input-item" key={chunk.chunkId}>
              <div className="analysis-trace-input-meta"><code>{chunk.chunkId}</code><span>{chunk.page ? `第 ${chunk.page} 页` : "页码未知"}{chunk.section ? ` · ${chunk.section}` : ""}</span></div>
              <p>{chunk.preview}{chunk.truncated ? "…" : ""}</p>
              {paper && chunk.page ? <button type="button" onClick={() => onOpenPaper(paper, chunk.page, chunk.preview)}><BookOpen size={11} />在 PDF 中打开</button> : null}
            </article>;
          })}</div>
        </details> : step.chunkIds?.length ? <details className="analysis-trace-inputs"><summary>查看输入片段编号（{step.chunkIds.length}）</summary><div>{step.chunkIds.map((id) => <code key={id}>{id}</code>)}</div></details> : null}
      </li>)}
    </ol>
    {trace.error && <p className="analysis-trace-error"><CircleAlert size={13} />{trace.error}</p>}
  </section>;
}

