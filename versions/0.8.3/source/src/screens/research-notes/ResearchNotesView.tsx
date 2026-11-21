import { useMemo, useState, type FormEvent } from "react";
import { LoaderCircle, Plus, Save } from "lucide-react";
import type { Project, ResearchNote } from "../../types";
import { formatDate } from "../../uiText";
import "./screen.css";

interface ResearchNotesViewProps {
  project: Project;
  busy: boolean;
  onSave: (text: string, options: { paperId?: string }) => Promise<ResearchNote | null>;
  onUpdate: (noteId: string, patch: { text?: string; paperId?: string | null }) => Promise<void>;
}

export function ResearchNotesView({ project, busy, onSave, onUpdate }: ResearchNotesViewProps) {
  const [text, setText] = useState("");
  const [paperId, setPaperId] = useState("");
  const notes = useMemo(() => [...(project.notes ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [project.notes]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!text.trim()) return;
    if (await onSave(text.trim(), { ...(paperId ? { paperId } : {}) })) {
      setText("");
      setPaperId("");
    }
  };

  return <div className="page research-notes-page">
    <header className="page-title-row"><div><span className="eyebrow">RESEARCH NOTES</span><h1>研究笔记</h1><p className="page-subtitle">{notes.length} 条研究笔记</p></div></header>
    <form className="research-note-compose" onSubmit={submit}>
      <label>记录观察<textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} maxLength={3000} placeholder="写下实验观察、疑问或判断" /></label>
      <div className="research-note-compose-tools">
        <label>关联论文<select value={paperId} onChange={(event) => setPaperId(event.target.value)}><option value="">不关联论文</option>{project.papers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}</option>)}</select></label>
        <button className="button button--primary" disabled={busy || !text.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}添加笔记</button>
      </div>
    </form>
    <section className="research-note-list" aria-label="研究笔记列表">
      {notes.length ? notes.map((note) => <ResearchNoteItem key={note.id} note={note} project={project} onUpdate={onUpdate} />) : <div className="inline-empty">还没有研究笔记</div>}
    </section>
  </div>;
}

function ResearchNoteItem({ note, project, onUpdate }: { note: ResearchNote; project: Project; onUpdate: ResearchNotesViewProps["onUpdate"] }) {
  const [text, setText] = useState(note.text);
  const [paperId, setPaperId] = useState(note.paperId ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = text !== note.text || paperId !== (note.paperId ?? "");
  const save = async () => {
    setSaving(true);
    try { await onUpdate(note.id, { text, paperId: paperId || null }); }
    finally { setSaving(false); }
  };

  return <article className="research-note-item">
    <header><time>{formatDate(note.createdAt)}</time></header>
    <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} maxLength={3000} aria-label="研究笔记内容" />
    <footer><select value={paperId} onChange={(event) => setPaperId(event.target.value)} aria-label="关联论文"><option value="">不关联论文</option>{project.papers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}</option>)}</select><button type="button" className="button button--small" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}保存修改</button><span>{dirty ? "有未保存修改" : "已保存"}</span></footer>
  </article>;
}
