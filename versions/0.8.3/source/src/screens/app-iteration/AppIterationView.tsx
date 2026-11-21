import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, FolderGit2, GitBranch, GitPullRequest, LoaderCircle, Plus, RefreshCw, Settings2 } from "lucide-react";
import { ChatAttachments, ChatComposer } from "../../components/ChatComposer";
import type { ChatAttachment } from "../../types";
import type { IterationAction, IterationSnapshot, IterationStatus, IterationTask } from "./model";
import "./screen.css";

const states: Record<IterationStatus, string> = {
  draft: "草稿", spec: "验收待确认", implementing: "实现中", verifying: "验证中", review: "待审阅",
  approved: "已批准", merging: "合并中", merged: "已合并", abandoned: "已放弃", anomaly: "异常合并",
};
const results = { pending: "进行中", success: "通过", failure: "失败", interrupted: "已中断" };
const tabs = ["对话", "改动", "验证", "预览"] as const;
const short = (commit?: string | null) => commit?.slice(0, 10) ?? "未知";
const ended = (status: IterationStatus) => ["merged", "abandoned", "anomaly"].includes(status);
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': Error: /, "");

function Changes({ task }: { task: IterationTask }) {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [patch, setPatch] = useState<{ text: string; truncated: boolean }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setError("");
    void window.autoresearch.iterationDiff(task.id).then(({ files }) => {
      if (!current) return;
      setFiles(files);
      setSelected((prior) => files.includes(prior) ? prior : files[0] || "");
    }).catch((error) => { if (current) setError(errorText(error)); });
    return () => { current = false; };
  }, [task.id, task.sha]);
  useEffect(() => {
    let current = true;
    setPatch(undefined);
    if (selected) void window.autoresearch.iterationPatch(task.id, selected).then((value) => { if (current) setPatch(value); }).catch((error) => { if (current) setError(errorText(error)); });
    return () => { current = false; };
  }, [task.id, task.sha, selected]);
  if (error) return <p className="iter-alert" role="alert">{error}</p>;
  return <div className="iter-pane">
    <div className="iter-meta">基线 <code title={task.base ?? undefined}>{short(task.base)}</code> → 候选 <code title={task.sha ?? undefined}>{short(task.sha)}</code></div>
    {files.length ? <div className="iter-diff">
      <div className="iter-files" aria-label="改动文件">{files.map((file) => <button key={file} type="button" className={file === selected ? "is-selected" : ""} onClick={() => { setError(""); setSelected(file); }}>{file}</button>)}</div>
      <div className="iter-patch"><pre aria-label="代码差异">{patch ? patch.text.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") ? "iter-added" : line.startsWith("-") ? "iter-removed" : ""}>{line || " "}{"\n"}</span>) : "正在读取差异…"}</pre>{patch?.truncated && <p className="iter-meta">此文件的差异过长，可在 PR 中查看全文。</p>}</div>
    </div> : <p className="iter-muted">候选提交还没有文件改动。</p>}
  </div>;
}

function Verification({ task }: { task: IterationTask }) {
  const [artifact, setArtifact] = useState<{ label: string; content: string; image: boolean }>();
  const [error, setError] = useState("");
  async function show(id: number, kind: "log" | "screenshot", file: string, label: string) {
    setError("");
    try { setArtifact({ label, content: await window.autoresearch.iterationArtifact(task.id, id, kind, file), image: kind === "screenshot" }); }
    catch (error) { setError(errorText(error)); }
  }
  return <div className="iter-pane iter-verifications">
    {!task.verifications.length && <p className="iter-muted">确认验收并开始实现后，这里会显示平台验证记录。</p>}
    {[...task.verifications].reverse().map((record, index) => <details key={record.id} className="iter-record" open={index === 0 || undefined}>
      <summary><strong>验证 #{record.id}</strong><code title={record.sha}>{short(record.sha)}</code><span data-status={record.result}>{results[record.result]}</span><time>{new Date(record.startedAt).toLocaleString("zh-CN")}</time></summary>
      {record.error && <p className="iter-alert">{record.error}</p>}
      {record.steps.map((step) => <div className="iter-step" key={step.logFile}><span title={step.command}>{step.name}</span><span>{(step.durationMs / 1000).toFixed(1)} 秒</span><span>退出码 {step.exitCode}</span><button type="button" className="iter-link" onClick={() => void show(record.id, "log", step.logFile, `验证 #${record.id} · ${step.name}`)}>日志</button></div>)}
      {record.screenshots.map((file) => <button key={file} className="iter-link iter-shot" type="button" onClick={() => void show(record.id, "screenshot", file, `验证 #${record.id} · ${file}`)}>截图 · {file.split(/[\\/]/).at(-1)}</button>)}
    </details>)}
    {error && <p className="iter-alert" role="alert">{error}</p>}
    {artifact && <div className="iter-record iter-artifact"><div className="iter-row"><strong>{artifact.label}</strong><button type="button" className="iter-link" onClick={() => setArtifact(undefined)}>关闭</button></div>{artifact.image ? <img src={artifact.content} alt={artifact.label} /> : <pre>{artifact.content}</pre>}</div>}
  </div>;
}

type TrialAnswer = { result?: "pass" | "fail"; note: string };

function Trial({ task, disabled, onSubmit }: { task: IterationTask; disabled: boolean; onSubmit: (results: { result: "pass" | "fail"; note: string }[], note: string) => void }) {
  const blank = () => task.trialItems.map((): TrialAnswer => ({ note: "" }));
  const [answers, setAnswers] = useState<TrialAnswer[]>(blank);
  const [note, setNote] = useState("");
  const criteriaKey = task.trialItems.join("\n");
  useEffect(() => { setAnswers(blank()); setNote(""); }, [task.id, task.sha, criteriaKey]);
  const opened = task.previews?.some((session) => session.sha === task.sha);
  const current = task.trial?.sha === task.sha ? task.trial : null;
  const complete = answers.length === task.trialItems.length && answers.every((answer) => answer.result === "pass" || (answer.result === "fail" && answer.note.trim()));
  const update = (index: number, change: Partial<TrialAnswer>) => setAnswers((prior) => prior.map((answer, position) => position === index ? { ...answer, ...change } : answer));
  return <section className="iter-trial" aria-label="人工试用">
    <h3>人工试用</h3>
    <p className="iter-muted">自动验证只说明测试通过。请在预览窗口里按下面的条件实际操作一遍，逐条记录结果。只有当前提交的试用全部通过，才能批准合并；未通过的问题会作为返工意见交给 Agent。</p>
    {current && <div className="iter-record" data-trial={current.passed ? "pass" : "fail"}>
      <strong>{current.passed ? "当前提交的人工试用已通过" : "当前提交的人工试用未通过"}</strong><time>{new Date(current.at).toLocaleString("zh-CN")}</time>
      <ul>{current.items.map((item, index) => <li key={index}>{item.result === "pass" ? "✓" : "✗"} {item.criterion}{item.note && <span className="iter-meta"> · {item.note}</span>}</li>)}</ul>
      {!current.passed && <p className="iter-meta">问题已附给 Agent，可在下方点击「要求再改」。修改后的新提交需要重新试用。</p>}
    </div>}
    {!opened && <p className="iter-meta">自动验证通过后，请打开当前提交的预览并实际操作，再记录结果。</p>}
    <ol className="iter-trial-items">{task.trialItems.map((criterion, index) => <li key={index}>
      <span>{criterion}</span>
      <div className="iter-row">
        <label><input type="radio" name={`trial-${index}`} checked={answers[index]?.result === "pass"} onChange={() => update(index, { result: "pass" })} />通过</label>
        <label><input type="radio" name={`trial-${index}`} checked={answers[index]?.result === "fail"} onChange={() => update(index, { result: "fail" })} />未通过</label>
      </div>
      {answers[index]?.result === "fail" && <input aria-label={`第 ${index + 1} 条实际看到的问题`} placeholder="实际看到了什么？例如：点击重试后，其他任务也被重新运行" value={answers[index].note} maxLength={1000} onChange={(event) => update(index, { note: event.target.value })} />}
    </li>)}</ol>
    <textarea aria-label="试用备注" rows={2} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="其他发现（可选）" />
    <div className="iter-row"><button type="button" className="iter-button iter-primary" disabled={disabled || !opened || !complete} onClick={() => onSubmit(answers.map(({ result, note }) => ({ result: result ?? "fail", note })), note)}>提交试用结果</button></div>
  </section>;
}

export function AppIterationView() {
  const api = window.autoresearch;
  const [data, setData] = useState<IterationSnapshot>();
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState<(typeof tabs)[number]>("对话");
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [description, setDescription] = useState("");
  const [requirementFiles, setRequirementFiles] = useState<ChatAttachment[]>([]);
  const [supplementing, setSupplementing] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [realData, setRealData] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [answering, setAnswering] = useState<string>();
  const task = data?.tasks.find(({ id }) => id === selected) ?? data?.tasks[0];
  const repo = data?.repository;
  const locked = Boolean(busy || data?.active || data?.updatePending);
  const closed = Boolean(task && ended(task.status));
  const canCreate = !data?.tasks.some((item) => !ended(item.status) || item.pendingSync > 0);
  const activity = task?.events?.at(-1);
  const verified = task && [...task.verifications].reverse().find((record) => record.sha === task.sha);
  const trial = task?.trial?.sha === task?.sha ? task?.trial : null;
  const trialPassed = Boolean(trial?.passed);
  const trialFailed = Boolean(trial && !trial.passed);
  const mismatch = Boolean(repo?.head && (__APP_SOURCE__.commit !== repo.head || __APP_SOURCE__.dirty));
  const canSupplement = data?.active === "draft" || data?.active === "implement";
  const feedbackInput = { text: feedback, attachmentIds: attachments.map(({ id }) => id) };
  const clearFeedback = () => { setFeedback(""); setAttachments([]); };
  const approvals = data?.approvals?.filter((card) => card.taskId === task?.id) ?? [];
  const stream = data?.stream?.taskId === task?.id ? data?.stream?.text : undefined;

  useEffect(() => {
    let current = true;
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      void api.iterationSnapshot().then((value) => { if (current) setData(value); }).catch((error) => { if (current) setError(errorText(error)); }).finally(() => { loading = false; });
    };
    load();
    const timer = window.setInterval(load, 2200);
    return () => { current = false; window.clearInterval(timer); };
  }, [api]);

  async function execute(operation: () => Promise<void>, onSuccess?: () => void) {
    setError("");
    setBusy(true);
    try { await operation(); onSuccess?.(); }
    catch (error) { setError(errorText(error)); }
    finally {
      setBusy(false);
      try {
        const snapshot = await api.iterationSnapshot();
        setData(snapshot);
        if (creating && snapshot.tasks.some((item) => !["merged", "abandoned"].includes(item.status))) { setCreating(false); setSelected(""); }
      } catch (error) { setError(errorText(error)); }
    }
  }

  function action(name: IterationAction, extra: Record<string, unknown> = {}, onSuccess?: () => void) {
    void execute(() => api.iterationAction(name, { id: task?.id, sha: task?.sha, ...extra }), onSuccess);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    action("create", { title: form.get("title"), description, criteria: form.get("criteria"), base: form.get("base"), attachmentIds: requirementFiles.map(({ id }) => id) }, () => { setCreating(false); setSelected(""); setTab("对话"); setDescription(""); setRequirementFiles([]); });
  }

  async function supplement() {
    if (supplementing) return;
    setSupplementing(true);
    try {
      await api.iterationAction("feedback", { id: task?.id, ...feedbackInput });
      clearFeedback();
      setData(await api.iterationSnapshot());
    } catch (error) { setError(errorText(error)); }
    finally { setSupplementing(false); }
  }

  async function decideApproval(approvalId: string, approve: boolean) {
    if (!task || answering) return;
    setAnswering(approvalId);
    setError("");
    try {
      await api.iterationAction("decideAgentApproval", { id: task.id, approvalId, approve });
      setData((prior) => prior && { ...prior, approvals: prior.approvals.filter((card) => card.id !== approvalId) });
    } catch (error) { setError(errorText(error)); }
    finally { setAnswering(undefined); }
  }

  return <section className="iter-page" aria-label="应用迭代工作区">
    <div className="iter-header">
      <div><div className="iter-heading"><GitPullRequest size={23} /><h1>自身</h1></div><p>提出改进，审阅候选代码与验证结果，再决定是否合并。</p></div>
      <button type="button" className="iter-button" aria-expanded={settings} onClick={() => setSettings(!settings)}><Settings2 size={16} />迭代设置</button>
    </div>
    <div className="iter-repo">
      <div className="iter-row"><FolderGit2 size={17} /><strong>{repo?.repository || "尚未绑定源码仓库"}</strong>{repo && <code>{repo.main}</code>}</div>
      <div className="iter-row iter-meta"><span>运行版本 {__APP_VERSION__} · <code title={__APP_SOURCE__.commit ?? "未记录提交"}>{short(__APP_SOURCE__.commit)}</code></span>{__APP_SOURCE__.dirty && <span className="iter-warning">构建包含未提交源码</span>}{repo?.head && <span>仓库 HEAD <code title={repo.head}>{short(repo.head)}</code></span>}{mismatch && <span className="iter-warning">运行源码与仓库 HEAD 不一致</span>}</div>
    </div>
    {(settings || (data && !repo)) && <div className="iter-settings">
      <div><strong>源码仓库</strong><p>{repo?.path || "选择 AutoResearch 的 Git 仓库。需要 GitHub 远程地址，以及已登录的 GitHub CLI（gh）。"}</p></div>
      {repo?.updateMode && <p className="iter-muted">{repo.updateMode === "source" ? "已绑定当前运行的源码仓库。合并后可手动更新并重启。" : repo.updateMode === "other" ? "当前 App 不是从这个仓库启动的；合并不会改变运行中的版本。" : "当前不是从已构建的源码直接运行；合并不会更新此版本。安装版需要安装新构建。"}</p>}
      <button type="button" className="iter-button" disabled={locked} onClick={() => void execute(() => api.chooseIterationRepository())}>选择源码仓库</button>
      {settings && data && <form className="iter-row" onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        action("settings", { limit: Number(form.get("limit")), runtime: form.get("runtime"), access: form.get("access") });
      }}>
        <label>验证失败上限 <input name="limit" type="number" min="1" max="20" defaultValue={data.retryLimit} /></label>
        <label>迭代运行时 <select name="runtime" defaultValue={data.runtime}><option value="app-server">Codex App Server（原生审批）</option><option value="sdk">旧 SDK（无原生审批）</option></select></label>
        <label>Agent 权限 <select name="access" defaultValue={data.access ?? "full"}><option value="full">完全（无沙箱、可联网）</option><option value="restricted">受限（额外操作需审批）</option></select></label>
        <button className="iter-button" disabled={locked}>保存</button>
      </form>}
    </div>}
    {(error || repo?.error || data?.updateError) && <div className="iter-alert" role="alert">{error || repo?.error || data?.updateError}</div>}
    {data?.updatePending && <p className="iter-muted">正在重新安装依赖并构建。更新完成后会重启 AutoResearch。</p>}
    <div className="iter-layout">
      <aside className="iter-rail" aria-label="迭代任务列表">
        <div className="iter-row iter-rail-heading"><strong>任务</strong><button type="button" className="iter-button" disabled={!repo || locked || !canCreate} onClick={() => setCreating(true)}><Plus size={15} />新建</button></div>
        {data?.tasks.map((item) => <button className={`iter-task ${task?.id === item.id && !creating ? "is-selected" : ""}`} key={item.id} type="button" onClick={() => { setSelected(item.id); setCreating(false); setTab("对话"); if (task?.id !== item.id) clearFeedback(); setAbandoning(false); }}><strong>{item.title}</strong><small>{item.number ? `#${item.number} · ` : ""}{states[item.status]}</small></button>)}
        {!data?.tasks.length && <p className="iter-muted">{data ? "暂无迭代任务" : "正在读取任务…"}</p>}
      </aside>
      <div className="iter-workspace">
        {creating ? <form className="iter-create" onSubmit={submit}>
          <h2>新建迭代任务</h2>
          <label>标题<input name="title" required maxLength={180} /></label>
          <ChatComposer label="需求描述" placeholder="描述你的需求，可附上截图、文档或其他文件" value={description} onChange={setDescription} files={requirementFiles} setFiles={setRequirementFiles} maxLength={6000} busy={locked} />
          <label>验收条件<textarea name="criteria" rows={3} placeholder="每行填写一条可验证的条件" maxLength={6000} /></label>
          <label>基线提交<select name="base" required defaultValue={repo?.dirty ? "" : "remote"}>{repo?.dirty && <option value="" disabled>仓库有未提交改动，请明确选择</option>}<option value="remote">远程主线最新提交 · {repo?.main}</option>{repo?.commits?.map(({ sha, title }) => <option key={sha} value={sha}>{short(sha)} · {title}</option>)}</select></label>
          <div className="iter-row"><button className="iter-button iter-primary" disabled={locked || (!description.trim() && !requirementFiles.length)}>创建任务与 Issue</button><button className="iter-button" type="button" onClick={() => setCreating(false)}>取消</button></div>
        </form> : task ? <>
          <div className="iter-task-head">
            <div className="iter-row"><span className="iter-state" data-status={task.status}>{states[task.status]}</span><h2>{task.title}</h2></div>
            <div className="iter-row iter-meta">{task.branch && <span><GitBranch size={13} />{task.branch}</span>}<code title={task.sha ?? undefined}>{short(task.sha)}</code>{task.issueUrl && <a href={task.issueUrl} target="_blank" rel="noreferrer">Issue #{task.number}<ArrowUpRight size={12} /></a>}{task.prUrl && <a href={task.prUrl} target="_blank" rel="noreferrer">Pull Request<ArrowUpRight size={12} /></a>}</div>
            {task.error && task.error !== error && <p className="iter-alert" role="alert">{task.error}</p>}
            {task.pendingSync > 0 && <p className="iter-meta">待同步 GitHub 记录 {task.pendingSync} 项。</p>}
          </div>
          {approvals.map((card) => <section className="iter-approval" key={card.id} aria-label="Agent 操作审批">
            <strong>{card.title}</strong><pre>{card.detail}</pre>
            <div className="iter-row"><button type="button" className="iter-button iter-primary" disabled={Boolean(answering)} onClick={() => void decideApproval(card.id, true)}>{card.kind === "permissions" ? "允许本回合" : "允许一次"}</button><button type="button" className="iter-button" disabled={Boolean(answering)} onClick={() => void decideApproval(card.id, false)}>拒绝</button><span className="iter-meta">5 分钟内未确认会自动拒绝。</span></div>
          </section>)}
          <div className="iter-tabs" aria-label="任务视图">{tabs.map((name) => <button key={name} type="button" aria-pressed={name === tab} onClick={() => setTab(name)}>{name}</button>)}</div>
          {tab === "改动" && <Changes key={task.id} task={task} />}
          {tab === "验证" && <Verification key={task.id} task={task} />}
          {tab === "对话" && <div className="iter-pane iter-thread">
            <article><strong>需求</strong><ChatAttachments files={task.attachments} /><p>{task.description}</p>{task.criteria && <><strong>验收条件</strong><p>{task.criteria}</p></>}{task.freeze && <p className="iter-meta">验收已冻结 <code title={task.freeze.hash}>{short(task.freeze.hash)}</code></p>}</article>
            {[...task.messages.map((entry) => ({ ...entry, kind: entry.role === "agent" ? "Agent" : "你" })), ...(task.events ?? []).map((entry) => ({ ...entry, attachments: undefined, kind: entry.kind === "verify" ? "验证进度" : "Agent 操作" }))].sort((left, right) => left.at.localeCompare(right.at)).map((entry, index) => <article key={`${entry.at}-${index}`} className={entry.kind === "你" ? "" : "iter-agent"}><strong>{entry.kind}</strong><time>{new Date(entry.at).toLocaleString("zh-CN")}</time><ChatAttachments files={entry.attachments} /><p>{entry.text}</p></article>)}
            {stream && <article className="iter-agent"><strong>Agent · 正在输出</strong><p>{stream}</p></article>}
          </div>}
          {tab === "预览" && <div className="iter-pane iter-preview">
            <h3>候选预览 · <code title={task.sha ?? undefined}>{short(task.sha)}</code></h3>
            <p>预览使用独立的设置目录。选择数据后，在独立窗口试用当前候选提交。</p>
            <label><input type="radio" name="preview-data" checked={!realData} onChange={() => { setRealData(false); setConfirmed(false); }} />示例数据</label>
            <label><input type="radio" name="preview-data" checked={realData} onChange={() => setRealData(true)} />正式数据的临时快照</label>
            {realData && <label className="iter-alert"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我同意候选版读取并修改临时副本。副本不包含常见实验产物、环境或模型凭据，关闭后删除。</label>}
            <div className="iter-row">{data?.preview?.id === task.id ? <button className="iter-button" type="button" onClick={() => action("stopPreview")}>停止预览 · {short(data.preview.sha)}</button> : <button className="iter-button iter-primary" type="button" disabled={locked || !["approved", "review"].includes(task.status) || !verified?.steps.some((step) => step.name === "构建" && step.exitCode === 0) || (realData && !confirmed)} onClick={() => action("preview", { realData, confirmed })}>打开预览</button>}</div>
            {["review", "approved"].includes(task.status) && <Trial task={task} disabled={locked || task.status !== "review" || verified?.result !== "success"} onSubmit={(results, note) => action("trial", { results, note })} />}
          </div>}
          <footer className="iter-footer">
            {!closed && !abandoning && (canSupplement || ["draft", "spec", "implementing", "review"].includes(task.status)) && <ChatComposer key={task.id} label="发给 Agent 的意见" placeholder="补充要求、粘贴截图，或添加参考文件" value={feedback} onChange={setFeedback} files={attachments} setFiles={setAttachments} maxLength={6000}
              busy={supplementing || (locked && !canSupplement)} status="发给下一轮 Agent" onSubmit={() => void supplement()} />}
            {abandoning && <textarea aria-label="放弃理由" rows={2} value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="填写放弃理由，将同步到 GitHub" />}
            <div className="iter-row iter-actions">
              <button className="iter-button" type="button" disabled={locked} onClick={() => action("sync")}><RefreshCw size={14} />同步 GitHub</button>
              {locked && <span className="iter-meta"><LoaderCircle size={15} className="spin" />{task.status === "verifying" && activity?.kind === "verify" ? activity.text : "正在执行"}</span>}
              {data?.active && !["update", "restore"].includes(data.active) && <button className="iter-button" type="button" onClick={() => void api.iterationAction("stop").catch((error) => setError(errorText(error)))}>停止本轮</button>}
              {task.mergedSha && ["merged", "anomaly"].includes(task.status) && <button className="iter-button" type="button" disabled={locked || !canCreate} onClick={() => { if (window.confirm("创建一个新的回退任务？它仍需通过验证并获得批准。")) action("revert", {}, () => { setSelected(""); setTab("对话"); }); }}>回退这次合并</button>}
              {task.status === "merged" && task.mergedSha && repo?.updateMode === "source" && repo.head !== task.mergedSha && <button className="iter-button iter-primary" type="button" disabled={locked || repo.dirty || Boolean(data?.preview)} onClick={() => { if (window.confirm("快进到此次合并并构建，完成后将重启 AutoResearch。继续？")) action("update"); }}>更新并重启</button>}
              {repo?.updateMode === "source" && data?.localUpdate?.path === repo.path && repo.head === data.localUpdate.target && <button className="iter-button" type="button" disabled={locked || repo.dirty || Boolean(data?.preview)} onClick={() => { if (window.confirm("仅恢复本地源码与旧构建，不撤销 GitHub 上的合并。继续？")) action("restore"); }}>恢复上次本地构建</button>}
              {!locked && !closed && (abandoning ? <><button className="iter-button" type="button" onClick={() => setAbandoning(false)}>取消</button><button className="iter-button" type="button" disabled={!feedback.trim()} onClick={() => action("abandon", { text: feedback }, () => { setFeedback(""); setAbandoning(false); })}>确认放弃</button></> : <>
                <button className="iter-link" type="button" onClick={() => { setAbandoning(true); clearFeedback(); }}>放弃</button>
                {(task.status === "draft" || task.status === "spec") && <button className="iter-button" type="button" disabled={supplementing} onClick={() => action("draft", feedbackInput, () => { clearFeedback(); setTab("改动"); })}>{task.status === "draft" ? "起草验收测试" : "修改验收测试"}</button>}
                {task.status === "spec" && <button className="iter-button iter-primary" type="button" disabled={!task.prUrl || tab !== "改动"} onClick={() => action("confirm")}>确认并冻结验收</button>}
                {(task.status === "implementing" || task.status === "review") && <button className="iter-button" type="button" disabled={supplementing || (task.status === "review" && !feedback.trim() && !attachments.length && !task.pendingFeedback?.length && !trialFailed)} onClick={() => action("implement", feedbackInput, clearFeedback)}>{task.status === "review" ? "要求再改" : "让 Agent 实现"}</button>}
                {task.status === "review" && verified?.result === "success" && !trialPassed && <button className="iter-link" type="button" onClick={() => setTab("预览")}>自动验证已通过，去预览中试用后再批准</button>}
                {task.status === "review" && <><button className="iter-button" type="button" onClick={() => { setTab("验证"); action("validate"); }}>重新验证</button><button className="iter-button iter-primary" type="button" title={trialPassed ? undefined : "需要当前提交的人工试用全部通过"} disabled={verified?.result !== "success" || !task.freeze || !trialPassed} onClick={() => action("approve")}>批准此提交</button></>}
                {task.status === "approved" && <button className="iter-button iter-primary" type="button" onClick={() => { setTab("验证"); action("merge"); }}>更新主线并合并</button>}
              </>)}
            </div>
          </footer>
        </> : <div className="iter-empty"><GitPullRequest size={30} /><h2>{repo ? "开始一次应用迭代" : "绑定源码仓库以开始"}</h2><p>{repo ? "新建任务，描述你希望改进的功能和完成标准。" : "任务、候选改动与合并记录会关联到同一个 GitHub 仓库。"}</p></div>}
      </div>
    </div>
  </section>;
}
