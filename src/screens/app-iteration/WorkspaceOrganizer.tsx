import { useEffect, useState } from "react";
import { AlertTriangle, Check, ExternalLink, FileCode2, LoaderCircle, RefreshCw, ShieldCheck, Trash2, Upload } from "lucide-react";
import type { IterationAction, IterationWorkspaceCandidate } from "./model";

const statusLabels: Record<IterationWorkspaceCandidate["status"], string> = {
  scanned: "已盘点", preparing: "生成候选", validating: "自动验证中", tested: "验证通过 · 待审阅", failed: "验证失败",
  publishing: "正在推送", pushed: "已推送 · PR 待创建", published: "已创建 PR", abandoned: "已放弃",
};
const fileStatus = { added: "新增", modified: "修改", deleted: "删除" };
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': Error: /, "");

function CandidateDiff({ candidate }: { candidate: IterationWorkspaceCandidate }) {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [patch, setPatch] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setError("");
    setPatch("");
    void window.autoresearch.iterationWorkspaceDiff().then((diff) => {
      if (!current) return;
      setFiles(diff.files);
      setSelected((prior) => diff.files.includes(prior) ? prior : diff.files[0] ?? "");
    }).catch((reason) => { if (current) setError(errorText(reason)); });
    return () => { current = false; };
  }, [candidate.sha]);
  useEffect(() => {
    let current = true;
    setPatch("");
    if (selected) void window.autoresearch.iterationWorkspacePatch(selected).then((value) => { if (current) setPatch(value.text); }).catch((reason) => { if (current) setError(errorText(reason)); });
    return () => { current = false; };
  }, [candidate.sha, selected]);
  return <section className="iter-organizer-review">
    <div className="iter-row"><strong>候选差异</strong><code title={candidate.sha}>{candidate.sha?.slice(0, 10)}</code><span className="iter-meta">{files.length} 个文件</span></div>
    {error && <p className="iter-alert" role="alert">{error}</p>}
    {files.length ? <div className="iter-diff">
      <div className="iter-files" aria-label="整理候选改动文件">{files.map((file) => <button key={file} type="button" className={selected === file ? "is-selected" : ""} onClick={() => setSelected(file)}>{file}</button>)}</div>
      <div className="iter-patch"><pre aria-label="整理候选代码差异">{patch ? patch.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") ? "iter-added" : line.startsWith("-") ? "iter-removed" : ""}>{line || " "}{"\n"}</span>) : "正在读取差异…"}</pre></div>
    </div> : <p className="iter-muted">候选提交暂无差异。</p>}
  </section>;
}

export function WorkspaceOrganizer({ candidate, repository, activeAction, locked, onAction }: {
  candidate: IterationWorkspaceCandidate | null;
  repository: string | null;
  activeAction: IterationAction | null;
  locked: boolean;
  onAction: (action: IterationAction, input?: Record<string, unknown>) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [approved, setApproved] = useState(false);
  const [log, setLog] = useState<{ title: string; text: string }>();
  const [logError, setLogError] = useState("");
  const eligible = candidate?.inventory.files.filter((file) => file.eligible) ?? [];
  const excluded = candidate?.inventory.files.filter((file) => !file.eligible) ?? [];
  const canPublish = candidate?.status === "tested" && candidate.steps.length > 0 && candidate.steps.every((step) => step.exitCode === 0);
  const canAbandon = candidate && ["scanned", "failed", "tested", "pushed"].includes(candidate.status);

  useEffect(() => {
    setSelected(candidate?.status === "scanned" ? [] : candidate?.selected ?? []);
    setApproved(false);
    setLog(undefined);
    setLogError("");
  }, [candidate?.id]);

  async function openLog(file: string, title: string) {
    setLogError("");
    try { setLog({ title, text: await window.autoresearch.iterationWorkspaceLog(file) }); }
    catch (error) { setLogError(errorText(error)); }
  }

  function toggleFile(path: string) {
    setSelected((prior) => prior.includes(path) ? prior.filter((entry) => entry !== path) : [...prior, path]);
  }

  return <div className="iter-organizer">
    <header className="iter-organizer-heading">
      <div><div className="iter-row"><FileCode2 size={18} /><h2>整理当前工作区</h2></div><p>先逐项确认纳入文件，应用只把勾选的文件放进隔离候选；原工作区不会被暂存、提交或清理。</p></div>
      {activeAction === "workspacePrepare" && <button className="iter-button" type="button" onClick={() => onAction("stop")}>停止本轮</button>}
      {(!candidate || ["published", "abandoned"].includes(candidate.status)) && <button className="iter-button iter-primary" type="button" disabled={locked || !repository} onClick={() => onAction("workspaceScan")}><RefreshCw size={14} />{candidate ? "重新盘点" : "盘点当前工作区"}</button>}
    </header>
    <div className="iter-organizer-warning"><ShieldCheck size={17} /><span>范围采用固定的 AutoResearch 应用源码白名单。`versions/`、`data/`、内置 Codex 上游源码、依赖目录、构建产物、凭据、本地配置、二进制、大文件和符号链接不纳入；白名单外内容也不会扫描。测试在独立克隆中运行并移除常见凭据，但测试脚本仍可执行项目代码，<strong>这不是操作系统级沙箱</strong>。</span></div>
    {!repository && <p className="iter-alert">请先绑定源码仓库。</p>}
    {candidate && <>
      <div className="iter-row iter-organizer-status"><span className="iter-state" data-status={candidate.status === "failed" ? "abandoned" : candidate.status === "tested" || candidate.status === "published" ? "approved" : "spec"}>{statusLabels[candidate.status]}</span><code title={candidate.inventory.baseSha}>基线 {candidate.inventory.baseSha.slice(0, 10)}</code>{candidate.sha && <code title={candidate.sha}>候选 {candidate.sha.slice(0, 10)}</code>}{candidate.currentStep && <span className="iter-meta"><LoaderCircle size={14} className="spin" />{candidate.currentStep}</span>}{candidate.prUrl && <a href={candidate.prUrl} target="_blank" rel="noreferrer">打开 PR <ExternalLink size={13} /></a>}</div>
      {candidate.error && <p className="iter-alert" role="alert">{candidate.error}</p>}
      {candidate.status === "scanned" && <>
        <div className="iter-row iter-organizer-meta"><strong>可纳入 {eligible.length} 项</strong><span className="iter-meta">排除 {excluded.length} 项 · 盘点于 {new Date(candidate.inventory.scannedAt).toLocaleString("zh-CN")}</span><button className="iter-link" type="button" disabled={!selected.length} onClick={() => setSelected([])}>清空勾选</button></div>
        {eligible.length ? <div className="iter-organizer-files">{eligible.map((file) => <label key={file.path} className="iter-organizer-file"><input type="checkbox" checked={selected.includes(file.path)} onChange={() => toggleFile(file.path)} /><code>{file.path}</code><span>{fileStatus[file.status]}</span><small>{(file.size / 1024).toFixed(1)} KB</small></label>)}</div> : <p className="iter-muted">白名单内没有可纳入的未提交改动。</p>}
        {excluded.length > 0 && <details className="iter-organizer-excluded"><summary>查看排除文件（{excluded.length}）</summary>{excluded.map((file) => <div className="iter-row" key={file.path}><code>{file.path}</code><small>{file.reason}</small></div>)}</details>}
        <div className="iter-row"><button className="iter-button iter-primary" type="button" disabled={locked || !selected.length} onClick={() => onAction("workspacePrepare", { files: selected })}>生成候选并运行验证 · {selected.length} 项</button><span className="iter-meta">运行安装依赖、单元测试、构建和可用的端到端测试</span></div>
      </>}
      {["preparing", "validating", "failed", "tested", "pushed", "published"].includes(candidate.status) && <>
        {candidate.steps.length > 0 && <div className="iter-organizer-checks">{candidate.steps.map((step) => <div className="iter-row" key={step.logFile}><span>{step.exitCode === 0 ? <Check size={15} /> : step.exitCode === null ? <LoaderCircle size={15} className="spin" /> : <AlertTriangle size={15} />}{step.name}</span><small>{step.exitCode === 0 ? `${(step.durationMs / 1000).toFixed(1)} 秒 · 通过` : step.exitCode === null ? "运行中" : `退出码 ${step.exitCode}`}</small><button className="iter-link" type="button" disabled={step.exitCode === null} onClick={() => void openLog(step.logFile, step.name)}>查看日志</button></div>)}</div>}
        {logError && <p className="iter-alert">{logError}</p>}
        {log && <div className="iter-record iter-artifact"><div className="iter-row"><strong>{log.title}</strong><button type="button" className="iter-link" onClick={() => setLog(undefined)}>关闭</button></div><pre>{log.text}</pre></div>}
        {candidate.sha && !(candidate.status === "published" && candidate.cleanedAt) && <CandidateDiff candidate={candidate} />}
        {canPublish && <div className="iter-organizer-approval"><label><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} />我已审阅候选差异，并确认所选文件和自动验证结果符合预期。</label><button className="iter-button iter-primary" type="button" disabled={locked || !approved} onClick={() => onAction("workspaceApprove", { sha: candidate.sha, reviewed: true })}><Upload size={14} />批准并推送候选（不合并）</button></div>}
        {candidate.status === "pushed" && <div className="iter-alert">候选分支已推送。创建 PR 暂未完成，可重试；不会重复生成或覆盖其他分支。<button className="iter-button" type="button" disabled={locked} onClick={() => onAction("workspacePublish")}>重试创建 PR</button></div>}
        {candidate.status === "published" && !candidate.cleanedAt && <button className="iter-button" type="button" disabled={locked} onClick={() => onAction("workspaceCleanup")}><Trash2 size={14} />清理本地候选目录</button>}
        {canAbandon && <button className="iter-link iter-organizer-abandon" type="button" disabled={locked} onClick={() => { if (window.confirm("放弃并删除应用专属的候选工作树？原工作区文件不会改变。")) onAction("workspaceAbandon"); }}>放弃候选并清理临时文件</button>}
      </>}
      {candidate.status === "abandoned" && <p className="iter-muted">已放弃。可重新盘点当前工作区。</p>}
    </>}
    {!candidate && <div className="iter-empty"><FileCode2 size={30} /><h2>受控整理未提交改动</h2><p>应用先显示文件清单和排除理由；候选在独立工作树中生成并验证。审阅确认后只会推送分支、创建 PR，不会自动合并。</p></div>}
  </div>;
}
