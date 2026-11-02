export type PaperStatus = "parsed" | "needs_review" | "parse_failed" | "parsing" | "stale";
export type AnalysisStatus = "none" | "running" | "complete" | "stale" | "failed";
export type IdeaStatus = "candidate" | "continue" | "parked" | "rejected";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent";
export type View = "overview" | "papers" | "paper-detail" | "discussion" | "ideas" | "experiments" | "project-environment" | "notes" | "files";

export type PaperAnalysisStepStage = "prepare" | "read" | "synthesize" | "verify";
export type PaperAnalysisStepStatus = "running" | "complete" | "failed";

export interface PaperAnalysisInputChunk {
  chunkId: string;
  page?: number;
  section?: string;
  preview: string;
  truncated?: boolean;
}

export interface PaperAnalysisAiCall {
  id: string;
  label: string;
  status: "running" | "complete" | "failed";
  startedAt: string;
  finishedAt?: string;
  source?: string;
  error?: string;
}

export interface PaperAnalysisCallLog extends PaperAnalysisAiCall {
  paperId: string;
  stepId: string;
  request: { messages: Array<{ role: string; content: string }> };
  rawResponse: string;
}

export interface PaperAnalysisStep {
  id: string;
  stage: PaperAnalysisStepStage;
  title: string;
  status: PaperAnalysisStepStatus;
  inputSummary: string;
  outputSummary?: string;
  chunkIds?: string[];
  inputChunks?: PaperAnalysisInputChunk[];
  aiCalls?: PaperAnalysisAiCall[];
}

export interface PaperAnalysisTrace {
  status: "running" | "complete" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  steps: PaperAnalysisStep[];
}

export interface PaperAnalysisCheckpoint {
  sourceSha256: string;
  depth: AnalysisDepth;
  updatedAt: string;
  batchCount?: number;
  batches?: Record<string, string>;
  readMode?: "full-text";
  expectedParts?: string[];
  fullTextParts?: Record<string, Record<string, unknown>>;
}

export interface PaperAnalysisProgress {
  projectId: string;
  paperId: string;
  current: number;
  total: number;
  section: string;
  trace: PaperAnalysisTrace;
}

/**
 * 研究者笔记，可关联到具体论文。
 */
export interface ResearchNote {
  id: string;
  text: string;
  createdAt: string;
  fromMessageId?: string;
  paperId?: string;
  materialId?: string;
}

/** core = 领域内的核心论文；atypical = 少量“不太会放在一起读”的非常规论文 */
export type PaperRole = "core" | "atypical";
/** full = 完整通读讲解稿；light = 缩短版讲解稿，适合非常规论文 */
export type AnalysisDepth = "full" | "light";

export interface Paper {
  id: string;
  title: string;
  filename: string;
  importedAt: string;
  sourceSha256: string;
  pageCount: number;
  chunkCount: number;
  status: PaperStatus;
  analysisScript?: string;
  analysisSourceSha256?: string;
  analysisStatus?: AnalysisStatus;
  analysisUpdatedAt?: string;
  analysisTrace?: PaperAnalysisTrace;
  analysisCheckpoint?: PaperAnalysisCheckpoint;
  error?: string;
  /** [v2] 缺省视为 core */
  role?: PaperRole;
  /** [v2] 缺省时 core 为 full，atypical 为 light */
  analysisDepth?: AnalysisDepth;
  agentThreadId?: string;
  agentMessages?: PaperAgentMessage[];
}

export interface PaperAgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface Idea {
  id: string;
  title: string;
  mechanism: string;
  difference: string;
  experiment: string;
  evidence: string;
  status: IdeaStatus;
  draft?: string;
  pipelineSource?: string;
  rejectedReason?: string;
  /** 设计实验的基线：一个论文复现实验 */
  baselineId?: string | null;
  /** 设计实验关联的论文（没有基线时至少一篇） */
  paperIds?: string[];
  /** 由这个设想开始的设计实验 */
  experimentIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceSource {
  paperId: string;
  title: string;
  page: number;
  chunkId: string;
  excerpt: string;
  verified?: boolean;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  sources: EvidenceSource[];
  scope?: "snippets" | "analysis" | "all";
}

export interface Project {
  id: string;
  title: string;
  direction: string;
  createdAt: string;
  updatedAt: string;
  papers: Paper[];
  ideas: Idea[];
  /** 研究讨论列表（每个讨论单独存储，消息按需读取） */
  discussions?: DiscussionSummary[];
  /** 旧版的单条对话；新版本迁移到 discussions 后不再返回 */
  messages?: Message[];
  notes?: ResearchNote[];
}

export type DiscussionScope = "snippets" | "analysis";

export interface DiscussionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** 最后一条消息的开头 */
  preview: string;
}

export interface Discussion {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 上次使用的引用范围；null 表示还没发过消息 */
  paperIds: string[] | null;
  scope: DiscussionScope;
  messages: Message[];
}

/** 实验复现：一个实验 = 一个工作目录 + 一个持续的 agent 会话。 */
export interface ExperimentSettings {
  /** agent 沙箱是否允许联网（后台任务不受影响） */
  network: boolean;
  /** 后台任务开始前是否需要研究者确认 */
  approveJobs: boolean;
  /** 持续接续：任务结束后自动把结果交给 agent 继续 */
  continuous?: boolean;
  /** 设计实验的预算；用完后后台任务需要研究者确认才运行 */
  budget?: ExperimentBudget;
}

export interface ExperimentBudget {
  maxJobs: number | null;
  maxHours: number | null;
}

export type ExperimentVerdict = "supported" | "refuted" | "inconclusive";

export interface ExperimentOutcome {
  verdict: ExperimentVerdict;
  summary: string;
  at: string;
}

/** 设计实验当前代码相对基线的改动 */
export interface ExperimentDiff {
  available: boolean;
  reason?: string;
  base?: string;
  head?: string;
  files?: Array<{ path: string; added: number | null; removed: number | null }>;
  patch?: string;
  truncated?: boolean;
}

export interface ExperimentQuestionOption {
  label: string;
  description?: string;
}

export interface ExperimentQuestionItem {
  id: string;
  header: string;
  question: string;
  options: ExperimentQuestionOption[];
  isOther: boolean;
}

export interface ExperimentQuestionRequest {
  requestId: string;
  createdAt: string;
  questions: ExperimentQuestionItem[];
}

/** Codex 需要研究者决定时提出的问题；实验复现和论文页 Codex 共用。 */
export type AgentQuestionRequest = ExperimentQuestionRequest;

/** 论文页 Codex 当前这一轮的状态。 */
export interface PaperAgentState {
  projectId: string;
  paperId: string;
  running: boolean;
  startedAt: string | null;
  pendingQuestion: AgentQuestionRequest | null;
}

export interface Experiment {
  id: string;
  projectId: string;
  /** 旧数据没有这个字段，按论文复现处理 */
  kind?: "reproduction" | "designed";
  title: string;
  ideaId?: string | null;
  ideaTitle?: string | null;
  baselineId?: string | null;
  baselineTitle?: string | null;
  paperIds?: string[];
  /** 设计实验是否有本地 Git 版本记录 */
  git?: boolean;
  outcome?: ExperimentOutcome | null;
  paperId: string;
  paperTitle: string;
  goal: string;
  code: string;
  settings: ExperimentSettings;
  threadId: string | null;
  agent: "idle" | "working" | "waiting";
  activity: string;
  error: string | null;
  pendingQuestion?: ExperimentQuestionRequest | null;
  /** A submitted answer preserved until the interrupted turn resumes successfully. */
  pendingContinuation?: string | null;
  /** 还没送达 agent 的平台通知 */
  notices: Array<{ text: string; wake: boolean }>;
  turns: number;
  createdAt: string;
  updatedAt: string;
  conversations: ExperimentConversation[];
}

export interface ExperimentConversation {
  id: string;
  title: string;
  threadId: string | null;
  agent: "idle" | "working" | "waiting";
  activity: string;
  error: string | null;
  pendingQuestion: ExperimentQuestionRequest | null;
  pendingContinuation: string | null;
  notices: Array<{ text: string; wake: boolean; progress?: boolean }>;
  turns: number;
  createdAt: string;
  updatedAt: string;
}

export type ExperimentEventType = "user" | "agent" | "system" | "error" | "command" | "file" | "tool" | "job";

export interface ExperimentEvent {
  id: string;
  at: string;
  type: ExperimentEventType;
  text?: string;
  command?: string;
  exitCode?: number | null;
  status?: string;
  output?: string;
  changes?: Array<{ path: string; kind: string }>;
  jobId?: string;
  conversationId?: string;
}

export type ExperimentJobStatus = "pending" | "running" | "done" | "failed" | "rejected" | "stopped" | "lost";

export interface ExperimentJob {
  id: string;
  name: string;
  command: string;
  cwd: string;
  note: string;
  status: ExperimentJobStatus;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode: number | null;
  /** 相对实验工作目录的日志路径 */
  log: string;
  /** 日志最后一行有内容的文字（进度条只取最后一次刷新），运行中约每 3 秒更新 */
  lastLine?: string;
  /** user：研究者在终端面板里手动运行的命令 */
  origin?: "user";
  /** 手动命令结束后是否把结果交给 agent */
  notify?: boolean;
  /** 设计实验：任务启动前平台提交的代码版本 */
  codeVersion?: string | null;
  /** 任务日志已删除；任务摘要和预算记录仍保留 */
  outputDeleted?: boolean;
  conversationId?: string;
}

/** agent 正在执行的短命令 */
export interface ExperimentLiveCommand {
  id: string;
  command: string;
  startedAt: string;
  output: string;
}

export interface ExperimentLogChunk {
  bytes: Uint8Array;
  /** 这次读取的起始字节 */
  from: number;
  /** 下次读取应传入的偏移 */
  next: number;
  size: number;
  /** 首次读取时跳过的开头字节数（只读最后 512KB） */
  skipped: number;
  /** 日志比上次读到的位置还短，已从头重新读取 */
  reset: boolean;
  status: ExperimentJobStatus;
}

export interface ExperimentSummary {
  id: string;
  title: string;
  type?: "reproduction" | "designed";
  /** 显示用：论文复现 / 设计实验 */
  kind?: string;
  ideaId?: string | null;
  ideaTitle?: string | null;
  baselineId?: string | null;
  outcome?: ExperimentVerdict | null;
  paperId: string;
  paperTitle: string;
  agent: Experiment["agent"];
  activity: string;
  error: string | null;
  status?: "running" | "waiting" | "needs_input" | "idle";
  pendingJobs: number;
  runningJobs: number;
  updatedAt: string;
  conversations?: ExperimentConversation[];
  conversationCount?: number;
  activeConversations?: number;
}

export interface ExperimentSnapshot {
  experiment: Experiment;
  events: ExperimentEvent[];
  jobs: ExperimentJob[];
  /** 工作目录里 REPRO.md 的内容 */
  record: string;
  live?: ExperimentLiveCommand | null;
  liveConversationId?: string | null;
}

export interface ExperimentUpdate {
  projectId: string;
  experimentId: string;
  summary: ExperimentSummary;
  experiment?: Experiment;
  events?: ExperimentEvent[];
  jobs?: ExperimentJob[];
  record?: string;
  live?: ExperimentLiveCommand | null;
  liveConversationId?: string | null;
}

export interface ExperimentFileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  children?: ExperimentFileNode[];
  /** 目录内容没有列出（太深或是虚拟环境、缓存等大目录） */
  collapsed?: boolean;
}

export interface WorkspaceSnapshot {
  projects: Project[];
  workspacePath: string;
}

export interface ProjectFileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
  children: ProjectFileNode[];
  childrenLoaded?: boolean;
}

export interface SearchResult {
  type: "project" | "paper" | "idea" | "evidence";
  projectId: string;
  projectTitle: string;
  paperId?: string;
  ideaId?: string;
  title: string;
  excerpt: string;
  page?: number;
  chunkId?: string;
}

/** 通用设置；模型和服务商见 LlmState。 */
export interface ModelSettings {
  reasoningEffort?: CodexReasoningEffort;
  workspacePath?: string;
  autoAnalyzeOnImport?: boolean;
}

export type LlmProtocol = "chat" | "responses";
/** "codex" 表示跟随本机 Codex / CC Switch 的当前配置。 */
export const CODEX_PROVIDER_ID = "codex";

export interface LlmPreset {
  id: string;
  name: string;
  baseUrl: string;
  protocols: LlmProtocol[];
  models: string[];
  help: string;
}

export interface LlmProvider {
  id: string;
  name: string;
  preset: string;
  baseUrl: string;
  protocols: LlmProtocol[];
  models: string[];
  hasKey: boolean;
}

export interface LlmSelection {
  providerId: string;
  model: string;
}

export interface LlmState {
  presets: LlmPreset[];
  providers: LlmProvider[];
  /** 论文分析、研究讨论 */
  active: LlmSelection;
  /** 论文 Codex、实验复现 */
  agent: LlmSelection;
  codex: {
    model: string;
    provider: string;
    route: "routing" | "provider" | "cli" | "";
    available: boolean;
    cliAvailable: boolean;
    agentAvailable: boolean;
    reason: string;
  };
}

export interface LlmProviderDraft {
  id?: string;
  name: string;
  preset: string;
  baseUrl: string;
  protocols: LlmProtocol[];
  models: string[];
  /** 留空表示不修改已保存的密钥 */
  apiKey?: string;
  clearKey?: boolean;
}

export interface DesktopBridge {
  listExperiments(projectId: string): Promise<ExperimentSummary[]>;
  getExperiment(projectId: string, experimentId: string): Promise<ExperimentSnapshot>;
  createExperiment(projectId: string, input:
    | { kind?: "reproduction"; paperId: string; goal: string; code?: string; title?: string; settings?: Partial<ExperimentSettings> }
    | { kind: "designed"; ideaId: string; baselineId?: string | null; paperIds?: string[]; goal?: string; title?: string; settings?: Partial<ExperimentSettings> }): Promise<ExperimentSnapshot>;
  createExperimentConversation(projectId: string, experimentId: string, title?: string): Promise<ExperimentConversation>;
  renameExperimentConversation(projectId: string, experimentId: string, conversationId: string, title: string): Promise<ExperimentConversation>;
  sendExperimentMessage(projectId: string, experimentId: string, conversationId: string, text: string): Promise<Experiment>;
  answerExperimentQuestion(projectId: string, experimentId: string, conversationId: string, requestId: string, answers: Record<string, string>): Promise<Experiment>;
  stopExperiment(projectId: string, experimentId: string, conversationId: string): Promise<Experiment>;
  updateExperimentSettings(projectId: string, experimentId: string, settings: Partial<ExperimentSettings>): Promise<Experiment>;
  experimentJobAction(projectId: string, experimentId: string, jobId: string, action: "approve" | "reject" | "stop"): Promise<ExperimentJob>;
  clearExperimentJobLogs(projectId: string, experimentId: string, jobIds: string[]): Promise<ExperimentJob[]>;
  readExperimentJobLog(projectId: string, experimentId: string, jobId: string): Promise<string>;
  readExperimentJobLogChunk(projectId: string, experimentId: string, jobId: string, from?: number): Promise<ExperimentLogChunk>;
  runExperimentCommand(projectId: string, experimentId: string, input: { command: string; cwd?: string; notify?: boolean; conversationId?: string }): Promise<ExperimentJob>;
  openExperimentTerminal(projectId: string, experimentId: string, path?: string): Promise<boolean>;
  saveExperimentRecord(projectId: string, experimentId: string, text: string): Promise<string>;
  listExperimentFiles(projectId: string, experimentId: string): Promise<ExperimentFileNode[]>;
  readExperimentDiff(projectId: string, experimentId: string): Promise<ExperimentDiff>;
  openExperimentPath(projectId: string, experimentId: string, path?: string): Promise<boolean>;
  onExperimentUpdate(callback: (update: ExperimentUpdate) => void): () => void;
  getProjectEnvironment(projectId: string): Promise<import("./screens/project-environment/model").ProjectEnvironmentSnapshot>;
  createProjectEnvironment(projectId: string, input: import("./screens/project-environment/model").EnvironmentCreateInput): Promise<import("./screens/project-environment/model").ProjectEnvironmentSnapshot>;
  bindProjectEnvironment(projectId: string, input: import("./screens/project-environment/model").EnvironmentBindInput): Promise<import("./screens/project-environment/model").ProjectEnvironmentSnapshot>;
  checkProjectEnvironment(projectId: string): Promise<import("./screens/project-environment/model").ProjectEnvironmentSnapshot>;
  prepareProjectEnvironmentUpdate(projectId: string, requestId: string): Promise<import("./screens/project-environment/model").ProjectEnvironmentSnapshot>;
  approveProjectEnvironmentUpdate(projectId: string, requestId: string, fingerprint: string): Promise<import("./screens/project-environment/model").ProjectEnvironmentSnapshot>;
  rejectProjectEnvironmentUpdate(projectId: string, requestId: string): Promise<import("./screens/project-environment/model").ProjectEnvironmentSnapshot>;
  onProjectEnvironmentUpdate(callback: (projectId: string) => void): () => void;
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  chooseWorkspace(): Promise<WorkspaceSnapshot | null>;
  openWorkspace(): Promise<boolean>;
  searchWorkspace(query: string): Promise<SearchResult[]>;
  createProject(payload: { title: string; direction: string }): Promise<Project>;
  updateProject(payload: { projectId: string; title: string; direction: string }): Promise<Project>;
  importPapers(projectId: string): Promise<Paper[]>;
  listProjectFiles(payload: { projectId: string; showSystemFiles?: boolean; path?: string }): Promise<ProjectFileNode[]>;
  importProjectFiles(payload: { projectId: string; sourcePaths: Array<string | { path: string; relativePath?: string }>; targetPath?: string }): Promise<string[]>;
  chooseProjectFiles(payload: { projectId: string; kind: "files" | "folder" }): Promise<string[]>;
  openProjectFolder(projectId: string): Promise<boolean>;
  openProjectFile(payload: { projectId: string; path: string }): Promise<boolean>;
  revealProjectFile(payload: { projectId: string; path: string }): Promise<boolean>;
  startProjectFileDrag(payload: { projectId: string; path: string }): void;
  getDroppedFilePaths(files: File[]): string[];
  onProjectFileDragError(callback: (message: string) => void): () => void;
  openPaper(payload: { projectId: string; paperId: string }): Promise<boolean>;
  readPaper(payload: { projectId: string; paperId: string }): Promise<Uint8Array>;
  saveIdea(payload: { projectId: string; idea: Partial<Idea> }): Promise<Idea>;
  updateIdea(payload: { projectId: string; ideaId: string; status: IdeaStatus; reason?: string }): Promise<Idea>;
  sendMessage(payload: { projectId: string; discussionId?: string | null; content: string; paperIds: string[]; scope?: DiscussionScope }): Promise<{ answer: string; sources: EvidenceSource[]; discussion: Discussion; discussions: DiscussionSummary[]; papers: Paper[] }>;
  getDiscussion(payload: { projectId: string; discussionId: string }): Promise<Discussion>;
  createDiscussion(payload: { projectId: string; title?: string }): Promise<{ discussion: Discussion; discussions: DiscussionSummary[] }>;
  renameDiscussion(payload: { projectId: string; discussionId: string; title: string }): Promise<{ discussion: Discussion; discussions: DiscussionSummary[] }>;
  deleteDiscussion(payload: { projectId: string; discussionId: string }): Promise<{ discussions: DiscussionSummary[] }>;
  sendPaperAgentMessage(payload: { projectId: string; paperId: string; content: string }): Promise<{ answer: string; paper: Paper }>;
  getPaperAgentState(payload: { projectId: string; paperId: string }): Promise<PaperAgentState>;
  answerPaperAgentQuestion(payload: { projectId: string; paperId: string; requestId: string; answers: Record<string, string> }): Promise<{ paper: Paper; state: PaperAgentState }>;
  stopPaperAgent(payload: { projectId: string; paperId: string }): Promise<PaperAgentState>;
  onPaperAgentUpdate(callback: (state: PaperAgentState) => void): () => void;
  analyzePaper(payload: { projectId: string; paperId: string }): Promise<Paper>;
  analyzeAllPapers(projectId: string): Promise<Paper[]>;
  readPaperAnalysisCallLog(payload: { projectId: string; paperId: string; callId: string }): Promise<PaperAnalysisCallLog>;
  saveResearchNote(payload: { projectId: string; text: string; fromMessageId?: string; paperId?: string }): Promise<ResearchNote>;
  updatePaper(payload: { projectId: string; paperId: string; role?: PaperRole; analysisDepth?: AnalysisDepth }): Promise<Paper>;
  updateResearchNote(payload: { projectId: string; noteId: string; text?: string; paperId?: string | null }): Promise<ResearchNote>;
  onAnalysisProgress(callback: (progress: PaperAnalysisProgress) => void): () => void;
  getSettings(): Promise<ModelSettings>;
  saveSettings(payload: ModelSettings): Promise<ModelSettings>;
  testSettings(projectId?: string): Promise<{ content: string; source: string }>;
  getLlmState(refresh?: boolean): Promise<LlmState>;
  saveLlmProvider(provider: LlmProviderDraft): Promise<LlmState>;
  deleteLlmProvider(providerId: string): Promise<LlmState>;
  selectLlmModel(slot: "active" | "agent", providerId: string, model: string): Promise<LlmState>;
  listLlmModels(payload: { providerId?: string; baseUrl?: string; apiKey?: string }): Promise<string[]>;
  testLlmModel(providerId: string, model: string): Promise<{ content: string; source: string }>;
  getWorkspacePath(): Promise<string>;
}

declare global {
  interface Window {
    autoresearch: DesktopBridge;
  }
}

