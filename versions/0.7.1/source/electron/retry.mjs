import { setTimeout as delay } from "node:timers/promises";

export function isRetryable(error) {
  if (error?.permanent) return false;
  const status = Number(error?.status);
  if (status) return [408, 409, 425, 429].includes(status) || status >= 500;
  const message = String(error?.message ?? error);
  if (/\b(?:400|401|402|403|404|422)\b|unauthorized|invalid.?api.?key|insufficient.?quota|billing|not logged in|login required|model.*(?:not found|not supported)|未找到 Codex|SDK 未安装|authentication|登录|凭据|余额不足/i.test(message)) return false;
  return true;
}

export function retryDelay(attempt, random = Math.random) {
  return Math.round(Math.min(30_000, 2_000 * 2 ** Math.min(attempt - 1, 8)) * (0.8 + random() * 0.4));
}

export function waitForRetry(milliseconds, signal) {
  return delay(milliseconds, undefined, { signal });
}

export function safeError(error) {
  return String(error?.message ?? error).replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]{8,}/g, "[已隐藏]").slice(0, 800);
}
