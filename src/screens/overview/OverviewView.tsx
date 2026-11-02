import { useState, type ReactNode } from "react";
import { CircleAlert, CircleHelp, FilePlus2, Package, Pencil, SquareTerminal, CircleCheck } from "lucide-react";
import type { ExperimentSummary, Idea, Paper, PaperAnalysisProgress, Project, View } from "../../types";
import type { ProjectEnvironmentSnapshot } from "../project-environment/model";
import { formatDate, statusLabels } from "../../uiText";
import { isAnalyzing, isLiveProgress } from "../../app/tasks";
import { canResumePaper, sentence } from "../paper-analysis/PaperAnalysisWorkspace";
import "./screen.css";

type Tone = "green" | "amber" | "red" | "blue" | "gray";

interface NeedItem {
  key: string;
  icon: ReactNode;
  tone: Tone;
  title: string;
  detail: string;
  action: string;
  primary?: boolean;
  onAction: () => void;
}

const shortTitle = (title: string, max = 28) => title.length > max ? `${title.slice(0, max)}…` : title;

const experimentStatus: Record<string, { label: string; tone: Tone }> = {
  needs_input: { label: "等你作答", tone: "amber" },
  waiting: { label: "等你批准", tone: "amber" },
  running: { label: "运行中", tone: "blue" },
  idle: { label: "空闲", tone: "gray" },
};

export function OverviewView({ project, ideas, experiments, environment, tasks, progress, onEdit, onView, onImport, onAnalyze, onOpenExperiment, onOpenDiscussion, onEditIdea }: {
  project: Project;
  ideas: Idea[];
  /** null 表示还在读取 */
  experiments: ExperimentSummary[] | null;
  environment: ProjectEnvironmentSnapshot | null;
  tasks: ReadonlySet<string>;
  /** 最近一次收到的分析进度 */
  progress: PaperAnalysisProgress | null;
  onEdit: () => void;
  onView: (view: View) => void;
  onImport: () => void;
  onAnalyze: (paper: Paper) => void;
  onOpenExperiment: (experimentId: string) => void;
  onOpenDiscussion: (discussionId: string) => void;
  onEditIdea: (idea: Idea) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const papers = project.papers;
  const analyzing = (paper: Paper) => isAnalyzing(tasks, project.id, paper.id) || (progress?.paperId === paper.id && isLiveProgress(progress));

  // ---------- 需要你处理 ----------
  const needs: NeedItem[] = [];
  for (const item of experiments ?? []) {
    if (item.status === "needs_input") needs.push({
      key: `q-${item.id}`, icon: <CircleHelp size={15} />, tone: "amber", title: `${item.title} · Codex 在等你回答`,
      detail: item.activity && item.activity !== "等待你作答" ? item.activity : "实验已暂停，回答问题后会继续。", action: "去回答", primary: true,
      onAction: () => onOpenExperiment(item.id),
    });
    if (item.pendingJobs > 0) needs.push({
      key: `j-${item.id}`, icon: <SquareTerminal size={15} />, tone: "blue", title: `${item.title} · ${item.pendingJobs} 个后台任务等你批准`,
      detail: "后台任务在沙箱外运行，需要你确认后才会开始。", action: "查看",
      onAction: () => onOpenExperiment(item.id),
    });
  }
  const request = environment?.request;
  if (request && (!request.status || request.status === "pending")) {
    const changes = (request.plan?.changes ?? request.changes ?? []).length;
    needs.push({
      key: "env-request", icon: <Package size={15} />, tone: "gray", title: "运行环境 · 依赖申请待核对",
      detail: `${changes ? `${changes} 项依赖变更` : "依赖变更"}${request.experiment ? `，来自 ${request.experiment}` : ""}${request.note ? `：${request.note}` : ""}`, action: "核对",
      onAction: () => onView("project-environment"),
    });
  }
  for (const paper of papers) {
    if (analyzing(paper)) continue;
    if (paper.analysisStatus === "failed") needs.push({
      key: `p-${paper.id}`, icon: <CircleAlert size={15} />, tone: "red", title: `${shortTitle(paper.title)} · 分析中断`,
      detail: `${sentence(paper.error || "分析没有完成")}${canResumePaper(paper) ? "已完成的步骤会保留。" : ""}`, action: canResumePaper(paper) ? "继续分析" : "重试",
      onAction: () => onAnalyze(paper),
    });
    else if (paper.analysisStatus === "stale") needs.push({
      key: `s-${paper.id}`, icon: <CircleAlert size={15} />, tone: "amber", title: `${shortTitle(paper.title)} · 分析稿需要更新`,
      detail: "原文或分析设置有变化，旧分析稿可能不准确。", action: "重新生成",
      onAction: () => onAnalyze(paper),
    });
  }

  // ---------- 文献状态 ----------
  const counts = { done: 0, running: 0, attention: 0, none: 0 };
  for (const paper of papers) {
    if (analyzing(paper) || paper.analysisStatus === "running") counts.running += 1;
    else if (paper.status !== "parsed" || paper.analysisStatus === "failed" || paper.analysisStatus === "stale") counts.attention += 1;
    else if (paper.analysisStatus === "complete") counts.done += 1;
    else counts.none += 1;
  }
  const runningPaper = progress ? papers.find((paper) => paper.id === progress.paperId) : undefined;
  const analysisCount = papers.filter((paper) => paper.analysisScript?.trim()).length;

  // ---------- 实验、讨论、Idea ----------
  const recentExperiments = [...(experiments ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  const discussions = [...(project.discussions ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  const activeIdeas = ideas.filter((idea) => idea.status !== "rejected").slice(0, 3);
  const env = environment?.environment;

  return <div className="ov-page">
    <header className="ov-head">
      <div className="ov-head-copy">
        <h1>{project.title}</h1>
        {project.direction ? <>
          <p className={expanded ? "" : "is-clamped"}>{project.direction}</p>
          {project.direction.length > 140 && <button type="button" className="ov-link" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : "展开"}</button>}
        </> : <p className="ov-muted">还没有写研究方向。写下研究问题、目标和已有条件，讨论和分析都会参考它。</p>}
      </div>
      <button type="button" className="button" onClick={onEdit}><Pencil size={13} />编辑课题</button>
    </header>

    <section className="ov-card" aria-labelledby="ov-needs-title">
      <div className="ov-card-head">
        <h2 id="ov-needs-title">需要你处理{needs.length > 0 && <span className="ov-pill ov-pill--amber">{needs.length}</span>}</h2>
        <span className="ov-muted">来自实验复现、运行环境和文献分析</span>
      </div>
      {needs.length ? needs.slice(0, 6).map((item) => <div className="ov-need" key={item.key}>
        <span className={`ov-need-icon ov-need-icon--${item.tone}`} aria-hidden="true">{item.icon}</span>
        <div className="ov-need-copy"><strong>{item.title}</strong><span>{item.detail}</span></div>
        <button type="button" className={`button button--small ${item.primary ? "button--primary" : ""}`} onClick={item.onAction}>{item.action}</button>
      </div>) : <div className="ov-need ov-need--calm"><span className="ov-need-icon ov-need-icon--green" aria-hidden="true"><CircleCheck size={15} /></span><div className="ov-need-copy"><strong>没有需要你处理的事</strong><span>实验的提问、待批准的任务、依赖申请和中断的分析会出现在这里。</span></div></div>}
      {needs.length > 6 && <p className="ov-more">还有 {needs.length - 6} 项，打开对应页面查看。</p>}
    </section>

    <div className="ov-status">
      <article className="ov-card ov-status-card">
        <div className="ov-status-head"><strong>文献分析</strong><button type="button" className="ov-link" onClick={() => onView("papers")}>打开</button></div>
        {papers.length ? <>
          <div className="ov-figure"><b>{papers.length} 篇</b><span>{analysisCount} 篇有分析稿</span></div>
          <div className="ov-bar" aria-hidden="true">
            {counts.done > 0 && <span style={{ flex: counts.done }} className="is-done" />}
            {counts.running > 0 && <span style={{ flex: counts.running }} className="is-running" />}
            {counts.attention > 0 && <span style={{ flex: counts.attention }} className="is-attention" />}
            {counts.none > 0 && <span style={{ flex: counts.none }} className="is-none" />}
          </div>
          <div className="ov-legend"><span><i className="is-done" />已完成 {counts.done}</span><span><i className="is-running" />分析中 {counts.running}</span><span><i className="is-attention" />需要处理 {counts.attention}</span><span><i className="is-none" />未分析 {counts.none}</span></div>
          <small className="ov-muted">{runningPaper && progress ? `${shortTitle(runningPaper.title, 24)} 正在分析 · 第 ${progress.current}/${progress.total} 批` : counts.none ? `${counts.none} 篇还没有分析` : "全部论文都已处理"}</small>
        </> : <div className="ov-status-empty"><span className="ov-muted">还没有文献。</span><button type="button" className="button button--small button--primary" onClick={onImport}><FilePlus2 size={13} />导入 PDF</button></div>}
      </article>

      <article className="ov-card ov-status-card">
        <div className="ov-status-head"><strong>实验</strong><button type="button" className="ov-link" onClick={() => onView("experiments")}>打开</button></div>
        {experiments === null ? <span className="ov-muted">正在读取…</span> : recentExperiments.length ? <ul className="ov-list">
          {recentExperiments.map((item) => {
            const status = experimentStatus[item.status ?? "idle"] ?? experimentStatus.idle;
            return <li key={item.id}><button type="button" onClick={() => onOpenExperiment(item.id)}><span title={item.title}>{item.title}</span><span className={`ov-pill ov-pill--${status.tone}`}>{status.label}</span></button></li>;
          })}
        </ul> : <span className="ov-muted">还没有实验。在文献里点“复现这篇论文”开始。</span>}
        {experiments && experiments.length > 3 && <small className="ov-muted">共 {experiments.length} 个实验</small>}
      </article>

      <article className="ov-card ov-status-card">
        <div className="ov-status-head"><strong>运行环境</strong><button type="button" className="ov-link" onClick={() => onView("project-environment")}>管理</button></div>
        {!environment ? <span className="ov-muted">正在读取…</span> : env ? <>
          <div className="ov-env"><b className="ov-mono">{env.name}</b><span>Conda · Python {env.pythonVersion} · 修订 {env.revision}</span></div>
          <div className="ov-tags">
            {environment.error ? <span className="ov-pill ov-pill--red">需要检查</span> : environment.locked ? <span className="ov-pill ov-pill--blue">使用中，已锁定</span> : <span className="ov-pill ov-pill--green">可用</span>}
            {request && (!request.status || request.status === "pending") && <span className="ov-pill ov-pill--amber">1 个依赖申请</span>}
          </div>
          <small className="ov-muted">{environment.locked ? "实验运行期间不能改动依赖" : `${environment.packages.length} 个依赖`}</small>
        </> : <div className="ov-status-empty"><span className="ov-muted">还没有配置运行环境。实验会用它安装依赖、运行代码。</span><button type="button" className="button button--small" onClick={() => onView("project-environment")}>去配置</button></div>}
      </article>
    </div>

    <div className="ov-columns">
      <section className="ov-card">
        <div className="ov-card-head"><h2>最近的讨论</h2><button type="button" className="ov-link" onClick={() => onView("discussion")}>全部讨论</button></div>
        {discussions.length ? discussions.map((item) => <button type="button" className="ov-row" key={item.id} onClick={() => onOpenDiscussion(item.id)}>
          <strong>{item.title}</strong>
          {item.preview && <span className="ov-row-preview">{item.preview}</span>}
          <small className="ov-muted">{formatDate(item.updatedAt)} · {item.messageCount} 条</small>
        </button>) : <p className="ov-empty">还没有讨论。<button type="button" className="ov-link" onClick={() => onView("discussion")}>开始一个讨论</button></p>}
      </section>
      <section className="ov-card">
        <div className="ov-card-head"><h2>候选设想</h2><button type="button" className="ov-link" onClick={() => onView("experiments")}>去实验</button></div>
        {activeIdeas.length ? activeIdeas.map((idea) => <button type="button" className="ov-row" key={idea.id} onClick={() => onEditIdea(idea)}>
          <span className="ov-row-title"><strong>{idea.title}</strong><span className={`ov-pill ov-pill--${idea.status === "continue" ? "green" : "gray"}`}>{statusLabels[idea.status]}</span></span>
          <span className="ov-row-preview">{idea.mechanism}</span>
        </button>) : <p className="ov-empty">还没有 Idea。讨论里的回答可以直接存为 Idea。</p>}
      </section>
    </div>
  </div>;
}
