// 长时间操作按任务分别记录，互不覆盖：分析论文期间可以讨论，讨论结束也不会解锁正在分析的按钮。
export const taskKeys = {
  createProject: "create-project",
  saveProject: "save-project",
  saveIdea: "save-idea",
  importPapers: (projectId: string) => `import:${projectId}`,
  analyze: (projectId: string, paperId: string) => `analyze:${projectId}:${paperId}`,
  analyzeAll: (projectId: string) => `analyze-all:${projectId}`,
  /** 研究讨论：每个讨论各自发送，互不阻塞；null 是还没发送过的新讨论 */
  send: (projectId: string, discussionId: string | null = null) => `send:${projectId}:${discussionId ?? "new"}`,
};

/** 这篇论文正在分析（单独分析或“分析全部”）。 */
export function isAnalyzing(tasks: ReadonlySet<string>, projectId: string, paperId: string) {
  return tasks.has(taskKeys.analyze(projectId, paperId)) || tasks.has(taskKeys.analyzeAll(projectId));
}

/**
 * 收到的分析进度是否仍在进行。导入时自动分析由后台发起，前端没有对应的任务，
 * 只能从进度判断；进度里的分析过程标为完成或失败后就不算了。
 */
export function isLiveProgress(progress: { trace?: { status?: string } } | null | undefined) {
  return Boolean(progress) && progress?.trace?.status !== "complete" && progress?.trace?.status !== "failed";
}

/** 这个课题有论文正在分析。 */
export function anyAnalysis(tasks: ReadonlySet<string>, projectId: string) {
  if (tasks.has(taskKeys.analyzeAll(projectId))) return true;
  const prefix = `analyze:${projectId}:`;
  for (const key of tasks) if (key.startsWith(prefix)) return true;
  return false;
}

