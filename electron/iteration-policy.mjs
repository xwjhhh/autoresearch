export const approvalMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export function iterationApproval({ method, params, item }) {
  if (method === "item/commandExecution/requestApproval") {
    const network = params.networkApprovalContext;
    const title = network ? "允许本次联网请求" : params.kind === "writeStdin" ? "允许本次终端输入" : "允许运行此命令";
    const detail = [
      params.command ?? item?.command,
      params.cwd && `工作目录：${params.cwd}`,
      network && `网络目标：${network.host}（${network.protocol}）`,
      params.reason,
    ].filter(Boolean).join("\n");
    return { kind: "command", title, detail: detail || `操作 ID：${params.itemId}` };
  }
  if (method === "item/fileChange/requestApproval") {
    const changes = (item?.changes ?? []).map(({ path, kind, diff }) => `${path}${kind?.move_path ? ` → ${kind.move_path}` : ""}\n${diff ?? ""}`);
    const detail = [params.grantRoot && `请求写入目录：${params.grantRoot}`, params.reason, ...changes].filter(Boolean).join("\n\n");
    return { kind: "patch", title: "允许此文件改动", detail: detail || `补丁 ID：${params.itemId}` };
  }
  const detail = [params.cwd && `工作目录：${params.cwd}`, params.reason, JSON.stringify(params.permissions, null, 2)].filter(Boolean).join("\n");
  return { kind: "permissions", title: "授予本回合附加权限", detail };
}

export function iterationApprovalResult(method, params, approve, aborted) {
  if (method === "item/permissions/requestApproval") {
    const { network, fileSystem } = approve && !aborted ? params?.permissions ?? {} : {};
    return { permissions: { ...(network && { network }), ...(fileSystem && { fileSystem }) }, scope: "turn" };
  }
  return { decision: aborted ? "cancel" : approve ? "accept" : "decline" };
}
