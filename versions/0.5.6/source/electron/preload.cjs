const { contextBridge, ipcRenderer, webUtils } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("autoresearch", {
  // 实验复现
  listExperiments: (projectId) => invoke("experiment:list", { projectId }),
  getExperiment: (projectId, experimentId) => invoke("experiment:get", { projectId, experimentId }),
  createExperiment: (projectId, input) => invoke("experiment:create", { projectId, input }),
  createExperimentConversation: (projectId, experimentId, title) => invoke("experiment:conversation:create", { projectId, experimentId, title }),
  renameExperimentConversation: (projectId, experimentId, conversationId, title) => invoke("experiment:conversation:rename", { projectId, experimentId, conversationId, title }),
  sendExperimentMessage: (projectId, experimentId, conversationId, text) => invoke("experiment:send", { projectId, experimentId, conversationId, text }),
  answerExperimentQuestion: (projectId, experimentId, conversationId, requestId, answers) => invoke("experiment:answer-question", { projectId, experimentId, conversationId, requestId, answers }),
  stopExperiment: (projectId, experimentId, conversationId) => invoke("experiment:stop", { projectId, experimentId, conversationId }),
  updateExperimentSettings: (projectId, experimentId, settings) => invoke("experiment:settings", { projectId, experimentId, settings }),
  experimentJobAction: (projectId, experimentId, jobId, action) => invoke("experiment:job", { projectId, experimentId, jobId, action }),
  clearExperimentJobLogs: (projectId, experimentId, jobIds) => invoke("experiment:job-logs:clear", { projectId, experimentId, jobIds }),
  readExperimentJobLog: (projectId, experimentId, jobId) => invoke("experiment:job-log", { projectId, experimentId, jobId }),
  readExperimentJobLogChunk: (projectId, experimentId, jobId, from) => invoke("experiment:job-log-chunk", { projectId, experimentId, jobId, from }),
  runExperimentCommand: (projectId, experimentId, input) => invoke("experiment:run", { projectId, experimentId, input }),
  openExperimentTerminal: (projectId, experimentId, path) => invoke("experiment:terminal", { projectId, experimentId, path }),
  saveExperimentRecord: (projectId, experimentId, text) => invoke("experiment:record", { projectId, experimentId, text }),
  listExperimentFiles: (projectId, experimentId) => invoke("experiment:files", { projectId, experimentId }),
  readExperimentDiff: (projectId, experimentId) => invoke("experiment:diff", { projectId, experimentId }),
  openExperimentPath: (projectId, experimentId, path) => invoke("experiment:open", { projectId, experimentId, path }),
  onExperimentUpdate: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on("experiment:update", listener);
    return () => ipcRenderer.removeListener("experiment:update", listener);
  },
  getProjectEnvironment: (projectId) => invoke("project-environment:get", { projectId }),
  createProjectEnvironment: (projectId, input) => invoke("project-environment:create", { projectId, input }),
  bindProjectEnvironment: (projectId, input) => invoke("project-environment:bind", { projectId, input }),
  checkProjectEnvironment: (projectId) => invoke("project-environment:check", { projectId }),
  prepareProjectEnvironmentUpdate: (projectId, requestId) => invoke("project-environment:prepare", { projectId, requestId }),
  approveProjectEnvironmentUpdate: (projectId, requestId, fingerprint) => invoke("project-environment:approve", { projectId, requestId, fingerprint }),
  rejectProjectEnvironmentUpdate: (projectId, requestId) => invoke("project-environment:reject", { projectId, requestId }),
  onProjectEnvironmentUpdate: (callback) => {
    const listener = (_event, projectId) => callback(projectId);
    ipcRenderer.on("project-environment:update", listener);
    return () => ipcRenderer.removeListener("project-environment:update", listener);
  },
  loadWorkspace: () => invoke("workspace:load"),
  chooseWorkspace: () => invoke("workspace:choose"),
  openWorkspace: () => invoke("workspace:open"),
  searchWorkspace: (query) => invoke("workspace:search", { query }),
  createProject: (payload) => invoke("project:create", payload),
  updateProject: (payload) => invoke("project:update", payload),
  importPapers: (projectId) => invoke("paper:import", projectId),
  listProjectFiles: (payload) => invoke("project-files:list", payload),
  importProjectFiles: (payload) => invoke("project-files:import", payload),
  chooseProjectFiles: (payload) => invoke("project-files:choose-import", payload),
  openProjectFolder: (projectId) => invoke("project-files:open-root", projectId),
  openProjectFile: (payload) => invoke("project-files:open", payload),
  revealProjectFile: (payload) => invoke("project-files:reveal", payload),
  startProjectFileDrag: (payload) => ipcRenderer.send("project-files:start-drag", payload),
  getDroppedFilePaths: (files) => files.flatMap((file) => {
    try { return [webUtils.getPathForFile(file)]; }
    catch { return []; }
  }).filter(Boolean),
  onProjectFileDragError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("project-files:drag-error", listener);
    return () => ipcRenderer.removeListener("project-files:drag-error", listener);
  },
  openPaper: (payload) => invoke("paper:open", payload),
  readPaper: (payload) => invoke("paper:read", payload),
  saveIdea: (payload) => invoke("idea:save", payload),
  updateIdea: (payload) => invoke("idea:update", payload),
  sendMessage: (payload) => invoke("chat:send", payload),
  getDiscussion: (payload) => invoke("discussion:get", payload),
  createDiscussion: (payload) => invoke("discussion:create", payload),
  renameDiscussion: (payload) => invoke("discussion:rename", payload),
  deleteDiscussion: (payload) => invoke("discussion:delete", payload),
  sendPaperAgentMessage: (payload) => invoke("paper-agent:send", payload),
  getPaperAgentState: (payload) => invoke("paper-agent:state", payload),
  answerPaperAgentQuestion: (payload) => invoke("paper-agent:answer", payload),
  stopPaperAgent: (payload) => invoke("paper-agent:stop", payload),
  onPaperAgentUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("paper-agent:update", listener);
    return () => ipcRenderer.removeListener("paper-agent:update", listener);
  },
  analyzePaper: (payload) => invoke("paper:analyze", payload),
  analyzeAllPapers: (projectId) => invoke("paper:analyze-all", projectId),
  readPaperAnalysisCallLog: (payload) => invoke("paper:analysis-call-log", payload),
  saveResearchNote: (payload) => invoke("research-note:save", payload),
  // 论文分析与笔记
  updatePaper: (payload) => invoke("paper:update", payload),
  updateResearchNote: (payload) => invoke("research-note:update", payload),
  onAnalysisProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("paper:analysis-progress", listener);
    return () => ipcRenderer.removeListener("paper:analysis-progress", listener);
  },
  getSettings: () => invoke("settings:get"),
  saveSettings: (payload) => invoke("settings:save", payload),
  testSettings: (projectId) => invoke("settings:test", { projectId }),
  getWorkspacePath: () => invoke("workspace:path"),
});

