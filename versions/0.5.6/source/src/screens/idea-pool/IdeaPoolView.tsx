import { useState } from "react";
import { BookOpenText, FileText, Lightbulb, Pencil, Plus } from "lucide-react";
import type { Idea, IdeaStatus } from "../../types";
import { formatDate, statusLabels } from "../../uiText";
import { Markdown } from "../../components/markdown.jsx";
import "./pool.css";

interface IdeaPoolViewProps {
  ideas: Idea[];
  onEdit: (idea: Partial<Idea>) => void;
  onStatus: (idea: Idea, status: IdeaStatus, reason?: string) => void;
}

export function IdeaPoolView({ ideas, onEdit, onStatus }: IdeaPoolViewProps) {
  return <div className="page idea-pool-page">
    <header className="page-title-row"><div><span className="eyebrow">IDEA POOL</span><h1>Idea 池</h1><p className="page-subtitle">保存、筛选和继续打磨研究设想</p></div><button className="button button--primary" onClick={() => onEdit({ status: "candidate" })}><Plus size={14} />新建 Idea</button></header>
    {ideas.length ? <div className="idea-pool-list">{ideas.map((idea) => <IdeaItem key={idea.id} idea={idea} onEdit={onEdit} onStatus={onStatus} />)}</div> : <div className="inline-empty"><Lightbulb size={18} /><span>Idea 池还是空的</span><button className="text-button" onClick={() => onEdit({ status: "candidate" })}>记录一个 Idea</button></div>}
  </div>;
}

function IdeaItem({ idea, onEdit, onStatus }: { idea: Idea; onEdit: IdeaPoolViewProps["onEdit"]; onStatus: IdeaPoolViewProps["onStatus"] }) {
  const [reason, setReason] = useState(idea.rejectedReason ?? "");
  const [pendingStatus, setPendingStatus] = useState<IdeaStatus | "">("");
  const status = (value: IdeaStatus) => {
    if (value === "rejected") { setPendingStatus(value); return; }
    onStatus(idea, value);
  };
  return <article className="idea-pool-item">
    <header>
      <div className="idea-pool-title"><span className="idea-status-dot" data-status={idea.status} /><div><h2>{idea.title}</h2><time>{formatDate(idea.updatedAt)}</time></div></div>
      <div className="idea-pool-actions"><span className={`status-pill status-pill--${idea.status}`}>{statusLabels[idea.status]}</span><button className="button button--small" onClick={() => onEdit(idea)}><Pencil size={13} />编辑</button></div>
    </header>
    <p className="idea-pool-mechanism">{idea.mechanism}</p>
    {(idea.difference || idea.experiment || idea.evidence) && <details><summary>研究依据与验证</summary>{idea.difference && <p><b>研究问题</b>{idea.difference}</p>}{idea.experiment && <p><b>最小实验</b>{idea.experiment}</p>}{idea.evidence && <p><b>关联证据</b>{idea.evidence}</p>}</details>}
    {idea.draft && <details className="idea-pool-draft"><summary><BookOpenText size={14} />设想稿</summary><div className="idea-pool-markdown"><Markdown source={idea.draft} /></div></details>}
    <footer>
      <label>状态<select value={idea.status} onChange={(event) => status(event.target.value as IdeaStatus)}><option value="candidate">候选</option><option value="continue">继续研究</option><option value="parked">暂存</option><option value="rejected">淘汰</option></select></label>
      {pendingStatus === "rejected" && <form className="idea-reject-form" onSubmit={(event) => { event.preventDefault(); onStatus(idea, "rejected", reason); setPendingStatus(""); }}><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="淘汰理由" required /><button className="button button--small" disabled={!reason.trim()}>确认淘汰</button><button type="button" className="text-icon-button" onClick={() => setPendingStatus("")}>取消</button></form>}
      {idea.draft && <span className="idea-pool-has-draft"><FileText size={13} />含设想稿</span>}
    </footer>
  </article>;
}
