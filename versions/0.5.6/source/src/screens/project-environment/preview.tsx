import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRight, BookOpen, Check, ChevronRight, CircleAlert, FlaskConical, FolderOpen, Leaf, Lightbulb, MessageSquareText, PanelLeftClose, RotateCcw, Settings2, SlidersHorizontal, Terminal } from "lucide-react";
import { ProjectEnvironmentStrip, ProjectEnvironmentView } from "./ProjectEnvironmentView";
import type { EnvironmentExperiment, EnvironmentHistory, EnvironmentOperation, EnvironmentPackage, EnvironmentScenario, EnvironmentUpdateRequest, ProjectEnvironmentController, ProjectPythonEnvironment } from "./model";
import "../../styles/global.css";
import "./preview.css";

// 此入口仅供 UI 评审。所有状态保存在浏览器内存；不调用 Electron、Conda、API 或真实课题数据。
type ProjectKey = "rsi" | "retrieval";
interface DemoState {
  scenario: EnvironmentScenario;
  environment: ProjectPythonEnvironment | null;
  packages: EnvironmentPackage[];
  request: EnvironmentUpdateRequest | null;
  history: EnvironmentHistory[];
}
const projects = {
  rsi: { id: "de47d4d6-639b-4050-82df-2c77d0ed7d52", title: "RSI", environment: "ar-rsi", direction: "递归自我改进研究" },
  retrieval: { id: "64e054ed-3c73-4d6e-9e89-913c1218f982", title: "多模态检索", environment: "ar-retrieval", direction: "视觉与语言检索研究" },
};
const condaExecutable = "D:\\Miniconda3\\Scripts\\conda.exe";
const prefixFor = (key: ProjectKey) => `C:\\AutoResearch\\data\\Environments\\${projects[key].id}\\conda`;
const samplePackages: EnvironmentPackage[] = [
  { name: "python", version: "3.11.11", source: "conda", purpose: "Python 解释器" },
  { name: "pip", version: "24.3.1", source: "conda", purpose: "依赖安装工具" },
  { name: "numpy", version: "1.26.4", source: "conda", purpose: "数值计算" },
  { name: "scipy", version: "1.14.1", source: "conda", purpose: "科学计算" },
  { name: "pandas", version: "2.2.3", source: "conda", purpose: "数据处理" },
  { name: "pytorch", version: "2.5.1", source: "conda", purpose: "训练与推理" },
  { name: "pyyaml", version: "6.0.2", source: "conda", purpose: "配置文件读取" },
  { name: "reportlab", version: "4.2.5", source: "pip", purpose: "报告生成" },
  { name: "pillow", version: "11.0.0", source: "conda", purpose: "图像处理" },
  { name: "tqdm", version: "4.67.1", source: "pip", purpose: "运行进度" },
  { name: "requests", version: "2.32.3", source: "pip", purpose: "HTTP 请求" },
  { name: "packaging", version: "24.2", source: "pip", purpose: "版本约束解析" },
];
function sampleState(key: ProjectKey, scenario: EnvironmentScenario = key === "rsi" ? "ready" : "unconfigured"): DemoState {
  const configured = !["unconfigured", "conda-missing"].includes(scenario);
  return {
    scenario,
    environment: configured ? { name: projects[key].environment, prefix: prefixFor(key), condaExecutable, pythonVersion: "3.11.11", revision: 3, checkedAt: "今天 14:32 · 示例", diskUsage: "2.4 GB" } : null,
    packages: configured ? structuredClone(samplePackages) : [],
    request: configured && key === "rsi" ? { experiment: "Skills-Coach 单技能试跑", changes: [{ name: "anthropic", before: null, after: "按仓库约束解析" }, { name: "psutil", before: null, after: "按仓库约束解析" }] } : null,
    history: configured ? [
      { id: "sample-v3", revision: 3, title: "补充报告与图像处理依赖", detail: "增加 reportlab、pillow，并保存变更后的依赖快照。", time: "今天 14:28" },
      { id: "sample-v2", revision: 2, title: "配置课题基础依赖", detail: "确认安装数值计算与训练依赖，关联论文基线评测。", time: "昨天 16:05" },
      { id: "sample-v1", revision: 1, title: "创建课题 Conda 环境", detail: "使用固定 prefix 创建 Python 3.11 环境，并绑定课题。", time: "昨天 15:42" },
    ] : [],
  };
}

function EnvironmentPreview() {
  const [projectKey, setProjectKey] = useState<ProjectKey>("rsi");
  const [states, setStates] = useState<Record<ProjectKey, DemoState>>(() => ({ rsi: sampleState("rsi"), retrieval: sampleState("retrieval") }));
  const [page, setPage] = useState<"environment" | "experiments">("environment");
  const [operation, setOperation] = useState<EnvironmentOperation>(null);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const toastTimer = useRef<number>();
  const timers = useRef(new Set<number>());
  const operationGuard = useRef(false);
  const project = projects[projectKey], state = states[projectKey];
  const busy = operation !== null;
  const pushNotice = (message: string) => { setNotice(message); window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setNotice(""), 4200); };
  useEffect(() => () => { window.clearTimeout(toastTimer.current); timers.current.forEach(window.clearTimeout); }, []);
  const patch = (transform: (current: DemoState) => DemoState, key: ProjectKey = projectKey) => setStates((current) => ({ ...current, [key]: transform(current[key]) }));
  const delay = () => new Promise<void>((done) => { const timer = window.setTimeout(() => { timers.current.delete(timer); done(); }, 300); timers.current.add(timer); });
  async function simulate(kind: NonNullable<EnvironmentOperation>, update: (current: DemoState) => DemoState) {
    if (operationGuard.current) throw new Error("请等待当前演示操作结束。");
    if (state.scenario === "running" && kind !== "check") throw new Error("实验运行期间不能修改共享环境。");
    operationGuard.current = true; setOperation(kind); setProgress(0);
    const key = projectKey;
    try {
      for (const value of [12, 30, 55, 80, 100]) { await delay(); setProgress(value); }
      patch(update, key);
    } finally { setOperation(null); operationGuard.current = false; }
  }
  const experiments: EnvironmentExperiment[] = projectKey === "rsi" ? [
    { id: "exp_001", title: "Skills-Coach 单技能试跑", kind: "论文复现", status: state.request ? "waiting" : "idle" },
    { id: "exp_002", title: "论文基线评测", kind: "论文复现", status: state.scenario === "running" ? "running" : "done" },
    { id: "exp_003", title: "反馈策略对照实验", kind: "自主实验", status: "idle" },
  ] : [{ id: "exp_001", title: "跨模态检索基线", kind: "论文复现", status: "idle" }];
  const controller: ProjectEnvironmentController = {
    projectTitle: project.title,
    suggestedName: project.environment,
    prefix: prefixFor(projectKey), condaExecutable,
    condaDetected: state.scenario !== "conda-missing",
    environment: state.environment, operation, progress,
    error: state.scenario === "error" ? "已绑定的 Python 解释器暂时不可用。请确认环境目录所在磁盘可访问，或重新绑定已有环境。" : "",
    packages: state.packages, experiments, request: state.request, history: state.history,
    onNotice: pushNotice,
    onCreate: async (input) => {
      await simulate("create", (current) => ({ ...current, scenario: "ready", environment: { ...input, prefix: prefixFor(projectKey), revision: 1, checkedAt: "刚刚 · 演示", diskUsage: "待实际检测" }, packages: [{ name: "python", version: input.pythonVersion, source: "conda", purpose: "Python 解释器" }, { name: "pip", version: "示例版本", source: "conda", purpose: "依赖安装工具" }], request: null, history: [{ id: String(Date.now()), title: "创建并绑定课题 Conda 环境", detail: `Python ${input.pythonVersion}，其余依赖按实验需求统一确认。`, revision: 1, time: "刚刚" }] }));
      pushNotice("已演示创建与绑定，没有创建真实环境。");
    },
    onBind: async (input) => {
      if (/(?:^|[\\/])base[\\/]?$/i.test(input.prefix)) throw new Error("请选择独立的课题环境，不要使用 base。");
      await simulate("bind", (current) => ({ ...current, scenario: "ready", environment: { ...input, condaExecutable, pythonVersion: "3.11.11", revision: (current.environment?.revision ?? 0) + 1, checkedAt: "刚刚 · 演示", diskUsage: "待实际检测" }, packages: structuredClone(samplePackages), history: [{ id: String(Date.now()), title: `绑定已有环境 ${input.name}`, detail: "所有实验继承新绑定；原环境保留。真实版本需由后端检测。", revision: (current.environment?.revision ?? 0) + 1, time: "刚刚" }, ...current.history] }));
      pushNotice("已演示绑定，未访问或修改本机环境。");
    },
    onCheck: async () => {
      await simulate("check", (current) => ({ ...current, scenario: current.scenario === "error" ? "ready" : current.scenario, environment: current.environment ? { ...current.environment, checkedAt: "刚刚 · 演示" } : null }));
      pushNotice("演示检查完成。真实接入后验证 Python、依赖与路径。");
    },
    onUpdate: async () => {
      await simulate("update", (current) => {
        const changes = current.request?.changes ?? [];
        const revision = (current.environment?.revision ?? 0) + 1;
        return { ...current, request: null, environment: current.environment ? { ...current.environment, revision, checkedAt: "刚刚 · 演示" } : null, packages: [...current.packages, ...changes.map((change): EnvironmentPackage => ({ name: change.name, version: "待后端解析", source: "pip", purpose: "实验申请依赖" }))], history: [{ id: String(Date.now()), title: `确认补充 ${changes.map((change) => change.name).join("、")}`, detail: "此为界面演示；真实安装前需要解析计划与兼容性。", revision, time: "刚刚" }, ...current.history] };
      });
      pushNotice("已演示依赖更新，未安装任何软件包。");
    },
    onRejectUpdate: () => { patch((current) => ({ ...current, request: null })); pushNotice("本次演示依赖申请已暂缓。共享环境保持不变。"); },
  };

  return <div className="pe-preview-shell"><aside className="sidebar pe-preview-sidebar">
    <div className="brand-row"><span className="brand-mark"><span /><span /><span /></span><strong className="brand-name">AutoResearch</strong><PanelLeftClose size={16} /></div>
    <div className="workspace-select pe-preview-workspace"><span className="workspace-avatar">研</span><span><strong>研究工作区</strong><small>本地课题 · 设计预览</small></span><ChevronRight size={13} /></div>
    <div className="side-section-head"><span>课题</span><span className="pe-project-count">2</span></div>
    <label className="pe-project-selector"><span className="project-dot" /><select aria-label="切换演示课题" value={projectKey} disabled={busy} onChange={(event) => { setProjectKey(event.target.value as ProjectKey); setNotice(""); }}>{Object.entries(projects).map(([key, item]) => <option key={key} value={key}>{item.title}</option>)}</select></label>
    <div className="side-divider" /><div className="side-section-head side-section-head--label">当前课题</div>
    <nav className="nav-list" aria-label="预览导航"><span className="nav-item pe-static-nav"><BookOpen size={16} /><span>课题概览</span></span><span className="nav-item pe-static-nav"><BookOpen size={16} /><span>文献分析</span></span><span className="nav-item pe-static-nav"><MessageSquareText size={16} /><span>研究讨论</span></span><span className="nav-item pe-static-nav"><Lightbulb size={16} /><span>Idea 池</span></span><button type="button" className={`nav-item ${page === "experiments" ? "is-active" : ""}`} onClick={() => setPage("experiments")}><FlaskConical size={16} /><span>实验复现</span></button><button type="button" className={`nav-item ${page === "environment" ? "is-active" : ""}`} onClick={() => setPage("environment")}><Leaf size={16} /><span>运行环境</span><span className="pe-new-label">新</span></button><span className="nav-item pe-static-nav"><FolderOpen size={16} /><span>课题文件</span></span></nav>
    <div className="pe-sidebar-settings"><Settings2 size={15} /><span>模型与数据设置</span><ArrowUpRight size={12} /></div><div className="sidebar-bottom"><span className="sidebar-version">AUTORESEARCH · 0.2.3</span><span className="pe-local-state"><i />本地预览</span></div>
  </aside><div className="pe-preview-main"><header className="pe-preview-topbar"><div><span>{project.title}</span><ChevronRight size={13} /><strong>{page === "environment" ? "运行环境" : "实验复现"}</strong></div><span><span className="pe-topbar-dot" />研究工作区</span></header>
    <div className="pe-demo-toolbar"><span><SlidersHorizontal size={13} /><strong>交互预览</strong><span>数据均为演示，不会创建环境或执行命令</span></span><div><label>切换状态<select aria-label="切换演示状态" value={state.scenario} disabled={busy} onChange={(event) => patch(() => sampleState(projectKey, event.target.value as EnvironmentScenario))}><option value="ready">已配置</option><option value="unconfigured">未配置</option><option value="running">实验运行中</option><option value="conda-missing">未找到 Conda</option><option value="error">环境异常</option></select></label><button type="button" title="重置当前课题的演示状态" aria-label="重置预览" disabled={busy} onClick={() => { patch(() => sampleState(projectKey)); pushNotice("当前课题的演示已重置。"); }}><RotateCcw size={13} /></button></div></div>
    <main className="pe-preview-scroll">{page === "environment" ? <ProjectEnvironmentView key={`${projectKey}:${state.scenario}`} controller={controller} /> : <ExperimentEntryPreview key={projectKey} controller={controller} onManage={() => setPage("environment")} />}</main><footer className="pe-preview-footer"><span><span className="pe-topbar-dot" />界面演示 · 使用模拟数据</span><span>课题 {project.title} · 环境独立配置</span></footer>
  </div>{notice && <div className="pe-toast" role="status"><Check size={15} /><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><XIcon /></button></div>}</div>;
}

function XIcon() { return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6m0-6-6 6" fill="none" stroke="currentColor" strokeLinecap="round" /></svg>; }

function ExperimentEntryPreview({ controller, onManage }: { controller: ProjectEnvironmentController; onManage: () => void }) {
  const [selected, setSelected] = useState(controller.experiments[0].id);
  const experiment = controller.experiments.find((item) => item.id === selected) ?? controller.experiments[0];
  return <div className="pe-experiment-preview"><header className="pe-page-heading"><div><p className="pe-eyebrow">课题 / {controller.projectTitle}</p><h1>实验复现</h1><p>环境随课题继承，切换实验无需重新配置。</p></div></header><ProjectEnvironmentStrip controller={controller} onManage={onManage} /><div className="pe-experiment-preview-select"><label>当前实验<select value={selected} onChange={(event) => setSelected(event.target.value)}>{controller.experiments.map((item) => <option key={item.id} value={item.id}>{item.title}（{item.id}）</option>)}</select></label><span>{experiment.kind}</span></div><section className="pe-preview-conversation"><div className="pe-preview-agent"><span><Terminal size={16} /></span><strong>Agent</strong><small>行为预览</small></div><h2>{controller.environment ? `使用课题环境 ${controller.environment.name}` : "先配置当前课题的 Python 环境"}</h2><p>{controller.environment ? "开始实验前，我会检查课题环境并使用指定的 Python。代码和结果保存在本实验目录，依赖安装交给课题环境统一管理。" : "这个课题尚未绑定环境。配置一次后，论文复现和自主实验都会自动使用，不会为每个实验重复创建。"}</p>{controller.environment ? <div className="pe-preview-command"><Leaf size={16} /><div><strong>Conda · Python {controller.environment.pythonVersion}</strong><code>{controller.environment.prefix}</code></div><span>v{controller.environment.revision}</span></div> : <button className="button button--primary pe-button" type="button" onClick={onManage}>配置课题环境<ChevronRight size={13} /></button>}<div className="pe-preview-agent-note"><CircleAlert size={14} />依赖不兼容时先报告；不会静默更新或另建环境。</div></section><p className="pe-preview-entry-caption">这里展示环境信息在实验页面中的入口位置，现有对话、任务卡和底部终端沿用当前设计。</p></div>;
}

createRoot(document.getElementById("root")!).render(<EnvironmentPreview />);
