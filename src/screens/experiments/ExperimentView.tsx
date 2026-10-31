import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ChevronRight, CircleAlert, FileText, Folder, FolderOpen, LoaderCircle, Pencil, Play, Plus, RefreshCw, Send, Sparkles, Square, Terminal } from "lucide-react";
import type { DesktopBridge, Experiment, ExperimentEvent, ExperimentFileNode, ExperimentJob, ExperimentJobStatus, ExperimentSettings, ExperimentSnapshot, ExperimentSummary, ExperimentUpdate, Paper, Project } from "../../types";
import { Modal } from "../../components/Shared";
import { Markdown } from "../../components/markdown.jsx";
import { AgentQuestionDialog } from "../../components/AgentQuestionDialog";
import { TerminalDock, type TerminalTab } from "./TerminalDock";
import "./screen.css";

type PanelTab = "record" | "jobs" | "files";
type JobAction = "approve" | "reject" | "stop";
type Tone = "blue" | "amber" | "red" | "gray" | "green";

const cleanError = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

export function applyExperimentUpdate(current: ExperimentSnapshot, update: ExperimentUpdate): ExperimentSnapshot {
  let next = current;
  if (update.experiment) next = { ...next, experiment: update.experiment };
  if (update.events?.length) {
    const known = new Set(next.events.map((event) => event.id));
    const fresh = update.events.filter((event) => !known.has(event.id));
    if (fresh.length) next = { ...next, events: [...next.events, ...fresh] };
  }
  if (update.jobs?.length) {
    const jobs = new Map(next.jobs.map((job) => [job.id, job]));
    for (const job of update.jobs) jobs.set(job.id, job);
    next = { ...next, jobs: [...jobs.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  }
  if (typeof update.record === "string") next = { ...next, record: update.record };
  if (update.live !== undefined) next = { ...next, live: update.live };
  return next;
}

export function experimentStatus(experiment: Pick<Experiment, "agent" | "error" | "pendingQuestion">, pendingJobs: number, runningJobs: number): { label: string; tone: Tone } {
  if (experiment.pendingQuestion || experiment.agent === "waiting") return { label: "等你作答", tone: "amber" };
  if (experiment.agent === "working") return { label: "agent 工作中", tone: "blue" };
  if (pendingJobs) return { label: pendingJobs > 1 ? `${pendingJobs} 个任务等你确认` : "等你确认", tone: "amber" };
  if (runningJobs) return { label: "后台任务运行中", tone: "blue" };
  if (experiment.error) return { label: "出错", tone: "red" };
  return { label: "空闲", tone: "gray" };
}

const jobStatusLabel: Record<ExperimentJobStatus, { label: string; tone: Tone }> = {
  pending: { label: "等你确认", tone: "amber" },
  running: { label: "运行中", tone: "blue" },
  done: { label: "已完成", tone: "green" },
  failed: { label: "失败", tone: "red" },
  rejected: { label: "未运行", tone: "gray" },
  stopped: { label: "已停止", tone: "gray" },
  lost: { label: "进程丢失", tone: "red" },
};

function clock(value: string | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function duration(from?: string, to?: string | number) {
  if (!from) return "";
  const end = typeof to === "number" ? to : to ? Date.parse(to) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(from)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours} 时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
}

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function Pill({ label, tone }: { label: string; tone: Tone }) {
  return <span className={`exp-pill exp-pill--${tone}`}>{label}</span>;
}

// ---------- 主界面 ----------

/**
 * 从其他页面跳过来时要做的事：打开某个实验，或带着论文和目标打开新建弹窗。
 * nonce 每次跳转都变，同一个请求不会处理两次。实验必须绑定一篇论文。
 */
export interface ExperimentIntent {
  nonce: number;
  experimentId?: string;
  paperId?: string;
  goal?: string;
}

export function ExperimentView({ project, api = window.autoresearch, intent = null }: { project: Project; api?: DesktopBridge; intent?: ExperimentIntent | null }) {
  const [summaries, setSummaries] = useState<ExperimentSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ExperimentSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [creating, setCreating] = useState(false);
  const [newDefaults, setNewDefaults] = useState<{ paperId?: string; goal?: string } | null>(null);
  const intentRef = useRef<ExperimentIntent | null>(intent);
  const [tab, setTab] = useState<PanelTab>("record");
  const [focusedJob, setFocusedJob] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalTab, setTerminalTab] = useState<TerminalTab | null>(null);
  const [, setTick] = useState(0);
  const currentRef = useRef<string | null>(null);
  const pendingUpdates = useRef<ExperimentUpdate[]>([]);
  currentRef.current = currentId;

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setSnapshot(null);
    setCurrentId(null);
    api.listExperiments(project.id)
      .then((list) => {
        if (!alive) return;
        setSummaries(list);
        const wanted = intentRef.current?.experimentId;
        setCurrentId(wanted && list.some((item) => item.id === wanted) ? wanted : list[0]?.id ?? null);
      })
      .catch((reason) => { if (alive) setError(cleanError(reason)); })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [api, project.id]);

  useEffect(() => {
    if (!intent) return;
    intentRef.current = intent;
    if (intent.experimentId) setCurrentId(intent.experimentId);
    if (intent.paperId || intent.goal) {
      setNewDefaults({ paperId: intent.paperId, goal: intent.goal });
      setCreating(true);
    }
  }, [intent?.nonce]);

  useEffect(() => {
    pendingUpdates.current = [];
    if (!currentId) { setSnapshot(null); return; }
    let alive = true;
    setSnapshot(null);
    api.getExperiment(project.id, currentId)
      .then((next) => {
        if (!alive) return;
        // 读取期间收到的推送补进去，避免漏掉事件。
        const buffered = pendingUpdates.current.filter((update) => update.experimentId === next.experiment.id);
        pendingUpdates.current = [];
        setSnapshot(buffered.reduce(applyExperimentUpdate, next));
      })
      .catch((reason) => { if (alive) setError(cleanError(reason)); });
    return () => { alive = false; };
  }, [api, project.id, currentId]);

  useEffect(() => api.onExperimentUpdate((update) => {
    if (update.projectId !== project.id) return;
    setSummaries((list) => list.some((item) => item.id === update.experimentId)
      ? list.map((item) => item.id === update.experimentId ? update.summary : item)
      : [update.summary, ...list]);
    if (update.experimentId !== currentRef.current) return;
    setSnapshot((current) => {
      if (current?.experiment.id === update.experimentId) return applyExperimentUpdate(current, update);
      pendingUpdates.current.push(update);
      return current;
    });
  }), [api, project.id]);

  // 运行中的任务要显示已运行时长，定时刷新一次。
  const hasRunning = snapshot?.jobs.some((job) => job.status === "running") ?? false;
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  const ordered = useMemo(() => [...summaries].sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true })), [summaries]);
  const parsedPapers = useMemo(() => project.papers.filter((paper) => paper.status === "parsed"), [project.papers]);

  async function act<T>(label: string, action: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    setError("");
    try { return await action(); }
    catch (reason) { setError(cleanError(reason)); return null; }
    finally { setBusy(""); }
  }

  const experiment = snapshot?.experiment ?? null;
  const update = (experimentId: string, patch: Partial<ExperimentSnapshot>) => setSnapshot((current) => current?.experiment.id === experimentId ? { ...current, ...patch } : current);

  const create = async (input: { paperId: string; goal: string; code: string; settings: ExperimentSettings }) => {
    const created = await act("create", () => api.createExperiment(project.id, input));
    if (!created) return false;
    setSummaries((list) => [{
      id: created.experiment.id, title: created.experiment.title, paperId: created.experiment.paperId, paperTitle: created.experiment.paperTitle,
      agent: created.experiment.agent, activity: created.experiment.activity, error: null, pendingJobs: 0, runningJobs: 0, updatedAt: created.experiment.updatedAt,
    }, ...list.filter((item) => item.id !== created.experiment.id)]);
    setCurrentId(created.experiment.id);
    setTab("record");
    setCreating(false);
    return true;
  };

  const send = async (text: string) => {
    if (!experiment) return false;
    const next = await act("send", () => api.sendExperimentMessage(project.id, experiment.id, text));
    if (next) update(experiment.id, { experiment: next });
    return Boolean(next);
  };

  const answerQuestion = async (requestId: string, answers: Record<string, string>) => {
    if (!experiment) return false;
    const next = await act("answer-question", () => api.answerExperimentQuestion(project.id, experiment.id, requestId, answers));
    if (next) update(experiment.id, { experiment: next });
    return Boolean(next);
  };

  const stopQuestion = async () => {
    if (!experiment) return;
    const next = await act("stop-question", () => api.stopExperiment(project.id, experiment.id));
    if (next) update(experiment.id, { experiment: next });
  };

  const jobAction = async (job: ExperimentJob, action: JobAction) => {
    if (!experiment) return;
    if (action === "stop" && !window.confirm(`停止后台任务 ${job.name}？它会被立刻结束，没有保存的进度会丢失。`)) return;
    await act(`job-${job.id}`, () => api.experimentJobAction(project.id, experiment.id, job.id, action));
  };

  // “查看日志”统一打开底部终端，切到这个任务。
  const focusJob = (jobId: string) => {
    setFocusedJob(jobId);
    setTerminalTab(jobId);
    setTerminalOpen(true);
  };

  if (!loaded) return <div className="exp-loading"><LoaderCircle className="spin" size={16} />正在读取实验</div>;

  const jobs = snapshot?.jobs ?? [];
  const pending = jobs.filter((job) => job.status === "pending").length;
  const running = jobs.filter((job) => job.status === "running").length;

  return <div className={`exp-view ${snapshot ? "" : "is-empty"}`}>
    <section className="exp-main">
      {ordered.length > 0 && <header className="exp-header">
        <label className="exp-picker">
          <span>实验</span>
          <select value={currentId ?? ""} onChange={(event) => { setCurrentId(event.target.value); setFocusedJob(null); setTerminalTab(null); }}>
            {ordered.map((item) => <option key={item.id} value={item.id}>{item.title}（{item.id}）</option>)}
          </select>
        </label>
        {experiment && <span className="exp-paper" title={experiment.paperTitle}>论文 <strong>{experiment.paperId}</strong></span>}
        {experiment && <Pill {...experimentStatus(experiment, pending, running)} />}
        <span className="exp-header-spacer" />
        {experiment && <>
          <label className="exp-toggle" title="agent 的沙箱能否联网。后台任务不受这个开关限制。">
            <input type="checkbox" checked={experiment.settings.network} disabled={busy === "settings"} onChange={(event) => void act("settings", () => api.updateExperimentSettings(project.id, experiment.id, { network: event.target.checked }))} />
            允许联网
          </label>
          <label className="exp-toggle" title="后台任务在沙箱外运行。打开时，每个后台任务都要你点“开始运行”。">
            <input type="checkbox" checked={experiment.settings.approveJobs} disabled={busy === "settings"} onChange={(event) => void act("settings", () => api.updateExperimentSettings(project.id, experiment.id, { approveJobs: event.target.checked }))} />
            长任务需确认
          </label>
        </>}
        <button className="button button--primary" onClick={() => { setNewDefaults(null); setCreating(true); }}><Plus size={14} />新建实验</button>
      </header>}

      {error && !creating && <div className="exp-banner" role="alert"><CircleAlert size={14} /><span>{error}</span><button type="button" onClick={() => setError("")}>知道了</button></div>}

      {!ordered.length ? <ExperimentEmpty papers={parsedPapers.length} onCreate={() => setCreating(true)} />
        : !snapshot ? <div className="exp-loading"><LoaderCircle className="spin" size={16} />正在打开实验</div>
        : <>
          <Conversation snapshot={snapshot} busyKey={busy} onJobAction={jobAction} onFocusJob={focusJob} />
          <Composer key={snapshot.experiment.id} experiment={snapshot.experiment} pending={pending} running={running} busy={busy === "send" || busy === "stop"} onSend={send} onStop={() => void act("stop", () => api.stopExperiment(project.id, snapshot.experiment.id))} />
        </>}
    </section>

    {snapshot && <ExperimentPanel
      key={snapshot.experiment.id}
      api={api}
      projectId={project.id}
      snapshot={snapshot}
      tab={tab}
      onTab={setTab}
      focusedJob={focusedJob}
      onFocusJob={setFocusedJob}
      busyKey={busy}
      onJobAction={jobAction}
      onSaveRecord={async (text) => { const saved = await act("record", () => api.saveExperimentRecord(project.id, snapshot.experiment.id, text)); if (saved !== null) update(snapshot.experiment.id, { record: saved }); return saved !== null; }}
      onShowJob={focusJob}
      onError={setError}
    />}

    {snapshot && <TerminalDock
      key={`terminal-${snapshot.experiment.id}`}
      api={api}
      projectId={project.id}
      snapshot={snapshot}
      open={terminalOpen}
      onOpenChange={setTerminalOpen}
      active={terminalTab}
      onActive={setTerminalTab}
      busyKey={busy}
      onJobAction={jobAction}
      onError={setError}
    />}

    {creating && <NewExperimentModal papers={parsedPapers} initialPaperId={newDefaults?.paperId} initialGoal={newDefaults?.goal} busy={busy === "create"} error={busy ? "" : error} onClose={() => { setCreating(false); setNewDefaults(null); }} onCreate={create} />}
    {snapshot?.experiment.pendingQuestion && <AgentQuestionDialog
      key={snapshot.experiment.pendingQuestion.requestId}
      question={snapshot.experiment.pendingQuestion}
      busy={busy === "answer-question" || busy === "stop-question"}
      onSubmit={(answers) => answerQuestion(snapshot.experiment.pendingQuestion!.requestId, answers)}
      onStop={stopQuestion}
    />}
  </div>;
}

function ExperimentEmpty({ papers, onCreate }: { papers: number; onCreate: () => void }) {
  return <div className="exp-empty">
    <span className="exp-empty-icon"><Terminal size={20} /></span>
    <h2>还没有实验</h2>
    <p>选一篇已解析的论文，用一句话说明要复现什么。agent 会先读论文，给你计划，再动手配环境、跑代码。</p>
    {papers ? <button className="button button--primary" onClick={onCreate}><Plus size={15} />新建实验</button>
      : <p className="exp-empty-hint">先在“文献分析”里导入论文，解析完成后就能新建实验。</p>}
  </div>;
}

// ---------- 对话 ----------

type Block = { kind: "event"; event: ExperimentEvent } | { kind: "activity"; id: string; events: ExperimentEvent[] };

export function groupEvents(events: ExperimentEvent[]): Block[] {
  const blocks: Block[] = [];
  let group: Extract<Block, { kind: "activity" }> | null = null;
  for (const event of events) {
    if (event.type === "command" || event.type === "file" || event.type === "tool") {
      if (!group) {
        group = { kind: "activity", id: event.id, events: [] };
        blocks.push(group);
      }
      group.events.push(event);
    } else {
      group = null;
      blocks.push({ kind: "event", event });
    }
  }
  return blocks;
}

function Conversation({ snapshot, busyKey, onJobAction, onFocusJob }: { snapshot: ExperimentSnapshot; busyKey: string; onJobAction: (job: ExperimentJob, action: JobAction) => void; onFocusJob: (jobId: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const blocks = useMemo(() => groupEvents(snapshot.events), [snapshot.events]);
  const jobs = useMemo(() => new Map(snapshot.jobs.map((job) => [job.id, job])), [snapshot.jobs]);

  useEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [snapshot.events.length, snapshot.experiment.activity]);

  return <div className="exp-stream" ref={scroller} onScroll={(event) => {
    const element = event.currentTarget;
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
  }}>
    <div className="exp-stream-inner">
      {blocks.map((block) => {
        if (block.kind === "activity") return <ActivityGroup key={block.id} events={block.events} />;
        const { event } = block;
        if (event.type === "user") return <article key={event.id} className="exp-msg exp-msg--user">
          <header><strong>你</strong><time>{clock(event.at)}</time></header>
          <div className="exp-bubble">{event.text}</div>
        </article>;
        if (event.type === "agent") return <article key={event.id} className="exp-msg exp-msg--agent">
          <header><span className="exp-agent-mark" aria-hidden="true"><Sparkles size={11} /></span><strong>Agent</strong><time>{clock(event.at)}</time></header>
          <div className="exp-card exp-markdown"><Markdown source={event.text ?? ""} /></div>
        </article>;
        if (event.type === "job") {
          const job = event.jobId ? jobs.get(event.jobId) : undefined;
          return job ? <JobCard key={event.id} job={job} busy={busyKey === `job-${job.id}`} onAction={(action) => onJobAction(job, action)} onShowLog={() => onFocusJob(job.id)} /> : null;
        }
        if (event.type === "error") return <div key={event.id} className="exp-error"><CircleAlert size={14} /><span>{event.text}</span></div>;
        return <div key={event.id} className="exp-system"><span>{clock(event.at)} · {event.text}</span></div>;
      })}
      {snapshot.experiment.agent === "working" && <div className="exp-working"><LoaderCircle className="spin" size={13} />{snapshot.experiment.activity || "agent 正在工作"}</div>}
    </div>
  </div>;
}

const changeKind: Record<string, string> = { add: "新建", delete: "删除", update: "修改" };

function ActivityGroup({ events }: { events: ExperimentEvent[] }) {
  const commands = events.filter((event) => event.type === "command");
  const files = new Set(events.flatMap((event) => event.type === "file" ? (event.changes ?? []).map((change) => change.path) : []));
  const tools = events.filter((event) => event.type === "tool").length;
  const failed = commands.filter((event) => typeof event.exitCode === "number" && event.exitCode !== 0).length;
  const summary = [
    commands.length ? `执行了 ${commands.length} 条命令` : "",
    files.size ? `改动 ${files.size} 个文件` : "",
    tools ? `${tools} 次其他操作` : "",
  ].filter(Boolean).join("，");
  const first = clock(events[0]?.at);
  const last = clock(events[events.length - 1]?.at);
  return <details className="exp-activity">
    <summary>
      <span>{summary}</span>
      {failed > 0 && <span className="exp-activity-failed">{failed} 条失败</span>}
      <time>{first === last ? first : `${first}–${last}`}</time>
    </summary>
    <ol>
      {events.map((event) => <li key={event.id}>
        {event.type === "command" && <>
          <div className="exp-activity-line">
            <code>{event.command}</code>
            <span className={typeof event.exitCode === "number" && event.exitCode !== 0 ? "is-failed" : "is-ok"}>
              {typeof event.exitCode === "number" ? `退出码 ${event.exitCode}` : event.status === "failed" ? "失败" : "已结束"}
            </span>
          </div>
          {event.output?.trim() && <details className="exp-output"><summary>输出</summary><pre>{event.output}</pre></details>}
        </>}
        {event.type === "file" && <div className="exp-activity-line exp-activity-files">
          {(event.changes ?? []).map((change, index) => <span key={`${change.path}-${index}`}>{changeKind[change.kind] ?? "改动"} <code>{change.path}</code></span>)}
        </div>}
        {event.type === "tool" && <div className="exp-activity-line"><span>{event.text}</span></div>}
      </li>)}
    </ol>
  </details>;
}

function jobMeta(job: ExperimentJob) {
  if (job.status === "pending") return `提交于 ${clock(job.requestedAt)}`;
  if (job.status === "running") return `已运行 ${duration(job.startedAt)}`;
  if (job.status === "done" || job.status === "failed") return `退出码 ${job.exitCode ?? "未知"} · ${duration(job.startedAt, job.finishedAt)}`;
  if (job.status === "stopped") return `运行 ${duration(job.startedAt, job.finishedAt)} 后停止`;
  if (job.status === "lost") return "没有拿到退出码";
  return "没有运行";
}

function JobCard({ job, busy, onAction, onShowLog }: { job: ExperimentJob; busy: boolean; onAction: (action: JobAction) => void; onShowLog: () => void }) {
  return <section className={`exp-job exp-job--${job.status}`} aria-label={`后台任务 ${job.name}`}>
    <div className="exp-job-head">
      <Terminal size={14} aria-hidden="true" />
      <span className="exp-job-kind">{job.origin === "user" ? "手动命令" : "后台任务"}</span>
      <strong>{job.name}</strong>
      <Pill {...jobStatusLabel[job.status]} />
      <span className="exp-job-meta">{jobMeta(job)}</span>
    </div>
    {job.note && <p className="exp-job-note">{job.note}</p>}
    <code className="exp-job-command">{job.command}</code>
    {job.lastLine && job.status !== "pending" && <button type="button" className="exp-job-last" onClick={onShowLog} title="在终端里查看完整输出"><span aria-hidden="true">›</span>{job.lastLine}</button>}
    {job.status === "pending" && <div className="exp-job-actions">
      <span>在沙箱外运行{job.cwd !== "." ? `，工作目录 ${job.cwd}` : ""}，日志写到 {job.log}</span>
      <button className="button button--primary" disabled={busy} onClick={() => onAction("approve")}>{busy ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}开始运行</button>
      <button className="button" disabled={busy} onClick={() => onAction("reject")}>不运行</button>
    </div>}
    {job.status === "running" && <div className="exp-job-actions">
      <span>{job.origin === "user" && !job.notify ? "结束后不会唤醒 agent，结果会随你的下一条消息交给它。" : "结束后会自动把结果交给 agent。"}</span>
      <button className="button" onClick={onShowLog}><Terminal size={12} />在终端查看</button>
      <button className="button exp-danger" disabled={busy} onClick={() => onAction("stop")}>停止</button>
    </div>}
    {job.status !== "pending" && job.status !== "running" && job.status !== "rejected" && <div className="exp-job-actions">
      <span />
      <button className="button" onClick={onShowLog}><Terminal size={12} />在终端查看</button>
    </div>}
  </section>;
}

function Composer({ experiment, pending, running, busy, onSend, onStop }: { experiment: Experiment; pending: number; running: number; busy: boolean; onSend: (text: string) => Promise<boolean>; onStop: () => void }) {
  const [text, setText] = useState("");
  const working = experiment.agent === "working";
  const waitingForAnswer = Boolean(experiment.pendingQuestion);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) textarea.current?.focus();
    wasWorking.current = working;
  }, [working]);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || working || waitingForAnswer || busy) return;
    if (await onSend(value)) setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };
  const status = waitingForAnswer ? "请先回答上方的问题"
    : working ? "agent 正在工作，可以随时停止"
    : pending ? `有 ${pending} 个后台任务等你确认`
    : running ? `${running} 个后台任务运行中，结束后会自动唤醒 agent`
    : experiment.error ? `上一轮出错：${experiment.error}`
    : "Ctrl + Enter 发送";
  return <form className="exp-composer" onSubmit={submit}>
    <label htmlFor="exp-message">给 agent 发消息</label>
    <textarea ref={textarea} id="exp-message" value={text} rows={3} maxLength={8000} disabled={waitingForAnswer} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown}
      placeholder={waitingForAnswer ? "请先回答 agent 的问题" : working ? "agent 正在工作。可以先写好，等这一轮结束再发" : "例如：消融实验只跑一个 seed 就行"} />
    <div className="exp-composer-row">
      <span className={`exp-composer-status ${experiment.error && !working ? "is-error" : ""}`}>{status}</span>
      {working
        ? <button type="button" className="button" disabled={busy} onClick={onStop}><Square size={11} />停止</button>
        : <button type="submit" className="button button--primary" disabled={!text.trim() || waitingForAnswer || busy}>{busy ? <LoaderCircle className="spin" size={13} /> : <Send size={13} />}发送</button>}
    </div>
  </form>;
}


// ---------- 右栏 ----------

interface PanelProps {
  api: DesktopBridge;
  projectId: string;
  snapshot: ExperimentSnapshot;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  focusedJob: string | null;
  onFocusJob: (jobId: string | null) => void;
  busyKey: string;
  onJobAction: (job: ExperimentJob, action: JobAction) => void;
  onSaveRecord: (text: string) => Promise<boolean>;
  onShowJob: (jobId: string) => void;
  onError: (message: string) => void;
}

function ExperimentPanel(props: PanelProps) {
  const { snapshot, tab, onTab } = props;
  const tabs: Array<{ id: PanelTab; label: string }> = [
    { id: "record", label: "复现记录" },
    { id: "jobs", label: snapshot.jobs.length ? `后台任务 ${snapshot.jobs.length}` : "后台任务" },
    { id: "files", label: "文件" },
  ];
  return <aside className="exp-panel" aria-label="实验详情">
    <div className="exp-tabs" role="tablist">
      {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "is-active" : ""} onClick={() => onTab(item.id)}>{item.label}</button>)}
    </div>
    <div className="exp-panel-body" role="tabpanel">
      {tab === "record" && <RecordTab {...props} />}
      {tab === "jobs" && <JobsTab {...props} />}
      {tab === "files" && <FilesTab {...props} />}
    </div>
  </aside>;
}

function RecordTab({ api, projectId, snapshot, busyKey, onSaveRecord, onError }: PanelProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const open = () => void api.openExperimentPath(projectId, snapshot.experiment.id, "REPRO.md").catch((reason) => onError(cleanError(reason)));
  if (draft !== null) return <div className="exp-record-edit">
    <label htmlFor="exp-record">编辑 REPRO.md</label>
    <textarea id="exp-record" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} />
    <div className="exp-panel-actions">
      <span>保存后 agent 下一轮会看到你改过。</span>
      <button className="button" onClick={() => setDraft(null)}>取消</button>
      <button className="button button--primary" disabled={busyKey === "record"} onClick={async () => { if (await onSaveRecord(draft)) setDraft(null); }}>保存</button>
    </div>
  </div>;
  return <div className="exp-record">
    <div className="exp-markdown">{snapshot.record.trim() ? <Markdown source={snapshot.record} /> : <p className="exp-muted">REPRO.md 还是空的。</p>}</div>
    <div className="exp-panel-actions">
      <span><code>REPRO.md</code> 由 agent 维护，你也可以直接改。</span>
      <button className="button" onClick={open}>用编辑器打开</button>
      <button className="button" onClick={() => setDraft(snapshot.record)}><Pencil size={12} />编辑</button>
    </div>
  </div>;
}

function JobsTab({ snapshot, focusedJob, onFocusJob, busyKey, onJobAction, onShowJob }: PanelProps) {
  const jobs = [...snapshot.jobs].reverse();
  if (!jobs.length) return <p className="exp-muted exp-panel-empty">还没有后台任务。agent 遇到训练、完整评测这类长时间运行的命令时，会在这里提交，由你决定是否运行。</p>;
  return <div className="exp-jobs">
    {jobs.map((job) => {
      const open = focusedJob === job.id;
      return <div key={job.id} className={`exp-job-row ${open ? "is-open" : ""}`}>
        <button type="button" className="exp-job-row-head" aria-expanded={open} onClick={() => onFocusJob(open ? null : job.id)}>
          <strong>{job.origin === "user" ? `手动命令 ${job.id}` : job.name}</strong>
          <Pill {...jobStatusLabel[job.status]} />
          <span>{jobMeta(job)}</span>
        </button>
        {open && <div className="exp-job-row-body">
          <code className="exp-job-command">{job.command}</code>
          {job.note && <p className="exp-job-note">{job.note}</p>}
          {job.lastLine && <p className="exp-job-row-last">{job.lastLine}</p>}
          <div className="exp-panel-actions">
            <span>{job.log}</span>
            {job.status === "pending" && <>
              <button className="button" disabled={busyKey === `job-${job.id}`} onClick={() => onJobAction(job, "reject")}>不运行</button>
              <button className="button button--primary" disabled={busyKey === `job-${job.id}`} onClick={() => onJobAction(job, "approve")}><Play size={12} />开始运行</button>
            </>}
            {job.status === "running" && <button className="button exp-danger" disabled={busyKey === `job-${job.id}`} onClick={() => onJobAction(job, "stop")}>停止</button>}
            {job.status !== "pending" && job.status !== "rejected" && <button className="button" onClick={() => onShowJob(job.id)}><Terminal size={12} />在终端查看</button>}
          </div>
        </div>}
      </div>;
    })}
  </div>;
}


function FilesTab({ api, projectId, snapshot, onError }: PanelProps) {
  const [files, setFiles] = useState<ExperimentFileNode[] | null>(null);
  const [version, setVersion] = useState(0);
  const experimentId = snapshot.experiment.id;
  useEffect(() => {
    let alive = true;
    api.listExperimentFiles(projectId, experimentId)
      .then((nodes) => { if (alive) setFiles(nodes); })
      .catch((reason) => { if (alive) { setFiles([]); onError(cleanError(reason)); } });
    return () => { alive = false; };
  }, [api, projectId, experimentId, version, onError]);
  const open = (path: string) => void api.openExperimentPath(projectId, experimentId, path).catch((reason) => onError(cleanError(reason)));
  return <div className="exp-files">
    <div className="exp-panel-actions exp-panel-actions--top">
      <span>实验工作目录</span>
      <button className="button button--small" onClick={() => setVersion((value) => value + 1)}><RefreshCw size={12} />刷新</button>
      <button className="button button--small" onClick={() => open("")}><FolderOpen size={12} />打开文件夹</button>
    </div>
    {files === null ? <div className="exp-loading exp-loading--small"><LoaderCircle className="spin" size={13} />读取文件</div>
      : <ul className="exp-tree">{files.map((node) => <FileNode key={node.path} node={node} onOpen={open} />)}</ul>}
  </div>;
}

function FileNode({ node, onOpen }: { node: ExperimentFileNode; onOpen: (path: string) => void }) {
  if (node.kind === "file") return <li><button type="button" className="exp-tree-file" onClick={() => onOpen(node.path)}><FileText size={13} aria-hidden="true" /><span>{node.name}</span><small>{size(node.size)}</small></button></li>;
  if (node.collapsed || !node.children?.length) return <li><button type="button" className="exp-tree-file exp-tree-file--folder" onClick={() => onOpen(node.path)} title="在资源管理器中打开"><Folder size={13} aria-hidden="true" /><span>{node.name}/</span><small>{node.collapsed ? "未展开" : "空"}</small></button></li>;
  return <li><details open={node.name === "paper"}>
    <summary><ChevronRight size={12} className="exp-tree-chevron" aria-hidden="true" /><Folder size={13} aria-hidden="true" /><span>{node.name}/</span></summary>
    <ul>{node.children.map((child) => <FileNode key={child.path} node={child} onOpen={onOpen} />)}</ul>
  </details></li>;
}

// ---------- 新建 ----------

function NewExperimentModal({ papers, initialPaperId, initialGoal, busy, error, onClose, onCreate }: { papers: Paper[]; initialPaperId?: string; initialGoal?: string; busy: boolean; error: string; onClose: () => void; onCreate: (input: { paperId: string; goal: string; code: string; settings: ExperimentSettings }) => Promise<boolean> }) {
  const [network, setNetwork] = useState(true);
  const [approveJobs, setApproveJobs] = useState(true);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void onCreate({
      paperId: String(form.get("paperId") ?? ""),
      goal: String(form.get("goal") ?? "").trim(),
      code: String(form.get("code") ?? "").trim(),
      settings: { network, approveJobs },
    });
  };
  return <Modal title="新建实验" onClose={onClose}>
    {!papers.length ? <div className="exp-modal-empty">
      <p>还没有可用的论文。先在“文献分析”里导入论文，解析完成后再新建实验。</p>
      <div className="modal-actions"><button className="button" onClick={onClose}>知道了</button></div>
    </div> : <form className="form-stack exp-new" onSubmit={submit}>
      <label>论文
        <select name="paperId" defaultValue={papers.some((paper) => paper.id === initialPaperId) ? initialPaperId : papers[0].id}>{papers.map((paper) => <option key={paper.id} value={paper.id}>{paper.id} · {paper.title}</option>)}</select>
      </label>
      <label>要做什么
        <textarea name="goal" rows={4} required maxLength={4000} autoFocus defaultValue={initialGoal} placeholder="例如：复现 Table 2 里 HumanEval 和 MBPP 的结果。机器只有一张 4090。" />
        <small>写一句话就够。agent 会先读论文，回你一份计划，之后随时可以在对话里改。</small>
      </label>
      <label>代码（可选）
        <input name="code" maxLength={1000} placeholder="仓库地址或本地路径；留空则由 agent 从论文里找" />
      </label>
      <label className="exp-check"><input type="checkbox" checked={network} onChange={(event) => setNetwork(event.target.checked)} /><span><strong>允许联网</strong><small>安装依赖、下载代码和数据集时需要。</small></span></label>
      <label className="exp-check"><input type="checkbox" checked={approveJobs} onChange={(event) => setApproveJobs(event.target.checked)} /><span><strong>长任务开始前需要我确认</strong><small>长任务在沙箱外运行，比如训练和完整评测。</small></span></label>
      {error && <p className="exp-form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>取消</button>
        <button className="button button--primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建并开始</button>
      </div>
    </form>}
  </Modal>;
}
