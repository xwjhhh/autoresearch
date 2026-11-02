// Only transient provider/transport failures may resume a tool-using agent.
// Command failures, approvals, credentials and local runner setup are not retries.
export function isTransientCodexFailure(error) {
  if (error?.permanent || error?.name === "AbortError" || error?.name === "TimeoutError") return false;
  const message = String(error?.message ?? error);
  if (/insufficient.?quota|billing|unauthorized|authentication|invalid.?api.?key|approval.*(?:required|never)|requires approval|access denied|setup refresh|helper_unknown_error|active writer|thread-store conflict/i.test(message)) return false;
  const status = Number(error?.status ?? error?.statusCode);
  if (status && ![408, 429, 500, 502, 503, 504].includes(status)) return false;
  return [408, 429, 500, 502, 503, 504].includes(status)
    || /concurrency limit exceeded|too many requests|rate[_ -]?limit|\b429\b|stream disconnected|connection (?:reset|closed|terminated)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|reply stream|回复流在完成前中断|\b(?:502|503|504)\b/i.test(message);
}

export function codexRecoveryDelay(attempt, random = Math.random) {
  return Math.round(Math.min(60_000, 15_000 * 2 ** Math.min(attempt - 1, 3)) * (0.8 + random() * 0.4));
}

export const CODEX_CONTINUATION_PROMPT = [
  "[平台连接恢复] 上一回合因上游并发限额、限流或连接中断而结束。继续本会话中尚未完成的用户请求。",
  "先依据本会话的工具结果、现有文件和任务状态确认进度；已成功完成的命令或修改不要重复执行。",
  "已提交的后台任务不要重新提交；任务仍在运行时，按既有规则结束本轮并等待平台通知，不要轮询。",
  "保留既有授权与研究记录；如无法确定某项操作是否完成，先核实状态，不能盲目重做。",
].join("\n");
