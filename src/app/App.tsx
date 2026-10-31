import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Archive,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  Files,
  FlaskConical,
  FolderOpen,
  FolderPlus,
  Leaf,
  Lightbulb,
  LoaderCircle,
  MessageSquareText,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  SearchCheck,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import type { AnalysisDepth, CodexReasoningEffort, Discussion, ExperimentSummary, Idea, IdeaStatus, Message, ModelSettings, Paper, PaperAnalysisProgress, PaperRole, Project, ProjectFileNode, ResearchNote, SearchResult, View, WorkspaceSnapshot } from "../types";
import type { ProjectEnvironmentSnapshot } from "../screens/project-environment/model";
import { OverviewView } from "../screens/overview/OverviewView";
import { DiscussionView, type DiscussionSendInput } from "../screens/research-discussion/DiscussionView";
import { PaperAnalysisPage } from "../screens/paper-analysis/PaperAnalysisPage";
import { IdeaModal } from "../screens/idea-pool/IdeaModal";
import { IdeaPoolView } from "../screens/idea-pool/IdeaPoolView";
import { ExperimentView, type ExperimentIntent } from "../screens/experiments/ExperimentView";
import { ProjectEnvironmentPage } from "../screens/project-environment/ProjectEnvironmentView";
import { ResearchNotesView } from "../screens/research-notes/ResearchNotesView";
import { ProjectFilesView } from "../screens/project-files/ProjectFilesView";
import { IconButton, Modal } from "../components/Shared";
import { anyAnalysis, isLiveProgress, taskKeys } from "./tasks";
const PdfCitationViewer = lazy(() => import("../components/PdfCitationViewer"));

const viewTitles: Record<View, string> = {
  overview: "课题概览",
  papers: "文献分析",
  discussion: "研究讨论",
  ideas: "Idea 池",
  experiments: "实验复现",
  "project-environment": "运行环境",
  "paper-detail": "论文详情",
  notes: "研究笔记",
  files: "课题文件",
};

const reasoningEffortChoices: Array<{ value: CodexReasoningEffort; label: string }> = [
  { value: "minimal", label: "minimal · 最低" },
  { value: "low", label: "low · 低" },
  { value: "medium", label: "medium · 中" },
  { value: "high", label: "high · 高" },
  { value: "xhigh", label: "xhigh · 超高" },
  { value: "max", label: "max · 极高" },
  { value: "ultra", label: "ultra · Ultra" },
  { value: "persistent", label: "persistent · 持续" },
];

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const shortTitle = (title: string) => title.length > 32 ? `${title.slice(0, 32)}…` : title;
const progressKey = (projectId: string, paperId: string) => `${projectId}:${paperId}`;
const discussionKey = (projectId: string, discussionId: string | null) => `${projectId}:${discussionId ?? "new"}`;
const latestDiscussionId = (project: Project | null | undefined) => [...(project?.discussions ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null;

function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [view, setView] = useState<View>("overview");
  const [selectedPaperId, setSelectedPaperId] = useState("");
  // 研究讨论：当前讨论（null 是还没发送过的新讨论），以及各讨论里正在等回答的问题。
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(null);
  const [discussionPending, setDiscussionPending] = useState<Record<string, string>>({});
  // 概览、侧栏和文献页都要用到的实验与运行环境状态。
  const [experimentSummaries, setExperimentSummaries] = useState<ExperimentSummary[] | null>(null);
  const [environmentSnapshot, setEnvironmentSnapshot] = useState<ProjectEnvironmentSnapshot | null>(null);
  const [experimentIntent, setExperimentIntent] = useState<ExperimentIntent | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [settings, setSettings] = useState<ModelSettings>({ baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", providerMode: "auto", apiKeyConfigured: false });
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ideaDraft, setIdeaDraft] = useState<Partial<Idea> | null>(null);
  const [editingProject, setEditingProject] = useState(false);
  // 每个长时间操作单独记录，见 ./tasks.ts。taskRef 同步更新，用来挡住连续点击。
  const taskRef = useRef(new Set<string>());
  const [tasks, setTasks] = useState<ReadonlySet<string>>(() => new Set());
  const [toast, setToast] = useState("");
  const [question, setQuestion] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [projectFiles, setProjectFiles] = useState<ProjectFileNode[]>([]);
  const [projectFilesBusy, setProjectFilesBusy] = useState(false);
  const [showSystemFiles, setShowSystemFiles] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [pdfRequest, setPdfRequest] = useState<{ paper: Paper; page: number; quote?: string } | null>(null);
  // 按论文记录分析进度；最后收到进度的论文排在最后。
  const [paperProgress, setPaperProgress] = useState<Record<string, PaperAnalysisProgress>>({});

  const activeProject = snapshot?.projects.find((project) => project.id === activeProjectId) ?? null;
  const activeProjectRef = useRef(activeProjectId);
  activeProjectRef.current = activeProjectId;

  const startTask = (key: string) => {
    if (taskRef.current.has(key)) return false;
    taskRef.current.add(key);
    setTasks(new Set(taskRef.current));
    return true;
  };
  const endTask = (key: string) => {
    taskRef.current.delete(key);
    setTasks(new Set(taskRef.current));
  };
  const progressFor = (projectId: string, paperId: string) => paperProgress[progressKey(projectId, paperId)] ?? null;
  const latestProgress = (projectId: string) => Object.entries(paperProgress).filter(([key]) => key.startsWith(`${projectId}:`)).at(-1)?.[1] ?? null;
  const clearProgress = (projectId: string, paperId?: string) => setPaperProgress((current) => Object.fromEntries(Object.entries(current)
    .filter(([key]) => paperId ? key !== progressKey(projectId, paperId) : !key.startsWith(`${projectId}:`))));
  const papers = activeProject?.papers ?? [];
  const ideas = activeProject?.ideas ?? [];
  const visibleIdeas = useMemo(() => [...ideas].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [ideas]);
  const codexSdkReady = Boolean(settings.codexSdk?.cliAvailable && (settings.codexSdk.configAvailable || settings.codexSdk.authAvailable));
  const modelReady = settings.providerMode === "manual"
    ? Boolean(settings.apiKeyConfigured)
    : Boolean(codexSdkReady || settings.ccswitch?.routingAvailable || settings.ccswitch?.providerAvailable || settings.apiKeyConfigured);
  const modelSummary = settings.providerMode === "manual"
    ? `手动接口 · ${settings.model}`
    : codexSdkReady
      ? `Codex SDK · ${settings.ccswitch?.model || "当前模型"}`
      : settings.ccswitch?.routingAvailable
        ? `CC Switch · ${settings.ccswitch.model || settings.model}`
        : settings.ccswitch?.providerAvailable
          ? `Codex · ${settings.ccswitch.provider || "当前 provider"} · ${settings.ccswitch.model || settings.model}`
          : `备用接口 · ${settings.model}`;

  useEffect(() => {
    let mounted = true;
    Promise.all([window.autoresearch.loadWorkspace(), window.autoresearch.getSettings()]).then(([loaded, modelSettings]) => {
      if (!mounted) return;
      setSnapshot(loaded);
      setActiveProjectId(loaded.projects[0]?.id ?? "");
      setWorkspacePath(loaded.workspacePath);
      setSettings(modelSettings);
    }).catch((error) => { if (mounted) setToast(errorMessage(error)); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const stopAnalysis = window.autoresearch.onAnalysisProgress((progress) => setPaperProgress((current) => {
      const key = progressKey(progress.projectId, progress.paperId);
      return { ...Object.fromEntries(Object.entries(current).filter(([item]) => item !== key)), [key]: progress };
    }));
    const stopFileDrag = window.autoresearch.onProjectFileDragError(setToast);
    return () => { stopAnalysis(); stopFileDrag(); };
  }, []);

  useEffect(() => {
    if (!activeProjectId) {
      setProjectFiles([]);
      return;
    }
    let current = true;
    setProjectFilesBusy(true);
    window.autoresearch.listProjectFiles({ projectId: activeProjectId, showSystemFiles, path: "" })
      .then((files) => { if (current) setProjectFiles(files); })
      .catch((error) => { if (current) setToast(errorMessage(error)); })
      .finally(() => { if (current) setProjectFilesBusy(false); });
    return () => { current = false; };
  }, [activeProjectId, showSystemFiles]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener("autoresearch:settings", openSettings);
    return () => window.removeEventListener("autoresearch:settings", openSettings);
  }, []);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".search-wrap input")?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (!activeProject) return;
    setActiveDiscussionId(latestDiscussionId(activeProject));
    setExperimentIntent(null);
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) { setExperimentSummaries(null); setEnvironmentSnapshot(null); return; }
    let alive = true;
    setExperimentSummaries(null);
    setEnvironmentSnapshot(null);
    window.autoresearch.listExperiments(activeProjectId)
      .then((list) => { if (alive) setExperimentSummaries(list); })
      .catch(() => { if (alive) setExperimentSummaries([]); });
    const loadEnvironment = () => window.autoresearch.getProjectEnvironment(activeProjectId)
      .then((next) => { if (alive) setEnvironmentSnapshot(next); })
      .catch(() => {});
    void loadEnvironment();
    const stopExperiments = window.autoresearch.onExperimentUpdate((update) => {
      if (update.projectId !== activeProjectId) return;
      setExperimentSummaries((list) => {
        const current = list ?? [];
        return current.some((item) => item.id === update.experimentId)
          ? current.map((item) => item.id === update.experimentId ? update.summary : item)
          : [update.summary, ...current];
      });
    });
    const stopEnvironment = window.autoresearch.onProjectEnvironmentUpdate((projectId) => { if (projectId === activeProjectId) void loadEnvironment(); });
    return () => { alive = false; stopExperiments(); stopEnvironment(); };
  }, [activeProjectId]);

  const updateProjectInState = (next: Project) => {
    setSnapshot((current) => current ? {
      ...current,
      projects: [next, ...current.projects.filter((project) => project.id !== next.id)],
    } : current);
  };

  // 异步操作返回后，在最新的课题数据上修改，避免用发起时的旧数据覆盖期间的其他变化。
  const patchProject = (projectId: string, update: (project: Project) => Project) => {
    setSnapshot((current) => current ? {
      ...current,
      projects: current.projects.map((project) => project.id === projectId ? update(project) : project),
    } : current);
  };

  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!startTask(taskKeys.createProject)) return;
    try {
      const project = await window.autoresearch.createProject({ title: String(form.get("title")), direction: String(form.get("direction")) });
      updateProjectInState(project);
      setActiveProjectId(project.id);
      setView("overview");
      setCreateOpen(false);
      setToast("课题已创建");
    } catch (error) { setToast(errorMessage(error)); }
    finally { endTask(taskKeys.createProject); }
  };

  const saveProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeProject) return;
    const form = new FormData(event.currentTarget);
    if (!startTask(taskKeys.saveProject)) return;
    try {
      const project = await window.autoresearch.updateProject({ projectId: activeProject.id, title: String(form.get("title")), direction: String(form.get("direction")) });
      updateProjectInState(project);
      setEditingProject(false);
      setToast("课题信息已保存");
    } catch (error) { setToast(errorMessage(error)); }
    finally { endTask(taskKeys.saveProject); }
  };

  const importPapers = async () => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    const key = taskKeys.importPapers(projectId);
    if (!startTask(key)) return;
    try {
      const imported = await window.autoresearch.importPapers(projectId);
      if (imported.length) {
        const fresh = await window.autoresearch.loadWorkspace();
        setSnapshot(fresh);
        setToast(`已导入 ${imported.length} 篇文献`);
      }
    } catch (error) { setToast(errorMessage(error)); }
    finally { endTask(key); }
  };

  const refreshProjectFiles = async () => {
    if (!activeProject) return;
    setProjectFilesBusy(true);
    try {
      setProjectFiles(await window.autoresearch.listProjectFiles({ projectId: activeProject.id, showSystemFiles, path: "" }));
    } catch (error) { setToast(errorMessage(error)); }
    finally { setProjectFilesBusy(false); }
  };

  const loadProjectFileFolder = async (path: string): Promise<boolean> => {
    if (!activeProject) return false;
    setProjectFilesBusy(true);
    try {
      const children = await window.autoresearch.listProjectFiles({ projectId: activeProject.id, showSystemFiles, path });
      setProjectFiles((current) => {
        const replace = (nodes: ProjectFileNode[]): ProjectFileNode[] => nodes.map((node) => {
          if (node.path === path && node.kind === "directory") return { ...node, children, childrenLoaded: true };
          return node.kind === "directory" && node.children.length ? { ...node, children: replace(node.children) } : node;
        });
        return path ? replace(current) : children;
      });
      return true;
    } catch (error) {
      setToast(errorMessage(error));
      return false;
    } finally { setProjectFilesBusy(false); }
  };

  const importProjectFilesFromPicker = async (kind: "files" | "folder") => {
    if (!activeProject) return;
    setProjectFilesBusy(true);
    try {
      const imported = await window.autoresearch.chooseProjectFiles({ projectId: activeProject.id, kind });
      if (imported.length) setToast(`已导入 ${imported.length} 项`);
      setProjectFiles(await window.autoresearch.listProjectFiles({ projectId: activeProject.id, showSystemFiles, path: "" }));
    } catch (error) { setToast(errorMessage(error)); }
    finally { setProjectFilesBusy(false); }
  };

  const importDroppedProjectFiles = async (files: File[], targetPath: string) => {
    if (!activeProject || !files.length) return;
    const sourcePaths = files.flatMap((file) => {
      const [path] = window.autoresearch.getDroppedFilePaths([file]);
      return path ? [{ path, ...(file.webkitRelativePath ? { relativePath: file.webkitRelativePath } : {}) }] : [];
    });
    if (!sourcePaths.length) {
      setToast("无法读取拖入文件的路径");
      return;
    }
    setProjectFilesBusy(true);
    try {
      const imported = await window.autoresearch.importProjectFiles({ projectId: activeProject.id, sourcePaths, targetPath });
      setProjectFiles(await window.autoresearch.listProjectFiles({ projectId: activeProject.id, showSystemFiles, path: "" }));
      setToast(`已导入 ${imported.length} 项`);
    } catch (error) { setToast(errorMessage(error)); }
    finally { setProjectFilesBusy(false); }
  };

  // 分析可能要几分钟：开始和结束都不切换页面，进度显示在当前页面，结束时只给提示。
  const analyzePaper = async (paper: Paper) => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    const key = taskKeys.analyze(projectId, paper.id);
    if (taskRef.current.has(taskKeys.analyzeAll(projectId)) || !startTask(key)) return;
    try {
      const updated = await window.autoresearch.analyzePaper({ projectId, paperId: paper.id });
      patchProject(projectId, (project) => replacePaper(project, updated));
      setToast(`《${shortTitle(updated.title)}》的分析稿已生成，等待人工核对`);
    } catch (error) {
      const message = errorMessage(error);
      try { setSnapshot(await window.autoresearch.loadWorkspace()); }
      catch { /* Keep the original model error visible if refreshing also fails. */ }
      setToast(message);
    }
    finally { endTask(key); clearProgress(projectId, paper.id); }
  };

  const analyzeAllPapers = async () => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    const key = taskKeys.analyzeAll(projectId);
    if ([...taskRef.current].some((item) => item.startsWith(`analyze:${projectId}:`)) || !startTask(key)) return;
    try {
      await window.autoresearch.analyzeAllPapers(projectId);
      setSnapshot(await window.autoresearch.loadWorkspace());
      setToast("论文分析已完成");
    } catch (error) {
      const message = errorMessage(error);
      try { setSnapshot(await window.autoresearch.loadWorkspace()); } catch { /* Keep the original error visible. */ }
      setToast(message);
    }
    finally { endTask(key); clearProgress(projectId); }
  };

  const replacePaper = (project: Project, updated: Paper) => ({ ...project, papers: project.papers.map((item) => item.id === updated.id ? updated : item), updatedAt: new Date().toISOString() });

  const updatePaper = async (paper: Paper, payload: { role?: PaperRole; analysisDepth?: AnalysisDepth }) => {
    if (!activeProject) return;
    try {
      const projectId = activeProject.id;
      const updated = await window.autoresearch.updatePaper({ projectId, paperId: paper.id, ...payload });
      patchProject(projectId, (project) => replacePaper(project, updated));
      if (payload.role) setToast(payload.role === "atypical" ? "已设为非常规论文，重新分析时默认做简化分析" : "已设为核心论文");
    } catch (error) { setToast(errorMessage(error)); }
  };

  const updateResearchNote = async (noteId: string, patch: { paperId?: string | null; text?: string }) => {
    if (!activeProject) return;
    try {
      const projectId = activeProject.id;
      const saved = await window.autoresearch.updateResearchNote({ projectId, noteId, ...patch });
      patchProject(projectId, (project) => ({ ...project, notes: (project.notes ?? []).map((item) => item.id === saved.id ? saved : item), updatedAt: new Date().toISOString() }));
    } catch (error) { setToast(errorMessage(error)); }
  };

  const sendPaperAgentMessage = async (paperId: string, content: string) => {
    if (!activeProject) throw new Error("当前没有课题。");
    try {
      const result = await window.autoresearch.sendPaperAgentMessage({ projectId: activeProject.id, paperId, content });
      setSnapshot((current) => current ? {
        ...current,
        projects: current.projects.map((project) => project.id === activeProject.id
          ? { ...project, papers: project.papers.map((paper) => paper.id === result.paper.id ? result.paper : paper), updatedAt: new Date().toISOString() }
          : project),
      } : current);
      void window.autoresearch.listProjectFiles({ projectId: activeProject.id, showSystemFiles, path: "" })
        .then(setProjectFiles)
        .catch((error) => setToast(errorMessage(error)));
      return result;
    } catch (error) {
      try {
        const refreshed = await window.autoresearch.loadWorkspace();
        setSnapshot(refreshed);
      } catch { /* Keep the original Codex error visible. */ }
      setToast(errorMessage(error));
      throw error;
    }
  };

  const saveResearchNote = async (text: string, options: { fromMessageId?: string; paperId?: string } = {}): Promise<ResearchNote | null> => {
    if (!activeProject || !text.trim()) return null;
    setNoteBusy(true);
    try {
      const projectId = activeProject.id;
      const note = await window.autoresearch.saveResearchNote({ projectId, text, ...options });
      patchProject(projectId, (project) => ({ ...project, notes: [...(project.notes ?? []), note], updatedAt: new Date().toISOString() }));
      setToast("研究笔记已保存");
      return note;
    } catch (error) { setToast(errorMessage(error)); return null; }
    finally { setNoteBusy(false); }
  };

  const openPaper = async (paper: Paper, page = 1, quote?: string) => {
    if (!activeProject) return;
    setPdfRequest({ paper, page, quote });
  };

  // ---------- 跨页面跳转 ----------
  const openExperiment = (experimentId: string) => {
    setExperimentIntent({ nonce: Date.now(), experimentId });
    setView("experiments");
  };
  // 实验必须绑定一篇论文：带着论文和目标打开实验复现的新建弹窗，由研究者确认后创建。
  const startExperiment = (input: { paperId?: string; goal: string }) => {
    setExperimentIntent({ nonce: Date.now(), paperId: input.paperId, goal: input.goal });
    setView("experiments");
  };
  const reproducePaper = (paper: Paper) => startExperiment({ paperId: paper.id, goal: `复现《${paper.title}》的主要实验结果。` });
  const openDiscussion = (discussionId: string | null) => {
    setActiveDiscussionId(discussionId);
    setView("discussion");
  };
  const ideaFromMessage = (answer: Message, asked: Message | undefined) => {
    const sources = [...new Map((answer.sources ?? []).map((source) => [`${source.paperId}:${source.page}`, source])).values()];
    setIdeaDraft({
      status: "candidate",
      title: (asked?.content ?? answer.content).replace(/\s+/g, " ").trim().slice(0, 60),
      mechanism: answer.content.trim().slice(0, 1500),
      evidence: sources.map((source) => `${source.title} p.${source.page}`).join("\n"),
    });
  };

  const saveIdea = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeProject) return;
    const form = new FormData(event.currentTarget);
    const idea = {
      ...ideaDraft,
      title: String(form.get("title")),
      mechanism: String(form.get("mechanism")),
      difference: String(form.get("difference")),
      experiment: String(form.get("experiment")),
      evidence: String(form.get("evidence")),
      draft: String(form.get("draft")),
      status: String(form.get("status")) as IdeaStatus,
    };
    if (!startTask(taskKeys.saveIdea)) return;
    const projectId = activeProject.id;
    try {
      const saved = await window.autoresearch.saveIdea({ projectId, idea });
      patchProject(projectId, (project) => ({ ...project, ideas: project.ideas.some((item) => item.id === saved.id) ? project.ideas.map((item) => item.id === saved.id ? saved : item) : [saved, ...project.ideas], updatedAt: saved.updatedAt }));
      setIdeaDraft(null);
      setToast("Idea 已保存");
    } catch (error) { setToast(errorMessage(error)); }
    finally { endTask(taskKeys.saveIdea); }
  };

  const updateIdeaStatus = async (idea: Idea, status: IdeaStatus, reason = "") => {
    if (!activeProject) return;
    try {
      const projectId = activeProject.id;
      const saved = await window.autoresearch.updateIdea({ projectId, ideaId: idea.id, status, reason });
      patchProject(projectId, (project) => ({ ...project, ideas: project.ideas.map((item) => item.id === saved.id ? saved : item), updatedAt: saved.updatedAt }));
    } catch (error) { setToast(errorMessage(error)); }
  };

  const sendDiscussionMessage = async (input: DiscussionSendInput): Promise<Discussion | null> => {
    if (!activeProject) return null;
    const projectId = activeProject.id;
    const key = taskKeys.send(projectId, input.discussionId);
    if (!startTask(key)) return null;
    const pendingKey = discussionKey(projectId, input.discussionId);
    setDiscussionPending((current) => ({ ...current, [pendingKey]: input.content }));
    setQuestion("");
    try {
      const result = await window.autoresearch.sendMessage({ projectId, discussionId: input.discussionId, content: input.content, paperIds: input.paperIds, scope: input.scope });
      // 只更新讨论列表和论文的解析状态；分析稿等其他字段以界面上最新的为准。
      const statusById = new Map(result.papers.map((paper) => [paper.id, paper.status]));
      patchProject(projectId, (project) => ({
        ...project,
        discussions: result.discussions,
        papers: project.papers.map((paper) => statusById.has(paper.id) ? { ...paper, status: statusById.get(paper.id)! } : paper),
      }));
      if (!input.discussionId && activeProjectRef.current === projectId) setActiveDiscussionId(result.discussion.id);
      return result.discussion;
    } catch (error) {
      if (activeProjectRef.current === projectId) setQuestion((current) => current || input.content);
      setToast(errorMessage(error));
      return null;
    } finally {
      endTask(key);
      setDiscussionPending((current) => Object.fromEntries(Object.entries(current).filter(([item]) => item !== pendingKey)));
    }
  };

  const renameDiscussion = async (discussionId: string, title: string) => {
    if (!activeProject) return false;
    const projectId = activeProject.id;
    try {
      const result = await window.autoresearch.renameDiscussion({ projectId, discussionId, title });
      patchProject(projectId, (project) => ({ ...project, discussions: result.discussions }));
      return true;
    } catch (error) { setToast(errorMessage(error)); return false; }
  };

  const deleteDiscussion = async (discussionId: string) => {
    if (!activeProject) return false;
    const projectId = activeProject.id;
    try {
      const result = await window.autoresearch.deleteDiscussion({ projectId, discussionId });
      patchProject(projectId, (project) => ({ ...project, discussions: result.discussions }));
      if (activeProjectRef.current === projectId) setActiveDiscussionId(result.discussions[0]?.id ?? null);
      setToast("讨论已删除");
      return true;
    } catch (error) { setToast(errorMessage(error)); return false; }
  };

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSettingsBusy(true);
    setSettingsError("");
    try {
      const saved = await window.autoresearch.saveSettings({
        providerMode: String(form.get("providerMode")) as "auto" | "manual",
        baseUrl: String(form.get("baseUrl")),
        model: String(form.get("model")),
        apiKey: String(form.get("apiKey")),
        reasoningEffort: (String(form.get("reasoningEffort") || "") || undefined) as CodexReasoningEffort | undefined,
        autoAnalyzeOnImport: form.get("autoAnalyzeOnImport") === "on",
      });
      setSettings((current) => ({ ...current, ...saved }));
      setSettingsOpen(false);
      setToast("模型设置已保存");
    } catch (error) { setSettingsError(errorMessage(error)); }
    finally { setSettingsBusy(false); }
  };

  const testSettings = async (formElement: HTMLFormElement) => {
    const form = new FormData(formElement);
    setSettingsBusy(true);
    setSettingsError("");
    try {
      const saved = await window.autoresearch.saveSettings({
        providerMode: String(form.get("providerMode")) as "auto" | "manual",
        baseUrl: String(form.get("baseUrl")),
        model: String(form.get("model")),
        apiKey: String(form.get("apiKey")),
        reasoningEffort: (String(form.get("reasoningEffort") || "") || undefined) as CodexReasoningEffort | undefined,
        autoAnalyzeOnImport: form.get("autoAnalyzeOnImport") === "on",
      });
      setSettings((current) => ({ ...current, ...saved }));
      const refreshed = await window.autoresearch.getSettings();
      setSettings((current) => ({ ...current, ...refreshed }));
      const result = await window.autoresearch.testSettings(activeProjectId || undefined);
      setSettingsError(`连接正常 · ${result.source}`);
    } catch (error) { setSettingsError(errorMessage(error)); }
    finally { setSettingsBusy(false); }
  };

  const chooseWorkspace = async () => {
    setWorkspaceBusy(true);
    try {
      const fresh = await window.autoresearch.chooseWorkspace();
      if (!fresh) return;
      setSnapshot(fresh);
      setWorkspacePath(fresh.workspacePath);
      setActiveProjectId(fresh.projects[0]?.id ?? "");
      setToast("数据目录已切换；原目录数据保留不动");
    } catch (error) { setSettingsError(errorMessage(error)); }
    finally { setWorkspaceBusy(false); }
  };

  const searchWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!searchQuery.trim() || searchBusy) return;
    setSearchBusy(true);
    try {
      setSearchResults(await window.autoresearch.searchWorkspace(searchQuery.trim()));
      setSnapshot(await window.autoresearch.loadWorkspace());
      setSearchOpen(true);
    } catch (error) { setToast(errorMessage(error)); }
    finally { setSearchBusy(false); }
  };

  const selectSearchResult = async (result: SearchResult) => {
    setActiveProjectId(result.projectId);
    setSearchOpen(false);
    setSearchQuery("");
    if (result.type === "project") { setView("overview"); return; }
    if (result.type === "idea") { setView("ideas"); return; }
    setView(result.type === "evidence" && result.paperId ? "paper-detail" : "papers");
    if (result.paperId) setSelectedPaperId(result.paperId);
    if (result.type === "evidence" && result.paperId) {
      const paper = snapshot?.projects.find((project) => project.id === result.projectId)?.papers.find((item) => item.id === result.paperId);
      if (paper) openPaper(paper, result.page, result.excerpt);
    }
  };

  const openWorkspace = async () => {
    try { await window.autoresearch.openWorkspace(); }
    catch (error) { setToast(errorMessage(error)); }
  };

  const attentionCount = (experimentSummaries ?? []).filter((item) => item.status === "needs_input" || item.pendingJobs > 0).length;
  const experimentBadge = attentionCount
    ? <span className="nav-badge" title={`${attentionCount} 个实验等你处理`}>{attentionCount}</span>
    : (experimentSummaries ?? []).some((item) => item.status === "running") ? <span className="nav-live"><i />运行中</span> : undefined;
  const environmentRequest = environmentSnapshot?.request && (!environmentSnapshot.request.status || environmentSnapshot.request.status === "pending");
  const environmentBadge = !environmentSnapshot?.environment ? undefined
    : environmentRequest ? <span className="nav-dot nav-dot--amber" title="有依赖申请待核对" />
    : environmentSnapshot.error ? <span className="nav-dot nav-dot--red" title="环境需要检查" />
    : <span className="nav-dot" title="环境可用" />;

  if (!snapshot) return <main className="loading-screen"><LoaderCircle className="spin" size={20} />正在打开工作区</main>;

  return <div className={`app-shell ${sidebarCollapsed ? "is-collapsed" : ""} ${activeProject ? "" : "is-empty"} ${view === "files" ? "is-files-view" : ""} ${view === "experiments" ? "is-experiments-view" : ""} ${view === "project-environment" ? "is-environment-view" : ""}`}>
    <aside className="sidebar">
      <div className="brand-row"><div className="brand-mark"><span /><span /><span /></div><span className="brand-name">AutoResearch</span><IconButton label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} onClick={() => setSidebarCollapsed((value) => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</IconButton></div>
      <div className="side-section-head"><span>课题</span><IconButton label="新建课题" onClick={() => setCreateOpen(true)}><Plus size={16} /></IconButton></div>
      {snapshot.projects.length ? <div className="project-switcher">
        {snapshot.projects.map((project) => <button key={project.id} className={`project-row ${project.id === activeProjectId ? "is-active" : ""}`} onClick={() => { setActiveProjectId(project.id); setView("overview"); }}>
          <span className="project-dot" /> <span className="project-row-title">{project.title}</span>{project.id === activeProjectId && <ChevronRight size={14} />}
        </button>)}
      </div> : <div className="side-empty">暂无课题</div>}

      {activeProject && <>
        <div className="side-divider" />
        <div className="side-section-head side-section-head--label"><span>研究</span></div>
        <nav className="nav-list" aria-label="研究">
          <NavItem active={view === "overview"} icon={<FolderOpen size={17} />} label="课题概览" onClick={() => setView("overview")} />
          <NavItem active={["papers", "paper-detail"].includes(view)} icon={<BookOpen size={17} />} label="文献分析" count={papers.length} badge={anyAnalysis(tasks, activeProject.id) || isLiveProgress(latestProgress(activeProject.id)) ? <span className="nav-live"><i />分析中</span> : undefined} onClick={() => setView("papers")} />
          <NavItem active={view === "discussion"} icon={<MessageSquareText size={17} />} label="研究讨论" count={(activeProject.discussions ?? []).length || undefined} onClick={() => setView("discussion")} />
          <NavItem active={view === "ideas"} icon={<Lightbulb size={17} />} label="Idea 池" count={ideas.length} onClick={() => setView("ideas")} />
          <NavItem active={view === "notes"} icon={<NotebookPen size={17} />} label="研究笔记" count={(activeProject.notes ?? []).length} onClick={() => setView("notes")} />
          <NavItem active={view === "files"} icon={<Files size={17} />} label="课题文件" onClick={() => setView("files")} />
        </nav>
        <div className="side-section-head side-section-head--label"><span>实验</span></div>
        <nav className="nav-list" aria-label="实验">
          <NavItem active={view === "experiments"} icon={<FlaskConical size={17} />} label="实验复现" badge={experimentBadge} onClick={() => setView("experiments")} />
          <NavItem active={view === "project-environment"} icon={<Leaf size={17} />} label="运行环境" badge={environmentBadge} onClick={() => setView("project-environment")} />
        </nav>
        <div className="side-divider" />
        <button className="side-folder" title={modelReady ? `当前模型：${modelSummary}` : "模型还没有配置好"} onClick={() => setSettingsOpen(true)}><Settings2 size={16} /><span>模型与数据设置</span><span className={`connection-dot ${modelReady ? "is-on" : ""}`} /></button>
        <button className="side-folder" onClick={openWorkspace} title={workspacePath}><FolderOpen size={16} /><span>打开数据目录</span><ArrowUpRight size={14} /></button>
      </>}
      <div className="sidebar-bottom"><span className="sidebar-version">AUTORESEARCH · {__APP_VERSION__}</span><span className="local-badge"><span />本地工作区</span></div>
    </aside>

    <main className="main-column">
      <header className="topbar">
        <div className="breadcrumbs"><span>{activeProject?.title ?? "研究工作区"}</span>{activeProject && <><ChevronRight size={14} /><strong>{viewTitles[view]}</strong></>}</div>
        <div className="topbar-actions"><form className="search-wrap" onSubmit={searchWorkspace}><Search size={15} /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} aria-label="搜索课题内容" placeholder="搜索文献、Idea、原文" />{searchBusy ? <LoaderCircle size={13} className="spin" /> : <kbd className="search-kbd">Ctrl K</kbd>}</form>
        </div>
      </header>

      {!activeProject ? <WelcomeState onCreate={() => setCreateOpen(true)} /> : <div className="content-scroll">
        {view === "overview" && <OverviewView
          project={activeProject}
          ideas={visibleIdeas}
          experiments={experimentSummaries}
          environment={environmentSnapshot}
          tasks={tasks}
          progress={latestProgress(activeProject.id)}
          onEdit={() => setEditingProject(true)}
          onView={setView}
          onImport={importPapers}
          onAnalyze={analyzePaper}
          onOpenExperiment={openExperiment}
          onOpenDiscussion={openDiscussion}
          onEditIdea={setIdeaDraft}
        />}
        {["papers", "paper-detail"].includes(view) && <PaperAnalysisPage
          project={activeProject}
          view={view}
          selectedPaperId={selectedPaperId}
          tasks={tasks}
          progressFor={(paperId) => progressFor(activeProject.id, paperId)}
          experiments={experimentSummaries}
          onView={setView}
          onSelectPaper={setSelectedPaperId}
          onImport={importPapers}
          onAnalyze={analyzePaper}
          onAnalyzeAll={analyzeAllPapers}
          onOpenPaper={openPaper}
          onOpenExternal={(paper) => void window.autoresearch.openPaper({ projectId: activeProject.id, paperId: paper.id }).catch((error) => setToast(errorMessage(error)))}
          onUpdatePaper={updatePaper}
          onReproduce={reproducePaper}
          onOpenExperiment={openExperiment}
          onAgentMessage={sendPaperAgentMessage}
          onPaperChange={(next) => patchProject(activeProject.id, (project) => replacePaper(project, next))}
          onSaveNote={saveResearchNote}
        />}
        {view === "discussion" && <DiscussionView
          key={activeProject.id}
          project={activeProject}
          activeId={activeDiscussionId}
          onSelect={setActiveDiscussionId}
          question={question}
          setQuestion={setQuestion}
          pending={discussionPending[discussionKey(activeProject.id, activeDiscussionId)] ?? null}
          sending={tasks.has(taskKeys.send(activeProject.id, activeDiscussionId))}
          onSend={sendDiscussionMessage}
          onRename={renameDiscussion}
          onDelete={deleteDiscussion}
          onOpenPaper={openPaper}
          onSaveNote={saveResearchNote}
          onSaveIdea={ideaFromMessage}
          onBuildExperiment={startExperiment}
        />}
        {view === "ideas" && <IdeaPoolView ideas={visibleIdeas} onEdit={setIdeaDraft} onStatus={updateIdeaStatus} />}
        {view === "experiments" && <ExperimentView key={activeProject.id} project={activeProject} intent={experimentIntent} />}
        {view === "project-environment" && <ProjectEnvironmentPage key={activeProject.id} project={activeProject} />}
        {view === "notes" && <ResearchNotesView project={activeProject} busy={noteBusy} onSave={saveResearchNote} onUpdate={updateResearchNote} />}
        {view === "files" && <ProjectFilesView
          files={projectFiles}
          busy={projectFilesBusy}
          showSystemFiles={showSystemFiles}
          onShowSystemFilesChange={setShowSystemFiles}
          query={fileQuery}
          onQueryChange={setFileQuery}
          onImportFiles={() => void importProjectFilesFromPicker("files")}
          onImportFolder={() => void importProjectFilesFromPicker("folder")}
          onOpenRoot={() => void window.autoresearch.openProjectFolder(activeProject.id).catch((error) => setToast(errorMessage(error)))}
          onRefresh={() => void refreshProjectFiles()}
          onLoadFolder={loadProjectFileFolder}
          onDrop={(files, targetPath) => void importDroppedProjectFiles(files, targetPath)}
          onDragOut={(path) => window.autoresearch.startProjectFileDrag({ projectId: activeProject.id, path })}
          onOpenFile={(path) => void window.autoresearch.openProjectFile({ projectId: activeProject.id, path }).catch((error) => setToast(errorMessage(error)))}
        />}
      </div>}
    </main>

    {createOpen && <Modal title="新建研究课题" onClose={() => setCreateOpen(false)}><form className="form-stack" onSubmit={createProject}><label>课题名称<input name="title" autoFocus placeholder="例如：增量 BPE 的缓存优化" maxLength={100} required /></label><label>研究方向<textarea name="direction" rows={5} placeholder="写下研究问题、目标和已有条件" maxLength={5000} /></label><div className="modal-actions"><button type="button" className="button" onClick={() => setCreateOpen(false)}>取消</button><button className="button button--primary" disabled={tasks.has(taskKeys.createProject)}>{tasks.has(taskKeys.createProject) ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建课题</button></div></form></Modal>}
    {searchOpen && <Modal title={`搜索结果 · ${searchQuery}`} onClose={() => setSearchOpen(false)} size="wide"><div className="search-results">{searchResults.length ? searchResults.map((result, index) => <button className="search-result" key={`${result.type}-${result.projectId}-${result.paperId ?? result.ideaId ?? index}-${result.page ?? ""}`} onClick={() => void selectSearchResult(result)}><span className="search-result-icon">{result.type === "evidence" ? <SearchCheck size={15} /> : result.type === "idea" ? <Lightbulb size={15} /> : result.type === "paper" ? <BookOpen size={15} /> : <FolderOpen size={15} />}</span><span className="search-result-copy"><span><strong>{result.title}</strong><small>{result.projectTitle}{result.page ? ` · p. ${result.page}` : ""}</small></span><p>{result.excerpt}</p></span><ArrowUpRight size={14} /></button>) : <div className="search-no-results">没有匹配结果</div>}</div></Modal>}
    {editingProject && activeProject && <Modal title="编辑课题" onClose={() => setEditingProject(false)}><form className="form-stack" onSubmit={saveProject}><label>课题名称<input name="title" defaultValue={activeProject.title} maxLength={100} required /></label><label>研究方向<textarea name="direction" defaultValue={activeProject.direction} rows={6} maxLength={5000} /></label><div className="modal-actions"><button type="button" className="button" onClick={() => setEditingProject(false)}>取消</button><button className="button button--primary" disabled={tasks.has(taskKeys.saveProject)}><Check size={15} />保存更改</button></div></form></Modal>}
    {ideaDraft && <IdeaModal idea={ideaDraft} onClose={() => setIdeaDraft(null)} onSubmit={saveIdea} busy={tasks.has(taskKeys.saveIdea)} />}
    {settingsOpen && <SettingsModal settings={settings} workspacePath={workspacePath} onChooseWorkspace={chooseWorkspace} workspaceBusy={workspaceBusy} onClose={() => setSettingsOpen(false)} onSave={saveSettings} onTest={testSettings} busy={settingsBusy} status={settingsError} />}
    {pdfRequest && activeProject && <Suspense fallback={<div className="pdf-viewer-backdrop"><div className="pdf-loading"><LoaderCircle className="spin" size={18} />正在打开原文</div></div>}><PdfCitationViewer projectId={activeProject.id} paper={pdfRequest.paper} page={pdfRequest.page} quote={pdfRequest.quote} onClose={() => setPdfRequest(null)} /></Suspense>}
    {toast && <div className="toast" role="status"><span>{toast}</span><IconButton label="关闭通知" onClick={() => setToast("")}><X size={14} /></IconButton></div>}
  </div>;
}

function NavItem({ active, icon, label, count, badge, onClick }: { active: boolean; icon: ReactNode; label: string; count?: number; badge?: ReactNode; onClick: () => void }) {
  return <button className={`nav-item ${active ? "is-active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}>{icon}<span>{label}</span>{badge ?? (typeof count === "number" && <small>{count}</small>)}</button>;
}

function WelcomeState({ onCreate }: { onCreate: () => void }) {
  return <div className="welcome-state"><div className="welcome-mark"><BookOpen size={26} /></div><span className="eyebrow">AUTORESEARCH WORKSPACE</span><h1>建立一个研究课题</h1><button className="button button--primary" onClick={onCreate}><FolderPlus size={16} />新建课题</button></div>;
}

function SettingsModal({ settings, workspacePath, onChooseWorkspace, workspaceBusy, onClose, onSave, onTest, busy, status }: { settings: ModelSettings; workspacePath: string; onChooseWorkspace: () => void; workspaceBusy: boolean; onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void; onTest: (form: HTMLFormElement) => void; busy: boolean; status: string }) {
  const [providerMode, setProviderMode] = useState<"auto" | "manual">(settings.providerMode ?? "auto");
  const [autoAnalyzeOnImport, setAutoAnalyzeOnImport] = useState(settings.autoAnalyzeOnImport !== false);
  const [reasoningEffort, setReasoningEffort] = useState(settings.reasoningEffort ?? "");
  const codexSdkReady = Boolean(settings.codexSdk?.cliAvailable && (settings.codexSdk.configAvailable || settings.codexSdk.authAvailable));
  const ccswitchReady = Boolean(codexSdkReady || settings.ccswitch?.routingAvailable || settings.ccswitch?.providerAvailable);
  const routeText = codexSdkReady
    ? `已检测到 Codex CLI，将使用官方 SDK · ${settings.ccswitch?.model || "当前模型"}`
    : settings.codexSdk?.cliAvailable
      ? "已找到 Codex CLI，但尚未发现 Codex 配置或认证；请先登录 Codex 或配置 CC Switch。"
      : settings.ccswitch?.error
    ? settings.ccswitch.error
    : settings.ccswitch?.routingAvailable
      ? `Routing 正在运行 · ${settings.ccswitch?.model || "Codex 当前模型"}`
      : settings.ccswitch?.providerAvailable
        ? `当前 Codex provider「${settings.ccswitch.provider}」已配置，将直接使用 ${settings.ccswitch.model || "当前模型"}`
        : settings.ccswitch?.providerReason || settings.ccswitch?.routingReason || "未检测到可用的 Codex provider，将使用手动备用接口";
  return <Modal title="模型与数据设置" onClose={onClose} size="wide"><form className="form-stack settings-form" onSubmit={onSave}>
    <section className="settings-section"><div className="settings-section-title"><FolderOpen size={15} /><strong>研究数据目录</strong></div><div className="workspace-path-control"><div className="workspace-path" title={workspacePath}>{workspacePath}</div><button type="button" className="button button--small" disabled={workspaceBusy} onClick={onChooseWorkspace}>{workspaceBusy ? <LoaderCircle className="spin" size={14} /> : <FolderOpen size={14} />}选择目录</button></div><p className="settings-help">切换后会打开所选目录中的课题；原目录的数据会保留，不会自动搬移。</p></section>
    <section className="settings-section"><label className="settings-toggle"><input type="checkbox" name="autoAnalyzeOnImport" checked={autoAnalyzeOnImport} onChange={(event) => setAutoAnalyzeOnImport(event.target.checked)} /><span><strong>导入 PDF 后自动分析</strong><small>解析成功的论文会自动生成带读讲解稿和核对材料；关闭后可在文献列表手动启动。</small></span></label></section>
    <section className="settings-section"><div className="settings-section-title"><Sparkles size={15} /><strong>模型来源</strong></div><input type="hidden" name="providerMode" value={providerMode} /><div className="settings-mode-switch" role="group" aria-label="模型来源"><button type="button" className={providerMode === "auto" ? "is-active" : ""} aria-pressed={providerMode === "auto"} onClick={() => setProviderMode("auto")}>自动使用当前 Codex</button><button type="button" className={providerMode === "manual" ? "is-active" : ""} aria-pressed={providerMode === "manual"} onClick={() => setProviderMode("manual")}>手动兼容接口</button></div>{providerMode === "auto" && <div className={`ccswitch-status ${ccswitchReady ? "is-ready" : ""}`}><span className={`connection-dot ${ccswitchReady ? "is-on" : ""}`} /><span>{routeText}</span></div>}<p className="settings-help">自动模式优先使用本机 Codex CLI；CLI 不可用或连接失败时，依次尝试 CC Switch Routing、当前 Codex provider 和手动备用接口。论文分析和研究讨论只调用模型；论文页 Codex 和实验复现可以读写数据目录、联网，遇到需要你决定的事会先弹出问题。</p>
    </section>
    <section className="settings-section"><div className="settings-section-title"><Sparkles size={15} /><strong>思考强度</strong></div><label className="effort-setting" htmlFor="reasoning-effort"><span><small>设定 AutoResearch 请求的分析强度；可用档位取决于当前模型。</small></span><select id="reasoning-effort" name="reasoningEffort" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}><option value="">沿用模型默认值</option>{reasoningEffortChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label><p className="settings-help">较高强度通常需要更多等待时间和 token。选择后点击“保存”生效。</p></section>
    <details className="manual-settings" open={providerMode === "manual"}><summary>手动兼容接口与备用配置</summary><div className="form-stack"><label>兼容接口地址<input name="baseUrl" defaultValue={settings.baseUrl} placeholder="https://api.openai.com/v1" required /></label><label>模型名称<input name="model" defaultValue={settings.model} placeholder="gpt-4.1-mini" required /></label><label>API 密钥<input name="apiKey" type="password" autoComplete="new-password" placeholder={settings.apiKeyConfigured ? "已保存，留空保持不变" : "sk-..."} /></label><div className="secure-note"><Archive size={15} /><span>密钥使用 Windows 系统凭据加密后保存在本机，不会发送给 CC Switch。</span></div></div></details>
    {status && <div className={`settings-status ${status.startsWith("连接正常") ? "is-success" : ""}`}>{status}</div>}<div className="modal-actions modal-actions--split"><button type="button" className="button" disabled={busy} onClick={(event) => { const form = event.currentTarget.form; if (form) onTest(form); }}>{busy ? <LoaderCircle className="spin" size={15} /> : <CircleAlert size={15} />}测试连接</button><div><button type="button" className="button" onClick={onClose}>取消</button><button className="button button--primary" disabled={busy}><Check size={15} />保存</button></div></div>
  </form></Modal>;
}

export default App;

