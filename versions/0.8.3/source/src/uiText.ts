import type { AnalysisDepth, IdeaStatus, PaperRole, PaperStatus } from "./types";

export const statusLabels: Record<IdeaStatus, string> = {
  candidate: "候选",
  continue: "继续研究",
  parked: "暂存",
  rejected: "淘汰",
};

export const paperStatusLabels: Record<PaperStatus, string> = {
  parsed: "已解析",
  needs_review: "无可检索文本",
  parse_failed: "解析失败",
  parsing: "解析中",
  stale: "原文已变化",
};

export const analysisStatusLabels = {
  none: "未分析",
  running: "分析中",
  complete: "已完成",
  stale: "需更新",
  failed: "失败",
} as const;

export const formatDate = (value: string) => new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });

export const paperRoleLabels: Record<PaperRole, string> = { core: "核心", atypical: "非常规" };
export const analysisDepthLabels: Record<AnalysisDepth, string> = { full: "完整分析", light: "简化分析" };
