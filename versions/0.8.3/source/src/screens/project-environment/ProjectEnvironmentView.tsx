import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Check, ChevronRight, CircleAlert, CircleCheck, Copy, FlaskConical, FolderOpen, HardDrive, History, Leaf, Link2, LoaderCircle, LockKeyhole, Package, Plus, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import type { DesktopBridge, Project } from "../../types";
import type { EnvironmentBindInput, EnvironmentCreateInput, EnvironmentExperiment, ProjectEnvironmentController, ProjectEnvironmentSnapshot } from "./model";
import "./screen.css";

type Tab = "overview" | "packages" | "history";
type Dialog = "create" | "bind" | "update" | null;
const statusLabel: Record<EnvironmentExperiment["status"], string> = { idle: "未运行", running: "运行中", done: "已完成", waiting: "等待依赖", needs_input: "等你作答" };

function Tag({ children, tone = "green" }: { children: ReactNode; tone?: "green" | "gray" | "amber" | "red" }) {
  return <span className={`pe-tag pe-tag--${tone}`}><span />{children}</span>;
}

function EnvironmentDialog({ title, description, busy, onClose, children }: { title: string; description: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.querySelector<HTMLElement>("input:not(:disabled),select:not(:disabled),button:not(:disabled)")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex='0']")];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [busy, onClose]);
  return <div className="pe-overlay" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onClose(); }}>
    <section className="pe-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="pe-dialog-title" aria-describedby="pe-dialog-description" aria-busy={busy}>
      <header><span className="pe-dialog-icon"><Leaf size={22} /></span><button type="button" className="pe-icon-button" aria-label="关闭弹窗" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <h2 id="pe-dialog-title">{title}</h2><p id="pe-dialog-description">{description}</p>
      {children}
    </section>
  </div>;
}

function OperationProgress({ controller }: { controller: ProjectEnvironmentController }) {
  const steps = controller.operation === "create" ? ["定位 Conda", "创建 Python 环境", "验证解释器", "保存课题绑定"]
    : controller.operation === "plan" ? ["读取环境依赖", "解析兼容性", "核对安装计划", "等待研究者确认"]
    : controller.operation === "update" ? ["保存依赖快照", "安装已确认依赖", "检查依赖兼容性", "更新环境记录"]
      : ["读取环境信息", "验证 Python", "检查依赖", "保存检查结果"];
  const active = Math.min(3, Math.floor(controller.progress / 25));
  return <div className="pe-progress" role="status" aria-live="polite">
    <div><LoaderCircle size={14} className="spin" /><strong>{steps[active]}</strong><span>{controller.progress}%</span></div>
    <progress value={controller.progress} max={100} aria-label="环境操作进度" />
    <ol>{steps.map((step, index) => <li key={step} className={index < active ? "is-done" : index === active ? "is-current" : ""}>{index < active ? <Check size={12} /> : <span>{index + 1}</span>}{step}</li>)}</ol>
  </div>;
}

export function ProjectEnvironmentStrip({ controller, onManage }: { controller: ProjectEnvironmentController; onManage: () => void }) {
  const env = controller.environment;
  return <div className={`pe-environment-strip ${env ? "" : "is-unconfigured"}`}>
    <span className="pe-strip-icon"><Leaf size={17} /></span>
    <div><strong>课题环境 <code>{env?.name ?? "尚未配置"}</code></strong><span>{env ? `Conda · Python ${env.pythonVersion} · 所有实验共用` : "配置一次，这个课题的所有实验自动复用"}</span></div>
    <Tag tone={!env || controller.error ? "amber" : "green"}>{!env ? "待配置" : controller.error ? "需检查" : `修订 ${env.revision}`}</Tag>
    <button type="button" className="pe-text-button" onClick={onManage}>{env ? "管理环境" : "配置环境"}<ChevronRight size={13} /></button>
  </div>;
}

export function ProjectEnvironmentView({ controller }: { controller: ProjectEnvironmentController }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [formError, setFormError] = useState("");
  const [planReady, setPlanReady] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const closeDialog = useCallback(() => { setDialog(null); setFormError(""); }, []);
  const env = controller.environment;
  const busy = controller.operation !== null || preparing;
  const running = controller.experiments.filter((experiment) => experiment.status === "running").length;
  const locked = controller.locked ?? running > 0;
  const canConfirm = planReady && (!controller.onPrepareUpdate || !!controller.request?.plan?.fingerprint);
  const noChanges = canConfirm && controller.request?.changes.length === 0;
  async function prepareUpdate() {
    setFormError(""); setPlanReady(false); setPreparing(true); setDialog("update");
    try { await controller.onPrepareUpdate?.(); setPlanReady(true); }
    catch (reason) { setFormError(String(reason instanceof Error ? reason.message : reason)); }
    finally { setPreparing(false); }
  }
  const filtered = useMemo(() => controller.packages.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()) && (source === "all" || item.source === source)), [controller.packages, query, source]);
  const copyPath = async () => {
    try { await navigator.clipboard.writeText(env?.prefix ?? controller.prefix); controller.onNotice("环境路径已复制"); }
    catch { controller.onNotice("复制失败，可选中路径手动复制"); }
  };
  async function submit(event: FormEvent<HTMLFormElement>, kind: "create" | "bind") {
    event.preventDefault(); setFormError("");
    const data = new FormData(event.currentTarget);
    try {
      if (kind === "create") {
        const input: EnvironmentCreateInput = { name: String(data.get("name") ?? "").trim(), pythonVersion: String(data.get("pythonVersion")), condaExecutable: String(data.get("condaExecutable") ?? "").trim() };
        if (!input.name || !input.condaExecutable) throw new Error("请填写环境名称和 Conda 程序位置。");
        await controller.onCreate(input);
      } else {
        const input: EnvironmentBindInput = { name: String(data.get("name") ?? "").trim(), prefix: String(data.get("prefix") ?? "").trim(), condaExecutable: String(data.get("condaExecutable") ?? "").trim() };
        if (!input.name || !input.prefix) throw new Error("请填写环境名称和环境目录。");
        await controller.onBind(input);
      }
      closeDialog();
    } catch (error) { setFormError(String(error instanceof Error ? error.message : error)); }
  }

  return <div className="pe-page">
    <header className="pe-page-heading"><div><p className="pe-eyebrow">课题设置 / {controller.projectTitle}</p><h1>运行环境</h1><p>配置一次，让这个课题的每个实验都用同一个环境。</p></div>
      <button className="button pe-button" type="button" disabled={!env || busy} onClick={() => void controller.onCheck()}><RefreshCw size={14} className={controller.operation === "check" ? "spin" : ""} />{controller.operation === "check" ? "正在检查" : "检查环境"}</button>
    </header>

    {controller.error && <div className="pe-alert pe-alert--error" role="alert"><CircleAlert size={17} /><div><strong>环境需要检查</strong><p>{controller.error}</p></div><button className="pe-text-button" type="button" disabled={busy} onClick={() => setDialog("bind")}>重新绑定<ArrowRight size={14} /></button></div>}
    {!controller.condaDetected && <div className="pe-alert" role="status"><CircleAlert size={17} /><div><strong>尚未检测到 Conda</strong><p>可以指定已安装的 conda.exe。平台不会自动安装或修改你的 Conda。</p></div><button className="pe-text-button" type="button" onClick={() => setDialog("create")}>指定位置<ArrowRight size={14} /></button></div>}
    {locked && <div className="pe-alert pe-alert--lock" role="status"><LockKeyhole size={16} /><div><strong>课题实验或终端正在使用此环境</strong><p>运行期间保持依赖不变。任务结束并关闭终端后，再安装依赖或更换环境。</p></div><span className="pe-lock-label">环境已锁定</span></div>}

    {env ? <section className="pe-hero" aria-label="当前课题环境">
      <div className="pe-hero-heading"><span className="pe-conda-logo"><Leaf size={29} strokeWidth={1.7} /></span><div><span className="pe-subtle-label">当前课题的共享环境</span><h2>{env.name}<span className="pe-kind">Conda</span></h2><p><ShieldCheck size={13} />论文复现与自主实验统一使用</p></div><Tag tone={controller.error ? "red" : "green"}>{controller.error ? "需检查" : "已就绪"}</Tag></div>
      <div className="pe-metrics"><div><span>Python 版本</span><strong>{env.pythonVersion}<small>{env.architecture ?? "Conda 环境"}</small></strong></div><div><span>已安装依赖</span><strong>{controller.packages.length}<small>个包 · 本机清单</small></strong></div><div><span>使用此环境</span><strong>{controller.experiments.length}<small>个实验</small></strong></div><div><span>环境修订</span><strong>v{env.revision}<small>依赖变更可追溯</small></strong></div></div>
      <div className="pe-path"><FolderOpen size={15} /><span>环境目录</span><code title={env.prefix}>{env.prefix}</code><button type="button" className="pe-icon-button" aria-label="复制环境路径" onClick={() => void copyPath()}><Copy size={14} /></button></div>
      <footer><span><CircleCheck size={12} />上次检查：{new Date(env.checkedAt).toLocaleString("zh-CN")}</span><span><HardDrive size={12} />{env.diskUsage}</span><button className="pe-text-button" type="button" disabled={busy || locked} onClick={() => setDialog("bind")}><Link2 size={13} />更换绑定</button></footer>
    </section> : <section className="pe-setup" aria-label="配置课题环境"><div className="pe-setup-copy"><span className="pe-setup-icon"><Leaf size={27} /></span><span className="pe-subtle-label">一个课题，一个环境</span><h2>给 {controller.projectTitle} 准备一个 Conda 环境</h2><p>新实验直接复用。你也可以把已经配好的环境绑定过来，<br />保留原有的 Python 和依赖，无需重复安装。</p><div className="pe-setup-actions"><button className="button button--primary pe-button" type="button" disabled={busy} onClick={() => setDialog("create")}><Plus size={14} />创建 Conda 环境</button><button className="button pe-button" type="button" disabled={busy} onClick={() => setDialog("bind")}><Link2 size={14} />绑定已有环境</button></div></div><ol className="pe-setup-steps"><li><span>01</span><div><strong>选择 Python 版本</strong><p>按课题代码要求配置一次</p></div></li><li><span>02</span><div><strong>绑定到当前课题</strong><p>论文复现与自主实验共同使用</p></div></li><li><span>03</span><div><strong>以后只检查，不重复创建</strong><p>缺少依赖时，统一确认后更新</p></div></li></ol></section>}

    {busy && !dialog && <OperationProgress controller={controller} />}
    <div className={`pe-content-grid ${env && controller.request ? "has-request" : ""}`}><section className="pe-content-card"><div className="pe-tabs" role="tablist" aria-label="环境详情">{([{ id: "overview", title: "使用概览", count: controller.experiments.length }, { id: "packages", title: "依赖包", count: env ? controller.packages.length : 0 }, { id: "history", title: "变更记录", count: controller.history.length }] as const).map((item) => <button type="button" role="tab" id={`pe-tab-${item.id}`} aria-controls="pe-tab-panel" aria-selected={tab === item.id} className={tab === item.id ? "is-active" : ""} key={item.id} onClick={() => setTab(item.id)}>{item.title}<span>{item.count}</span></button>)}</div>
      <div role="tabpanel" id="pe-tab-panel" aria-labelledby={`pe-tab-${tab}`}>
        {tab === "overview" && <><div className="pe-section-heading"><div><h3>使用这个环境的实验</h3><p>运行目录各自独立，Python 和依赖共用。</p></div><span className="pe-small-label">默认继承课题环境</span></div><div className="pe-experiments">{controller.experiments.map((experiment) => <div className="pe-experiment" key={experiment.id}><span className={`pe-experiment-icon ${experiment.kind === "自主实验" ? "is-designed" : ""}`}><FlaskConical size={17} /></span><div><strong>{experiment.title}</strong><span>{experiment.kind}<i />{experiment.id}</span></div><Tag tone={!env ? "gray" : experiment.status === "running" ? "green" : experiment.status === "waiting" || experiment.status === "needs_input" ? "amber" : "gray"}>{!env ? "待配置环境" : statusLabel[experiment.status]}</Tag></div>)}</div><div className="pe-sharing-note"><Link2 size={14} /><p>在不同实验间切换时继续使用 <strong>{env?.name ?? "课题环境"}</strong>，不会创建新的虚拟环境。</p></div></>}
        {tab === "packages" && <><div className="pe-package-tools"><label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索依赖包" aria-label="搜索依赖包" /></label><select aria-label="筛选依赖来源" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">全部来源</option><option value="conda">Conda</option><option value="pip">pip</option></select></div><div className="pe-package-table"><table><thead><tr><th>包名</th><th>版本</th><th>来源</th><th>用途</th></tr></thead><tbody>{env && filtered.map((item) => <tr key={item.name}><td><Package size={12} />{item.name}</td><td><code>{item.version}</code></td><td><span className="pe-source">{item.source}</span></td><td>{item.purpose}</td></tr>)}</tbody></table>{(!env || filtered.length === 0) && <p className="pe-table-empty">{env ? "没有找到匹配的依赖包" : "绑定环境后，在这里查看依赖清单"}</p>}</div></>}
        {tab === "history" && <div className="pe-history">{controller.history.length ? controller.history.map((item) => <article key={item.id}><span className="pe-history-icon"><History size={15} /></span><div><strong>{item.title}<span>v{item.revision}</span></strong><p>{item.detail}</p><time>{item.time}</time></div></article>) : <div className="pe-history-empty"><History size={25} /><h3>环境的每次变化，都会留下记录</h3><p>创建、绑定和依赖更新后，在这里查看环境修订与依赖快照。</p></div>}</div>}
      </div>
    </section>{env && controller.request && <aside className="pe-aside">
      <section className="pe-request-card"><div className="pe-request-heading"><span><Package size={16} /></span><Tag tone={controller.request.status === "failed" ? "red" : "amber"}>{controller.request.status === "failed" ? "安装失败" : controller.request.status === "installing" ? "正在安装" : "待你确认"}</Tag></div><h3>实验申请补充依赖</h3><p>来自「{controller.request.experiment}」。确认后会更新课题共享环境。</p><ul>{controller.request.changes.map((change) => <li key={change.name}><Plus size={12} /><code>{change.name}</code><span>{change.before ? `${change.before} → ${change.after}` : change.after}</span></li>)}</ul>{controller.request.note && <p>原因：{controller.request.note}</p>}<div className="pe-request-scope"><FlaskConical size={13} />所有课题实验会使用更新后的依赖</div><button className="button button--primary pe-button" type="button" disabled={busy || locked} onClick={() => void prepareUpdate()}>{locked ? <LockKeyhole size={14} /> : <Check size={14} />}{locked ? "等待环境使用结束" : "查看安装计划"}</button><button className="pe-text-button pe-reject" type="button" disabled={busy} onClick={controller.onRejectUpdate}>暂不安装</button></section>
    </aside>}</div>

    {dialog && <EnvironmentDialog title={dialog === "create" ? "创建课题 Conda 环境" : dialog === "bind" ? env ? "更换课题环境绑定" : "绑定已有 Conda 环境" : "确认更新共享环境"} description={dialog === "update" ? "请核对解析出的实际版本及升级、移除项；确认后才会安装。" : dialog === "create" ? "只创建一次。以后新建和切换实验，都会复用这个环境。" : "使用你已经配置好的环境，无需复制或重新安装依赖。"} busy={busy} onClose={closeDialog}>
      {dialog === "create" && <form onSubmit={(event) => void submit(event, "create")} className="pe-form"><div className="pe-form-grid"><label>环境显示名称<input name="name" defaultValue={controller.suggestedName} maxLength={50} required disabled={busy || !!env} /><small>显示名称可编辑，环境位置由课题 ID 固定。</small></label><label>Python 版本<select name="pythonVersion" defaultValue="3.11" disabled={busy}><option value="3.9">Python 3.9</option><option value="3.10">Python 3.10</option><option value="3.11">Python 3.11</option><option value="3.12">Python 3.12</option><option value="3.13">Python 3.13</option><option value="3.14">Python 3.14</option></select></label></div><label>Conda 程序<input name="condaExecutable" defaultValue={controller.condaExecutable} placeholder="例如 D:\Miniconda3\Scripts\conda.exe" required disabled={busy} /><small>{controller.condaDetected ? "已检测到可用 Conda。" : "填写已安装的 conda.exe 路径；平台不会安装 Conda。"}</small></label><label>环境保存位置<code className="pe-readonly-path">{controller.prefix}</code></label><div className="pe-dialog-note"><ShieldCheck size={15} /><p>使用独立 prefix 创建，不修改 base 环境。后续依赖安装由你查看计划并确认。</p></div>{formError && <p role="alert" className="pe-form-error">{formError}</p>}{busy && <OperationProgress controller={controller} />}<div className="pe-dialog-actions"><span>仅在你提交后创建课题环境</span><button className="button pe-button" type="button" disabled={busy} onClick={closeDialog}>取消</button><button className="button button--primary pe-button" type="submit" disabled={busy || !!env}>{busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}{busy ? "正在创建" : "创建并绑定"}</button></div></form>}
      {dialog === "bind" && <BindForm controller={controller} busy={busy} running={running} formError={formError} onSubmit={(event) => void submit(event, "bind")} onCancel={closeDialog} />}
      {dialog === "update" && <div className="pe-update-confirm"><div className="pe-update-context"><Leaf size={17} /><strong>{env?.name}</strong><span>当前 v{env?.revision}{!noChanges && <><ArrowRight size={12} />v{(env?.revision ?? 0) + 1}</>}</span></div><div className="pe-change-table"><div><span>依赖包</span><span>当前</span><span>变更后</span></div>{canConfirm && controller.request?.changes.map((change) => <div key={change.name}><code>{change.name}</code><span>{change.before ?? "未安装"}</span><strong>{change.after}</strong></div>)}</div>{!canConfirm && <p className="pe-dialog-note" role="status">{busy ? "正在读取实际环境并解析最新计划…" : "安装计划尚未就绪，请重新解析后确认。"}</p>}{noChanges && <p className="pe-dialog-note" role="status"><CircleCheck size={15} /><span>依赖已满足要求，无需重复安装。确认后将检查兼容性并完成本次申请。</span></p>}<p className="pe-dialog-note"><CircleAlert size={15} /><span>此计划按当前环境解析。安装前会重新检查，版本变化时需再次确认。</span></p>{locked && <p className="pe-form-error">环境正在被实验或终端使用，暂时不能修改。</p>}{busy && <OperationProgress controller={controller} />}{formError && <p className="pe-form-error" role="alert">{formError}</p>}<div className="pe-dialog-actions"><span>{noChanges ? "保留当前环境与依赖" : "更新前保存依赖快照"}</span><button className="button pe-button" type="button" disabled={busy} onClick={closeDialog}>取消</button>{!canConfirm && <button className="button pe-button" type="button" disabled={busy || locked} onClick={() => void prepareUpdate()}><RefreshCw size={14} />重新解析</button>}<button className="button button--primary pe-button" type="button" disabled={busy || locked || !canConfirm} onClick={async () => { try { await controller.onUpdate(); closeDialog(); } catch (error) { setPlanReady(false); setFormError(String(error)); } }}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{busy ? "正在处理" : noChanges ? "验证并完成申请" : "确认并安装"}</button></div></div>}
    </EnvironmentDialog>}
  </div>;
}

export function ProjectEnvironmentPage({ project, api = window.autoresearch }: { project: Project; api?: DesktopBridge }) {
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<DesktopBridge["getProjectEnvironment"]>> | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setSnapshot(await api.getProjectEnvironment(project.id)); setError(""); }
    catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
  }, [api, project.id]);
  useEffect(() => {
    void refresh();
    return api.onProjectEnvironmentUpdate((projectId) => { if (projectId === project.id) void refresh(); });
  }, [api, project.id, refresh]);

  if (!snapshot) return <div className="pe-loading" role={error ? "alert" : "status"}>{error || "正在读取课题运行环境"}</div>;
  const act = async (request: Promise<ProjectEnvironmentSnapshot>) => {
    try { const next = await request; setSnapshot(next); return next; }
    catch (reason) {
      // 失败也可能已经安装部分依赖或使旧计划失效，不能继续展示旧快照。
      try { setSnapshot(await api.getProjectEnvironment(project.id)); } catch { /* 保留原操作错误。 */ }
      throw reason;
    }
  };
  const controller: ProjectEnvironmentController = {
    ...snapshot,
    locked: snapshot.locked,
    availableEnvironments: snapshot.availableEnvironments,
    onCreate: async (input) => { await act(api.createProjectEnvironment(project.id, input)); },
    onBind: async (input) => { await act(api.bindProjectEnvironment(project.id, input)); },
    onCheck: async () => { await act(api.checkProjectEnvironment(project.id)); },
    onPrepareUpdate: async () => { await act(api.prepareProjectEnvironmentUpdate(project.id, snapshot.request?.id || "")); },
    onUpdate: async () => {
      const request = snapshot.request;
      if (!request?.id || !request.plan?.fingerprint) throw new Error("请先解析最新的安装计划。");
      await act(api.approveProjectEnvironmentUpdate(project.id, request.id, request.plan.fingerprint));
    },
    onRejectUpdate: () => {
      const id = snapshot.request?.id;
      if (id) void api.rejectProjectEnvironmentUpdate(project.id, id).then(setSnapshot).catch((reason) => setError(String(reason)));
    },
    onNotice: setError,
  };
  return <div className="pe-production-page">{error && <div className="pe-inline-error" role="alert">{error}</div>}<ProjectEnvironmentView controller={controller} /></div>;
}

function BindForm({ controller, busy, running, formError, onSubmit, onCancel }: { controller: ProjectEnvironmentController; busy: boolean; running: number; formError: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  const choices = controller.availableEnvironments ?? [];
  const [choice, setChoice] = useState(controller.environment?.prefix ?? choices.find((item) => !item.base)?.prefix ?? "manual");
  const [manualPrefix, setManualPrefix] = useState("");
  const [manualName, setManualName] = useState(controller.suggestedName);
  const selected = choices.find((item) => item.prefix === choice && !item.base);
  return <form className="pe-form" onSubmit={onSubmit}><span className="pe-field-label">选择已有环境 <small>从本机 Conda 环境列表读取</small></span><div className="pe-bind-options">{choices.map((item) => <label key={item.prefix} className={`${choice === item.prefix ? "is-selected" : ""} ${item.base ? "is-disabled" : ""}`}><input type="radio" name="choice" value={item.prefix} checked={choice === item.prefix} onChange={() => setChoice(item.prefix)} disabled={busy || item.base} /><span><strong>{item.name}{item.base && <span className="pe-base-label">基础环境</span>}</strong><code>{item.prefix}</code></span>{item.base && <LockKeyhole size={14} />}</label>)}<label className={choice === "manual" ? "is-selected" : ""}><input type="radio" name="choice" value="manual" checked={choice === "manual"} onChange={() => setChoice("manual")} disabled={busy} /><span><strong>手动指定环境目录</strong><small>选择独立 Conda 环境的文件夹。</small></span></label></div>{choice === "manual" && <div className="pe-manual-fields"><label>环境显示名称<input value={manualName} onChange={(event) => setManualName(event.target.value)} required disabled={busy} /></label><label>环境目录<input value={manualPrefix} onChange={(event) => setManualPrefix(event.target.value)} placeholder="例如 E:\conda-envs\rsi" required disabled={busy} /><small>选择环境目录，不是 conda.exe 或 python.exe。</small></label></div>}<input type="hidden" name="name" value={selected?.name ?? manualName} /><input type="hidden" name="prefix" value={selected?.prefix ?? manualPrefix} /><input type="hidden" name="condaExecutable" value={controller.condaExecutable} /><div className="pe-dialog-note"><Link2 size={15} /><p>只更改当前课题的绑定，不删除旧环境。平台会验证 Python 和依赖清单。</p></div>{formError && <p className="pe-form-error" role="alert">{formError}</p>}{busy && <OperationProgress controller={controller} />}<div className="pe-dialog-actions"><span>环境由课题 ID 固定绑定</span><button className="button pe-button" type="button" disabled={busy} onClick={onCancel}>取消</button><button className="button button--primary pe-button" type="submit" disabled={busy || controller.locked || running > 0}>{busy ? <LoaderCircle size={14} className="spin" /> : <Link2 size={14} />}{busy ? "正在验证" : "验证并绑定"}</button></div></form>;
}
