import type { FormEvent } from "react";
import { Check, LoaderCircle } from "lucide-react";
import type { Idea } from "../../types";
import { statusLabels } from "../../uiText";
import { Modal } from "../../components/Shared";
import "./screen.css";

export function IdeaModal({ idea, onClose, onSubmit, busy }: { idea: Partial<Idea>; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  return <Modal title={idea.id ? "编辑 Idea" : "记录 Idea"} onClose={onClose} size="wide"><form className="form-stack idea-form" onSubmit={onSubmit}><label>标题<input name="title" autoFocus defaultValue={idea.title} placeholder="一句话描述研究想法" maxLength={160} required /></label><label>核心机制<textarea name="mechanism" rows={4} defaultValue={idea.mechanism} placeholder="这个想法通过什么机制解决什么问题？" maxLength={5000} required /></label><div className="form-columns"><label>与已有方法的区别<textarea name="difference" rows={3} defaultValue={idea.difference} maxLength={3000} /></label><label>最小验证实验<textarea name="experiment" rows={3} defaultValue={idea.experiment} maxLength={3000} /></label></div><label>关联论文与证据<textarea name="evidence" rows={2} defaultValue={idea.evidence} placeholder="paper_001 · p. 4" maxLength={3000} /></label><label>设想稿（Markdown，可选）<textarea name="draft" rows={12} defaultValue={idea.draft} maxLength={20000} placeholder="完整的讲解稿式研究设想" /></label><label>人工决策<select name="status" defaultValue={idea.status ?? "candidate"}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="modal-actions"><button type="button" className="button" onClick={onClose}>取消</button><button className="button button--primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存 Idea</button></div></form></Modal>;
}
