import { ArrowUpRight, FileText } from "lucide-react";
import type { Paper } from "../types";
import { paperStatusLabels } from "../uiText";

export function PaperRow({ paper, onOpen }: { paper: Paper; onOpen: () => void }) {
  return <button className="paper-row" onClick={onOpen}><span className="file-icon"><FileText size={15} /></span><span className="paper-row-main"><strong>{paper.title}</strong><small>{paper.filename}</small></span><span className={`paper-status paper-status--${paper.status}`}><i />{paperStatusLabels[paper.status]}</span><span className="paper-page-count">{paper.pageCount ? `${paper.pageCount} 页` : "--"}</span><ArrowUpRight className="paper-open" size={14} /></button>;
}
