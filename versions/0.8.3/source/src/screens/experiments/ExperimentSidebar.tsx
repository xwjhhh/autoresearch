import { FlaskConical, Lightbulb, Plus } from "lucide-react";
import type { ExperimentSummary, ExperimentVerdict, Idea } from "../../types";

export type ExperimentSelection = { type: "experiment"; id: string } | { type: "idea"; id: string } | null;

type Tone = "blue" | "amber" | "red" | "gray" | "green";

export const verdictLabels: Record<ExperimentVerdict, { label: string; tone: Tone }> = {
  supported: { label: "支持假设", tone: "green" },
  refuted: { label: "不支持", tone: "red" },
  inconclusive: { label: "不确定", tone: "gray" },
};

const runStatus: Record<string, { label: string; tone: Tone }> = {
  needs_input: { label: "等你作答", tone: "amber" },
  waiting: { label: "等你批准", tone: "amber" },
  running: { label: "运行中", tone: "blue" },
  idle: { label: "空闲", tone: "gray" },
};

const ideaStatusLabels: Record<string, string> = { candidate: "设想", continue: "进行中", parked: "搁置", rejected: "已放弃" };

export const isDesignedSummary = (item: Pick<ExperimentSummary, "type" | "kind">) => item.type === "designed" || item.kind === "设计实验" || item.kind === "自主实验";

/** 实验页左侧：设想、设计实验、论文复现三组。设想就是原来的 Idea，开始实验后归到设计实验下面。 */
export function ExperimentSidebar({ summaries, ideas, selection, onSelect, onNewReproduction, onNewIdea }: {
  summaries: ExperimentSummary[];
  ideas: Idea[];
  selection: ExperimentSelection;
  onSelect: (selection: ExperimentSelection) => void;
  onNewReproduction: () => void;
  onNewIdea: () => void;
}) {
  const ordered = [...summaries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const designed = ordered.filter(isDesignedSummary);
  const reproductions = ordered.filter((item) => !isDesignedSummary(item));
  const openIdeas = ideas.filter((idea) => idea.status !== "rejected" && !(idea.experimentIds?.length))
    .sort((a, b) => (a.status === "parked" ? 1 : 0) - (b.status === "parked" ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt));
  const rejected = ideas.filter((idea) => idea.status === "rejected");
  const reproductionTitle = new Map(reproductions.map((item) => [item.id, item.title]));
  const isActive = (type: "experiment" | "idea", id: string) => selection?.type === type && selection.id === id;

  const experimentItem = (item: ExperimentSummary) => {
    const status = runStatus[item.status ?? "idle"] ?? runStatus.idle;
    const verdict = item.outcome ? verdictLabels[item.outcome] : null;
    return <button type="button" key={item.id} className={`exp-side-item ${isActive("experiment", item.id) ? "is-active" : ""}`} aria-current={isActive("experiment", item.id) ? "true" : undefined} onClick={() => onSelect({ type: "experiment", id: item.id })}>
      <strong title={item.title}>{item.title}</strong>
      <span className="exp-side-meta">
        <span className="exp-side-id">{item.id}</span>
        {verdict ? <span className={`exp-pill exp-pill--${verdict.tone}`}>{verdict.label}</span> : status.tone !== "gray" && <span className={`exp-pill exp-pill--${status.tone}`}>{status.label}</span>}
      </span>
    </button>;
  };

  return <aside className="exp-side" aria-label="实验列表">
    <div className="exp-side-head">
      <strong>实验</strong>
      <span className="exp-side-actions">
        <button type="button" className="button button--small" onClick={onNewIdea} title="记录一个设想，之后可以据此设计实验"><Lightbulb size={13} />设想</button>
        <button type="button" className="button button--small" onClick={onNewReproduction} title="复现一篇论文的实验"><Plus size={13} />复现</button>
      </span>
    </div>
    <div className="exp-side-body">
      <section className="exp-side-group" aria-label="设想">
        <h3><Lightbulb size={12} />设想<small>{openIdeas.length || ""}</small></h3>
        {openIdeas.length ? openIdeas.map((idea) => <button type="button" key={idea.id} className={`exp-side-item ${isActive("idea", idea.id) ? "is-active" : ""} ${idea.status === "parked" ? "is-muted" : ""}`} aria-current={isActive("idea", idea.id) ? "true" : undefined} onClick={() => onSelect({ type: "idea", id: idea.id })}>
          <strong title={idea.title}>{idea.title}</strong>
          <span className="exp-side-meta">
            <span className="exp-side-id">{ideaStatusLabels[idea.status] ?? "设想"}</span>
            {idea.baselineId && <span className="exp-side-note" title={reproductionTitle.get(idea.baselineId) ?? idea.baselineId}>基线 {idea.baselineId}</span>}
          </span>
        </button>) : <p className="exp-side-empty">还没有设想。讨论里的回答可以“存为 Idea”，也可以在这里直接记录。</p>}
      </section>
      <section className="exp-side-group" aria-label="设计实验">
        <h3><FlaskConical size={12} />设计实验<small>{designed.length || ""}</small></h3>
        {designed.length ? designed.map(experimentItem) : <p className="exp-side-empty">从一个设想开始，agent 会在基线代码上实现并验证它。</p>}
      </section>
      <section className="exp-side-group" aria-label="论文复现">
        <h3><FlaskConical size={12} />论文复现<small>{reproductions.length || ""}</small></h3>
        {reproductions.length ? reproductions.map(experimentItem) : <p className="exp-side-empty">先复现一篇论文，它可以作为设计实验的基线。</p>}
      </section>
      {rejected.length > 0 && <details className="exp-side-group exp-side-rejected">
        <summary>已放弃的设想 {rejected.length}</summary>
        {rejected.map((idea) => <button type="button" key={idea.id} className={`exp-side-item is-muted ${isActive("idea", idea.id) ? "is-active" : ""}`} onClick={() => onSelect({ type: "idea", id: idea.id })}>
          <strong title={idea.title}>{idea.title}</strong>
          {idea.rejectedReason && <span className="exp-side-meta"><span className="exp-side-note">{idea.rejectedReason}</span></span>}
        </button>)}
      </details>}
    </div>
  </aside>;
}
