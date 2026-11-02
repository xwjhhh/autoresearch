import { useEffect, useMemo, useState } from "react";
import { FileDiff, LoaderCircle, RefreshCw } from "lucide-react";
import type { DesktopBridge, ExperimentDiff } from "../../types";

/** 把整份补丁按文件切开。 */
export function splitPatch(patch: string) {
  const sections = new Map<string, string>();
  const parts = patch.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git "));
  for (const part of parts) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    if (header) sections.set(header[2], part);
  }
  return sections;
}

const lineClass = (line: string) => line.startsWith("+++") || line.startsWith("---") ? "is-meta"
  : line.startsWith("+") ? "is-added"
  : line.startsWith("-") ? "is-removed"
  : line.startsWith("@@") ? "is-hunk"
  : line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") ? "is-meta" : "";

/** 设计实验当前代码相对基线（复制过来时的代码）的改动。 */
export function DiffTab({ api, projectId, experimentId, refreshKey }: { api: DesktopBridge; projectId: string; experimentId: string; refreshKey: string }) {
  const [diff, setDiff] = useState<ExperimentDiff | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    api.readExperimentDiff(projectId, experimentId)
      .then((next) => { if (alive) setDiff(next); })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, projectId, experimentId, version, refreshKey]);

  const sections = useMemo(() => splitPatch(diff?.patch ?? ""), [diff?.patch]);
  const files = diff?.files ?? [];
  const current = selected && sections.has(selected) ? selected : files[0]?.path ?? null;
  const totals = files.reduce((sum, file) => ({ added: sum.added + (file.added ?? 0), removed: sum.removed + (file.removed ?? 0) }), { added: 0, removed: 0 });

  if (loading && !diff) return <div className="exp-loading exp-loading--small"><LoaderCircle className="spin" size={13} />正在比较代码</div>;
  if (error) return <p className="exp-form-error">读取改动失败：{error}</p>;
  if (diff && !diff.available) return <p className="exp-muted exp-panel-empty">{diff.reason ?? "没有代码版本记录。"}</p>;

  return <div className="exp-diff">
    <div className="exp-panel-actions exp-panel-actions--top">
      <span>{files.length ? <>相对基线改了 {files.length} 个文件，<b className="is-added">+{totals.added}</b> <b className="is-removed">−{totals.removed}</b></> : "和基线相比还没有改动。"}</span>
      <button className="button button--small" disabled={loading} onClick={() => setVersion((value) => value + 1)}>{loading ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}刷新</button>
    </div>
    {files.length > 0 && <ul className="exp-diff-files">
      {files.map((file) => <li key={file.path}><button type="button" className={file.path === current ? "is-active" : ""} onClick={() => setSelected(file.path)}>
        <FileDiff size={12} aria-hidden="true" /><span title={file.path}>{file.path}</span>
        <small>{file.added === null ? "二进制" : <><b className="is-added">+{file.added}</b> <b className="is-removed">−{file.removed}</b></>}</small>
      </button></li>)}
    </ul>}
    {current && <pre className="exp-diff-patch" aria-label={`${current} 的改动`}>{(sections.get(current) ?? "这个文件的改动太长，没有显示。").split("\n").map((line, index) => <span key={index} className={lineClass(line)}>{line || " "}{"\n"}</span>)}</pre>}
    {diff?.truncated && <p className="exp-muted">改动太多，只显示了前一部分。完整改动可以在实验目录里用 git diff ar-baseline 查看。</p>}
    {diff?.head && <p className="exp-muted">当前代码版本 {diff.head}；每个后台任务启动前的版本记在任务卡上。</p>}
  </div>;
}
