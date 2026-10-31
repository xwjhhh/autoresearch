import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ChevronDown, ChevronUp, Copy, ExternalLink, LoaderCircle, Play, Search, Square, SquareTerminal, X } from "lucide-react";
import type { DesktopBridge, ExperimentJob, ExperimentSnapshot } from "../../types";
import { LogScreen, type LogStyle } from "./logScreen";

const LINE_HEIGHT = 18;
const OVERSCAN = 30;
const HEIGHT_KEY = "autoresearch.exp-terminal-height";
const cleanError = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, "");

function bytes(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function elapsed(from?: string, to?: string) {
  if (!from) return "";
  const seconds = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const dot: Record<string, string> = { running: "is-running", done: "is-done", failed: "is-failed", stopped: "is-muted", lost: "is-failed", pending: "is-pending", rejected: "is-muted" };

function cssOf(style: LogStyle): CSSProperties | undefined {
  if (!style.fg && !style.bg && !style.bold && !style.dim && !style.italic && !style.underline) return undefined;
  return {
    color: style.fg, background: style.bg, fontWeight: style.bold ? 600 : undefined, opacity: style.dim ? 0.65 : undefined,
    fontStyle: style.italic ? "italic" : undefined, textDecoration: style.underline ? "underline" : undefined,
  };
}

// ---------- 日志视图：只渲染可见的行 ----------

function LogView({ screen, version, query, current, follow, onFollow }: {
  screen: LogScreen; version: number; query: string; current: number; follow: boolean; onFollow: (value: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 300 });
  const total = screen.length;

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setView({ top: element.scrollTop, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = box.current;
    if (element && follow) element.scrollTop = element.scrollHeight;
  }, [version, follow, total]);

  useEffect(() => {
    const element = box.current;
    if (!element || current < 0) return;
    const target = current * LINE_HEIGHT - element.clientHeight / 2;
    element.scrollTop = Math.max(0, target);
  }, [current]);

  const lower = query.toLocaleLowerCase();
  const start = Math.max(0, Math.floor(view.top / LINE_HEIGHT) - OVERSCAN);
  const end = Math.min(total, Math.ceil((view.top + view.height) / LINE_HEIGHT) + OVERSCAN);
  const rows = [];
  for (let index = start; index < end; index += 1) {
    const hit = lower && screen.text(index).toLocaleLowerCase().includes(lower);
    rows.push(<div key={index} className={`term-line${hit ? " is-hit" : ""}${index === current ? " is-current" : ""}`} style={{ top: index * LINE_HEIGHT }}>
      {screen.spans(index).map((span, column) => <span key={column} style={cssOf(screen.styleOf(span.style))}>{span.text}</span>)}
    </div>);
  }

  return <div className="term-scroll" ref={box} tabIndex={0} aria-label="终端输出"
    onWheel={(event) => { if (event.deltaY < 0) onFollow(false); }}
    onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) onFollow(false); }}
    onScroll={(event) => {
    const element = event.currentTarget;
    setView({ top: element.scrollTop, height: element.clientHeight });
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < LINE_HEIGHT * 2;
    if (atBottom !== follow) onFollow(atBottom);
  }}>
    <div className="term-canvas" style={{ height: Math.max(total, 1) * LINE_HEIGHT }}>{rows}</div>
  </div>;
}

// ---------- 搜索框 ----------

function useSearch(screen: LogScreen | null, version: number) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(-1);
  const matches = useMemo(() => {
    if (!screen || !query.trim()) return [];
    const lower = query.toLocaleLowerCase();
    const found: number[] = [];
    for (let index = 0; index < screen.length && found.length < 5000; index += 1) if (screen.text(index).toLocaleLowerCase().includes(lower)) found.push(index);
    return found;
  // version 变化代表屏幕内容变了，需要重新查找。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, query, version]);
  useEffect(() => setCursor(matches.length ? matches.length - 1 : -1), [query]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = (delta: number) => setCursor((value) => (matches.length ? (value + delta + matches.length) % matches.length : -1));
  return { open, setOpen, query: open ? query : "", setQuery, matches, cursor, current: open && cursor >= 0 ? matches[cursor] ?? -1 : -1, step };
}

function SearchBar({ search, onClose }: { search: ReturnType<typeof useSearch>; onClose: () => void }) {
  return <div className="term-search">
    <Search size={12} aria-hidden="true" />
    <input autoFocus value={search.query} placeholder="在输出里查找" onChange={(event) => search.setQuery(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") search.step(event.shiftKey ? -1 : 1); if (event.key === "Escape") onClose(); }} />
    <span className="term-search-count">{search.matches.length ? `${search.cursor + 1}/${search.matches.length}` : search.query ? "无结果" : ""}</span>
    <button type="button" className="term-icon" title="上一个（Shift+Enter）" onClick={() => search.step(-1)}><ChevronUp size={13} /></button>
    <button type="button" className="term-icon" title="下一个（Enter）" onClick={() => search.step(1)}><ChevronDown size={13} /></button>
    <button type="button" className="term-icon" title="关闭" onClick={onClose}><X size={13} /></button>
  </div>;
}

// ---------- 后台任务日志 ----------

interface LogCache {
  screen: LogScreen;
  decoder: TextDecoder;
  next?: number;
  skipped: number;
  size: number;
  error: string;
  loading: boolean;
}

function JobPane({ api, projectId, experimentId, job, cache, busy, onJobAction, onError }: {
  api: DesktopBridge; projectId: string; experimentId: string; job: ExperimentJob; cache: Map<string, LogCache>;
  busy: boolean; onJobAction: (job: ExperimentJob, action: "stop") => void; onError: (message: string) => void;
}) {
  if (!cache.has(job.id)) cache.set(job.id, { screen: new LogScreen(), decoder: new TextDecoder("utf-8"), skipped: 0, size: 0, error: "", loading: true });
  const state = cache.get(job.id)!;
  const [version, setVersion] = useState(0);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const inflight = useRef(false);
  const search = useSearch(state.screen, version);
  const running = job.status === "running";

  const pull = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      for (let round = 0; round < 8; round += 1) {
        const chunk = await api.readExperimentJobLogChunk(projectId, experimentId, job.id, state.next);
        if (chunk.reset) { state.screen.reset(); state.decoder = new TextDecoder("utf-8"); }
        if (state.next === undefined || chunk.reset) state.skipped = chunk.skipped;
        if (chunk.bytes.length) state.screen.write(state.decoder.decode(chunk.bytes, { stream: true }));
        state.next = chunk.next;
        state.size = chunk.size;
        state.error = "";
        if (chunk.next >= chunk.size) break;
      }
    } catch (reason) {
      state.error = cleanError(reason);
    } finally {
      state.loading = false;
      inflight.current = false;
      setVersion((value) => value + 1);
    }
  }, [api, projectId, experimentId, job.id, state]);

  useEffect(() => {
    void pull();
    if (!running) return;
    const timer = window.setInterval(() => void pull(), 1000);
    return () => window.clearInterval(timer);
  }, [pull, running, job.status]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.screen.plainText());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (reason) { onError(cleanError(reason)); }
  };
  const openLog = () => void api.openExperimentPath(projectId, experimentId, job.log).catch((reason) => onError(cleanError(reason)));

  const meta = job.status === "running" ? `已运行 ${elapsed(job.startedAt)}`
    : job.status === "done" || job.status === "failed" ? `退出码 ${job.exitCode ?? "未知"}，用时 ${elapsed(job.startedAt, job.finishedAt)}`
    : job.status === "stopped" ? `运行 ${elapsed(job.startedAt, job.finishedAt)} 后停止`
    : job.status === "lost" ? "进程丢失，没有拿到退出码" : "";

  return <div className="term-pane">
    <div className="term-toolbar">
      <code className="term-command" title={job.command}>{job.cwd !== "." && <span className="term-cwd">{job.cwd} &gt; </span>}{job.command}</code>
      <span className={`term-meta ${job.status === "failed" || job.status === "lost" ? "is-failed" : ""}`}>{meta}</span>
      <button type="button" className={`term-icon ${search.open ? "is-on" : ""}`} title="查找" aria-pressed={search.open} onClick={() => search.setOpen(!search.open)}><Search size={13} /></button>
      <button type="button" className="term-icon" title={copied ? "已复制" : "复制已加载的输出"} onClick={() => void copy()}><Copy size={13} /></button>
      <button type="button" className="term-icon" title="用编辑器打开完整日志" onClick={openLog}><ExternalLink size={13} /></button>
      {running && <button type="button" className="term-btn term-danger" disabled={busy} onClick={() => onJobAction(job, "stop")}><Square size={10} />停止</button>}
    </div>
    {search.open && <SearchBar search={search} onClose={() => search.setOpen(false)} />}
    {state.skipped > 0 && <p className="term-notice">前面还有 {bytes(state.skipped)} 没有显示。<button type="button" onClick={openLog}>打开完整日志</button></p>}
    {state.error && <p className="term-notice is-error">读取日志失败：{state.error}</p>}
    <div className="term-body">
      {state.loading ? <p className="term-empty"><LoaderCircle className="spin" size={13} />读取日志</p>
        : state.screen.length <= 1 && !state.screen.text(0) ? <p className="term-empty">{running ? "还没有输出。命令启动后，输出会实时出现在这里。" : "日志是空的。"}</p>
        : <LogView screen={state.screen} version={version} query={search.query} current={search.current} follow={follow && search.current < 0} onFollow={setFollow} />}
      {!follow && <button type="button" className="term-follow" onClick={() => { search.setOpen(false); setFollow(true); }}><ArrowDown size={12} />回到最新</button>}
    </div>
  </div>;
}

// ---------- agent 的短命令 ----------

function AgentPane({ snapshot }: { snapshot: ExperimentSnapshot }) {
  const live = snapshot.live ?? null;
  const screen = useRef(new LogScreen(5000)).current;
  const [version, setVersion] = useState(0);
  const [follow, setFollow] = useState(true);
  const [, tick] = useState(0);
  useEffect(() => {
    screen.reset();
    if (live?.output) screen.write(live.output);
    setVersion((value) => value + 1);
  }, [live?.id, live?.output, screen]);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const recent = useMemo(() => snapshot.events.filter((event) => event.type === "command").slice(-20).reverse(), [snapshot.events]);
  return <div className="term-pane term-agent">
    {live ? <section className="term-live">
      <div className="term-toolbar">
        <span className="term-live-dot" aria-hidden="true" />
        <code className="term-command" title={live.command}>{live.command}</code>
        <span className="term-meta">已执行 {elapsed(live.startedAt)}</span>
      </div>
      <div className="term-body term-body--live">
        {live.output ? <LogView screen={screen} version={version} query="" current={-1} follow={follow} onFollow={setFollow} />
          : <p className="term-empty">命令在 agent 的沙箱里执行。Codex 只在部分版本中实时提供输出，没有输出时会在结束后显示在下面。</p>}
      </div>
    </section> : <p className="term-agent-idle">{snapshot.experiment.agent === "working" ? "agent 正在工作，当前没有执行命令。" : "agent 现在没有执行命令。"}它执行的短命令（装依赖、看文件、跑小测试）会显示在这里；训练、完整评测这类长任务会作为后台任务单独显示。</p>}
    {recent.length > 0 && <ol className="term-history">
      {recent.map((event) => {
        const failed = typeof event.exitCode === "number" && event.exitCode !== 0;
        return <li key={event.id}>
          <details>
            <summary><code>{event.command}</code><span className={failed ? "is-failed" : ""}>{typeof event.exitCode === "number" ? `退出码 ${event.exitCode}` : "已结束"}</span></summary>
            <pre>{stripAnsi(event.output ?? "").trim() || "没有输出。"}</pre>
          </details>
        </li>;
      })}
    </ol>}
  </div>;
}

// ---------- 手动运行 ----------

function RunForm({ busy, defaultCwd, onRun, onClose }: { busy: boolean; defaultCwd: string; onRun: (input: { command: string; cwd: string; notify: boolean }) => Promise<boolean>; onClose: () => void }) {
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState(defaultCwd);
  const [notify, setNotify] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!command.trim() || busy) return;
    if (await onRun({ command: command.trim(), cwd: cwd.trim() || ".", notify })) setCommand("");
  };
  return <form className="term-run" onSubmit={submit}>
    <span className="term-prompt" aria-hidden="true">PS&gt;</span>
    <input className="term-run-command" autoFocus value={command} maxLength={8000} placeholder="例如 nvidia-smi，或 conda run -n repro python eval.py --quick" onChange={(event) => setCommand(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} aria-label="要运行的命令" />
    <label className="term-run-cwd" title="相对实验工作目录">目录 <input value={cwd} onChange={(event) => setCwd(event.target.value)} aria-label="工作目录" /></label>
    <label className="term-run-notify" title="不勾选时，agent 会在你下一条消息里看到这条命令的结果"><input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} />结束后交给 agent</label>
    <button type="submit" className="term-btn term-btn--primary" disabled={busy || !command.trim()}>{busy ? <LoaderCircle className="spin" size={12} /> : <Play size={11} />}运行</button>
    <button type="button" className="term-icon" title="收起" onClick={onClose}><X size={13} /></button>
  </form>;
}

// ---------- 面板 ----------

export type TerminalTab = "agent" | string;

export function TerminalDock({ api, projectId, snapshot, open, onOpenChange, active, onActive, busyKey, onJobAction, onError }: {
  api: DesktopBridge; projectId: string; snapshot: ExperimentSnapshot; open: boolean; onOpenChange: (open: boolean) => void;
  active: TerminalTab | null; onActive: (tab: TerminalTab) => void; busyKey: string;
  onJobAction: (job: ExperimentJob, action: "stop") => void; onError: (message: string) => void;
}) {
  const experimentId = snapshot.experiment.id;
  const cache = useRef(new Map<string, LogCache>()).current;
  const [height, setHeight] = useState(() => {
    const max = Math.max(160, window.innerHeight * 0.75);
    try { return Math.min(Math.max(Number(localStorage.getItem(HEIGHT_KEY)) || 280, 160), max); } catch { return Math.min(280, max); }
  });
  const [running, setRunning] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const [, tick] = useState(0);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const resize = () => setHeight((value) => Math.min(value, Math.max(160, window.innerHeight * 0.75)));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const tabs = useMemo(() => snapshot.jobs.filter((job) => job.status !== "pending" && job.status !== "rejected").sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true })), [snapshot.jobs]);
  const runningJobs = tabs.filter((job) => job.status === "running");
  const current = active === "agent" ? "agent" : tabs.find((job) => job.id === active)?.id ?? runningJobs[0]?.id ?? tabs[0]?.id ?? "agent";
  const currentJob = tabs.find((job) => job.id === current);

  // 新开始运行的任务：自动展开面板并切过去。打开页面时已经在跑的任务不算。
  useEffect(() => {
    const ids = new Set(snapshot.jobs.filter((job) => job.status === "running").map((job) => job.id));
    if (seen.current) {
      const fresh = [...ids].filter((id) => !seen.current!.has(id));
      if (fresh.length) { onActive(fresh[fresh.length - 1]); onOpenChange(true); }
    }
    seen.current = ids;
  }, [snapshot.jobs, onActive, onOpenChange]);

  useEffect(() => {
    if (!runningJobs.length || !open) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [runningJobs.length, open]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const max = Math.max(200, window.innerHeight * 0.75);
    let latest = startHeight;
    const move = (moveEvent: PointerEvent) => { latest = Math.min(max, Math.max(140, startHeight + startY - moveEvent.clientY)); setHeight(latest); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try { localStorage.setItem(HEIGHT_KEY, String(Math.round(latest))); } catch { /* 记不住高度不影响使用。 */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const run = async (input: { command: string; cwd: string; notify: boolean }) => {
    setRunning(true);
    try {
      const job = await api.runExperimentCommand(projectId, experimentId, input);
      onActive(job.id);
      return true;
    } catch (reason) {
      onError(cleanError(reason));
      return false;
    } finally {
      setRunning(false);
    }
  };

  const openShell = () => void api.openExperimentTerminal(projectId, experimentId, currentJob?.cwd ?? ".").catch((reason) => onError(cleanError(reason)));

  const preview = runningJobs[0];
  const live = snapshot.live;

  return <section className={`term-dock ${open ? "is-open" : ""}`} style={open ? { height } : undefined} aria-label="终端">
    {open && <div className="term-resize" onPointerDown={startResize} role="separator" aria-orientation="horizontal" aria-label="拖动调整终端高度" />}
    <header className="term-head">
      <button type="button" className="term-toggle" aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <SquareTerminal size={14} aria-hidden="true" />
        <strong>终端</strong>
        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
      {open ? <div className="term-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={current === "agent"} className={`term-tab ${current === "agent" ? "is-active" : ""}`} onClick={() => onActive("agent")}>
          <span className={`term-dot ${live ? "is-running" : "is-muted"}`} />Agent 命令
        </button>
        {tabs.map((job) => <button key={job.id} type="button" role="tab" aria-selected={current === job.id} className={`term-tab ${current === job.id ? "is-active" : ""}`} onClick={() => onActive(job.id)} title={job.command}>
          <span className={`term-dot ${dot[job.status] ?? ""}`} />{job.origin === "user" ? `手动 ${job.id.replace("job_", "#")}` : job.name}
          {job.status === "running" && <span className="term-tab-time">{elapsed(job.startedAt)}</span>}
        </button>)}
      </div> : <p className="term-summary">
        {preview ? <><span className="term-dot is-running" />{runningJobs.length > 1 ? `${runningJobs.length} 个任务运行中` : preview.name}<code>{preview.lastLine || "等待输出"}</code></>
          : live ? <><span className="term-dot is-running" />agent 正在执行<code>{live.command}</code></>
          : <span className="term-summary-idle">{tabs.length ? `${tabs.length} 个后台任务，没有在运行` : "后台任务和 agent 执行的命令会显示在这里"}</span>}
      </p>}
      <div className="term-head-actions">
        <button type="button" className={`term-btn ${showRun && open ? "is-on" : ""}`} onClick={() => { onOpenChange(true); setShowRun(!showRun || !open); }} title="输入一条命令，交给后台执行器运行">手动运行</button>
        <button type="button" className="term-btn" onClick={openShell} title="在实验工作目录打开一个系统 PowerShell 窗口，随便敲，与平台互不影响">打开 PowerShell</button>
      </div>
    </header>
    {open && <>
      {showRun && <RunForm busy={running} defaultCwd={currentJob?.cwd ?? "."} onRun={run} onClose={() => setShowRun(false)} />}
      {current === "agent" || !currentJob
        ? <AgentPane snapshot={snapshot} />
        : <JobPane key={currentJob.id} api={api} projectId={projectId} experimentId={experimentId} job={currentJob} cache={cache} busy={busyKey === `job-${currentJob.id}`} onJobAction={onJobAction} onError={onError} />}
    </>}
  </section>;
}
