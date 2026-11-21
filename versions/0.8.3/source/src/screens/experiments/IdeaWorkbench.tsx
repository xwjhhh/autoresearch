import { useState, type FormEvent } from "react";
import { Archive, Check, FlaskConical, Lightbulb, LoaderCircle, Pencil, Play, RotateCcw, X } from "lucide-react";
import type { ExperimentSettings, ExperimentSummary, Idea, IdeaStatus, Paper } from "../../types";
import { Modal } from "../../components/Shared";
import { Markdown } from "../../components/markdown.jsx";
import { isDesignedSummary, verdictLabels } from "./ExperimentSidebar";

const statusLabels: Record<IdeaStatus, string> = { candidate: "设想", continue: "进行中", parked: "搁置", rejected: "已放弃" };

/** 设想详情：原来 Idea 池里的一条 Idea。可以编辑、搁置、放弃，或据此开始设计实验。 */
export function IdeaDetail({ idea, summaries, papers, busy, onEdit, onStatus, onStart, onOpenExperiment }: {
  idea: Idea;
  summaries: ExperimentSummary[];
  papers: Paper[];
  busy: boolean;
  onEdit: () => void;
  onStatus: (status: IdeaStatus, reason?: string) => Promise<boolean>;
  onStart: () => void;
  onOpenExperiment: (experimentId: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState(idea.rejectedReason ?? "");
  const baseline = summaries.find((item) => item.id === idea.baselineId);
  const experiments = summaries.filter((item) => isDesignedSummary(item) && (item.ideaId === idea.id || idea.experimentIds?.includes(item.id)));
  const linkedPapers = (idea.paperIds ?? []).map((id) => papers.find((paper) => paper.id === id)).filter((paper): paper is Paper => Boolean(paper));

  return <div className="exp-idea">
    <header className="exp-idea-head">
      <span className="exp-idea-icon" aria-hidden="true"><Lightbulb size={16} /></span>
      <div className="exp-idea-title">
        <h1>{idea.title}</h1>
        <span className="exp-muted">{idea.id} · {statusLabels[idea.status]}{idea.pipelineSource ? " · 来自讨论" : ""}</span>
      </div>
      <div className="exp-idea-actions">
        <button type="button" className="button" disabled={busy} onClick={onEdit}><Pencil size={13} />编辑</button>
        {idea.status === "rejected" || idea.status === "parked"
          ? <button type="button" className="button" disabled={busy} onClick={() => void onStatus("candidate")}><RotateCcw size={13} />恢复为设想</button>
          : <button type="button" className="button" disabled={busy} onClick={() => void onStatus("parked")}><Archive size={13} />搁置</button>}
        {idea.status !== "rejected" && <button type="button" className="button" disabled={busy} onClick={() => setRejecting(true)}><X size={13} />放弃</button>}
        <button type="button" className="button button--primary" disabled={busy || idea.status === "rejected"} onClick={onStart}><Play size={13} />开始设计实验</button>
      </div>
    </header>

    {rejecting && <form className="exp-idea-reject" onSubmit={async (event) => { event.preventDefault(); if (await onStatus("rejected", reason)) setRejecting(false); }}>
      <label htmlFor="idea-reject">放弃的理由</label>
      <input id="idea-reject" value={reason} autoFocus maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="例如：已有工作做过；实验成本太高" required />
      <button className="button button--small" disabled={!reason.trim() || busy}>确认放弃</button>
      <button type="button" className="button button--small" onClick={() => setRejecting(false)}>取消</button>
    </form>}
    {idea.status === "rejected" && idea.rejectedReason && <p className="exp-idea-rejected">放弃理由：{idea.rejectedReason}</p>}

    <div className="exp-idea-body">
      <section><h2>想法</h2><p>{idea.mechanism}</p></section>
      <section><h2>要验证的假设</h2>{idea.experiment ? <p>{idea.experiment}</p> : <p className="exp-muted">还没写。写清楚“改什么、预期指标怎么变”，agent 会据此设计对照实验。</p>}</section>
      {idea.difference && <section><h2>与已有方法的区别</h2><p>{idea.difference}</p></section>}
      {idea.evidence && <section><h2>关联论文与证据</h2><p>{idea.evidence}</p></section>}
      <section className="exp-idea-grid">
        <div><h2>基线</h2>{baseline
          ? <button type="button" className="exp-link" onClick={() => onOpenExperiment(baseline.id)}>{baseline.title}（{baseline.id}）</button>
          : <p className="exp-muted">{idea.baselineId ? `${idea.baselineId}（找不到这个实验）` : "没有指定。开始实验时可以选一个论文复现作为基线。"}</p>}</div>
        <div><h2>关联论文</h2>{linkedPapers.length ? <ul>{linkedPapers.map((paper) => <li key={paper.id}>{paper.title}</li>)}</ul> : <p className="exp-muted">没有指定。</p>}</div>
      </section>
      {experiments.length > 0 && <section>
        <h2>由这个设想开始的实验</h2>
        <ul className="exp-idea-experiments">{experiments.map((item) => {
          const verdict = item.outcome ? verdictLabels[item.outcome] : null;
          return <li key={item.id}><button type="button" className="exp-link" onClick={() => onOpenExperiment(item.id)}>{item.title}（{item.id}）</button>{verdict && <span className={`exp-pill exp-pill--${verdict.tone}`}>{verdict.label}</span>}</li>;
        })}</ul>
      </section>}
      {idea.draft && <section><h2>设想稿</h2><div className="exp-markdown"><Markdown source={idea.draft} /></div></section>}
    </div>
  </div>;
}

/** 新建或编辑设想。 */
export function IdeaEditorModal({ idea, summaries, papers, busy, error, onClose, onSave }: {
  idea: Partial<Idea>;
  summaries: ExperimentSummary[];
  papers: Paper[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (idea: Partial<Idea>) => Promise<boolean>;
}) {
  const reproductions = summaries.filter((item) => !isDesignedSummary(item));
  const [paperIds, setPaperIds] = useState<string[]>(idea.paperIds ?? []);
  const parsed = papers.filter((paper) => paper.status === "parsed");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    void onSave({
      ...idea,
      title: text("title"),
      mechanism: text("mechanism"),
      experiment: text("experiment"),
      difference: text("difference"),
      evidence: text("evidence"),
      draft: text("draft"),
      baselineId: text("baselineId") || null,
      paperIds,
      status: idea.status ?? "candidate",
    });
  };
  return <Modal title={idea.id ? "编辑设想" : "记录设想"} onClose={onClose} size="wide">
    <form className="form-stack exp-new exp-idea-form" onSubmit={submit}>
      <label>标题<input name="title" autoFocus defaultValue={idea.title} maxLength={160} required placeholder="一句话说明这个想法" /></label>
      <label>想法<textarea name="mechanism" rows={3} defaultValue={idea.mechanism} maxLength={5000} required placeholder="通过什么机制、解决什么问题" /></label>
      <label>要验证的假设<textarea name="experiment" rows={3} defaultValue={idea.experiment} maxLength={3000} placeholder="改什么，预期哪个指标怎么变。例如：过滤掉不可靠的反思后，HumanEval pass@1 比基线高至少 1 个点" /><small>agent 会按这里的假设设计对照实验，并在最后判断支持与否。</small></label>
      <div className="form-columns">
        <label>与已有方法的区别<textarea name="difference" rows={2} defaultValue={idea.difference} maxLength={3000} /></label>
        <label>关联论文与证据<textarea name="evidence" rows={2} defaultValue={idea.evidence} maxLength={3000} placeholder="paper_001 p.4" /></label>
      </div>
      <label>基线（论文复现实验）
        <select name="baselineId" defaultValue={idea.baselineId ?? ""}>
          <option value="">暂不指定</option>
          {reproductions.map((item) => <option key={item.id} value={item.id}>{item.title}（{item.id}）</option>)}
        </select>
        <small>设计实验会复制基线的代码，并和基线结果对比。</small>
      </label>
      <fieldset className="exp-paper-picks">
        <legend>关联论文</legend>
        {parsed.length ? parsed.map((paper) => <label key={paper.id} className="exp-check"><input type="checkbox" checked={paperIds.includes(paper.id)} onChange={() => setPaperIds((ids) => ids.includes(paper.id) ? ids.filter((id) => id !== paper.id) : [...ids, paper.id])} /><span>{paper.title}</span></label>)
          : <p className="exp-muted">还没有解析好的论文。</p>}
      </fieldset>
      <details className="exp-idea-draft-field"><summary>设想稿（可选，Markdown）</summary><textarea name="draft" rows={10} defaultValue={idea.draft} maxLength={20000} /></details>
      {error && <p className="exp-form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>取消</button>
        <button className="button button--primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存设想</button>
      </div>
    </form>
  </Modal>;
}

export interface DesignedExperimentInput {
  kind: "designed";
  ideaId: string;
  baselineId: string | null;
  paperIds: string[];
  goal: string;
  settings: ExperimentSettings;
}

/** 据设想开始设计实验：选基线、关联论文、预算和运行方式。 */
export function DesignedExperimentModal({ idea, summaries, papers, busy, error, onClose, onCreate }: {
  idea: Idea;
  summaries: ExperimentSummary[];
  papers: Paper[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onCreate: (input: DesignedExperimentInput) => Promise<boolean>;
}) {
  const reproductions = summaries.filter((item) => !isDesignedSummary(item));
  const parsed = papers.filter((paper) => paper.status === "parsed");
  const [baselineId, setBaselineId] = useState<string>(idea.baselineId && reproductions.some((item) => item.id === idea.baselineId) ? idea.baselineId : reproductions[0]?.id ?? "");
  const [paperIds, setPaperIds] = useState<string[]>((idea.paperIds ?? []).filter((id) => parsed.some((paper) => paper.id === id)));
  const [network, setNetwork] = useState(true);
  const [autoRun, setAutoRun] = useState(true);
  const [continuous, setContinuous] = useState(true);
  const [maxJobs, setMaxJobs] = useState("10");
  const [maxHours, setMaxHours] = useState("12");
  const needsPaper = !baselineId && !paperIds.length;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (needsPaper) return;
    const form = new FormData(event.currentTarget);
    void onCreate({
      kind: "designed",
      ideaId: idea.id,
      baselineId: baselineId || null,
      paperIds,
      goal: String(form.get("goal") ?? "").trim(),
      settings: {
        network,
        approveJobs: !autoRun,
        continuous,
        budget: { maxJobs: Number(maxJobs) > 0 ? Math.round(Number(maxJobs)) : null, maxHours: Number(maxHours) > 0 ? Number(maxHours) : null },
      },
    });
  };
  return <Modal title="开始设计实验" onClose={onClose} size="wide">
    <form className="form-stack exp-new" onSubmit={submit}>
      <div className="exp-design-idea"><Lightbulb size={15} aria-hidden="true" /><div><strong>{idea.title}</strong><span>{idea.experiment || idea.mechanism}</span></div></div>
      <label>基线
        <select value={baselineId} onChange={(event) => setBaselineId(event.target.value)}>
          {reproductions.map((item) => <option key={item.id} value={item.id}>{item.title}（{item.id}）</option>)}
          <option value="">不基于复现，从零实现</option>
        </select>
        <small>{baselineId ? "复制基线的代码到新实验（跳过环境、缓存和运行产物），并和基线结果对比。基线目录只读，不会被改动。" : "没有基线时，agent 会先实现一个对照方法，再实现新方法。"}</small>
      </label>
      <fieldset className="exp-paper-picks">
        <legend>关联论文{baselineId ? "（可选，基线论文会自动带上）" : "（至少一篇）"}</legend>
        {parsed.map((paper) => <label key={paper.id} className="exp-check"><input type="checkbox" checked={paperIds.includes(paper.id)} onChange={() => setPaperIds((ids) => ids.includes(paper.id) ? ids.filter((id) => id !== paper.id) : [...ids, paper.id])} /><span>{paper.title}</span></label>)}
      </fieldset>
      <label>补充说明（可选）<textarea name="goal" rows={3} maxLength={4000} placeholder="例如：先只在 HumanEval 上验证；用 3 个 seed；不要改评测脚本" /></label>
      <div className="exp-budget">
        <label>最多后台任务数<input type="number" min={1} max={500} value={maxJobs} onChange={(event) => setMaxJobs(event.target.value)} /></label>
        <label>后台任务总时长（小时）<input type="number" min={0.5} max={10000} step={0.5} value={maxHours} onChange={(event) => setMaxHours(event.target.value)} /></label>
      </div>
      <small className="exp-muted">预算用完后，新的后台任务要你确认才会运行。留空表示不设上限。</small>
      <label className="exp-check"><input type="checkbox" checked={autoRun} onChange={(event) => setAutoRun(event.target.checked)} /><span><strong>方案确认后自动运行后台任务</strong><small>agent 会先把方案写进实验记录并问你；你确认后，它在预算内自己写代码、提交任务、读结果。</small></span></label>
      <label className="exp-check"><input type="checkbox" checked={continuous} onChange={(event) => setContinuous(event.target.checked)} /><span><strong>持续接续</strong><small>任务结束后自动把结果交给 agent 继续，直到假设得到回答。</small></span></label>
      <label className="exp-check"><input type="checkbox" checked={network} onChange={(event) => setNetwork(event.target.checked)} /><span><strong>允许联网</strong><small>下载数据集和模型时需要。</small></span></label>
      {needsPaper && <p className="exp-form-error">没有基线时，请至少勾选一篇关联论文。</p>}
      {error && <p className="exp-form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>取消</button>
        <button className="button button--primary" disabled={busy || needsPaper}>{busy ? <LoaderCircle className="spin" size={15} /> : <FlaskConical size={15} />}开始</button>
      </div>
    </form>
  </Modal>;
}
