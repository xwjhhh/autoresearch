import { CODEX_PROVIDER_ID, type LlmProvider, type LlmSelection, type LlmState } from "../../types";

/** 选择项的显示名，例如“DeepSeek · deepseek-chat”。 */
export function selectionLabel(state: LlmState, selection: LlmSelection): string {
  if (selection.providerId === CODEX_PROVIDER_ID) return state.codex.model ? `Codex · ${state.codex.model}` : "跟随 Codex 配置";
  const provider = state.providers.find((item) => item.id === selection.providerId);
  if (!provider) return "服务商已删除";
  return selection.model ? `${provider.name} · ${selection.model}` : `${provider.name} · 未选模型`;
}

/** 当前选择能不能用：服务商存在、选了模型；Codex 要能探测到可用路线。 */
export function selectionReady(state: LlmState, selection: LlmSelection, kind: "active" | "agent"): boolean {
  if (selection.providerId === CODEX_PROVIDER_ID) return kind === "agent" ? state.codex.agentAvailable : state.codex.available;
  const provider = state.providers.find((item) => item.id === selection.providerId);
  if (!provider || !selection.model) return false;
  return kind === "agent" ? provider.protocols.includes("responses") && state.codex.cliAvailable : true;
}

export function codexRouteText(state: LlmState): string {
  const { codex } = state;
  const model = codex.model || "当前模型";
  if (codex.route === "routing") return `CC Switch Routing 正在运行 · ${model}`;
  if (codex.route === "provider") return `Codex provider「${codex.provider}」· ${model}`;
  if (codex.route === "cli") return `本机 Codex CLI · ${model}`;
  return codex.reason || "没有检测到可用的 Codex 配置";
}

export const supportsAgent = (provider: LlmProvider) => provider.protocols.includes("responses");
