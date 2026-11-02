// 只提交申请；不执行 Conda、pip 或任何安装命令。
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const split = args.indexOf("--");
const options = args.slice(0, split < 0 ? 0 : split);
const managerIndex = options.indexOf("--manager");
const noteIndex = options.indexOf("--note");
const manager = managerIndex >= 0 ? options[managerIndex + 1] : "pip";
const packages = split >= 0 ? args.slice(split + 1) : [];
if (!["conda", "pip"].includes(manager) || !packages.length) {
  console.error('用法：node .ar/environment.mjs [--manager pip|conda] [--note "原因"] -- 包名 [包名...]');
  process.exit(1);
}
const directory = join(dirname(fileURLToPath(import.meta.url)), "environment-requests");
await mkdir(directory, { recursive: true });
const id = randomUUID();
const path = join(directory, `${id}.json`);
const conversationId = process.env.AUTORESEARCH_CONVERSATION_ID;
const request = {
  id, manager, packages, note: noteIndex >= 0 ? options[noteIndex + 1] : "",
  ...(typeof conversationId === "string" && /^conv_[A-Za-z0-9_-]{3,64}$/.test(conversationId) ? { conversationId } : {}),
};
await writeFile(`${path}.tmp`, JSON.stringify(request), "utf8");
await rename(`${path}.tmp`, path);
console.log(`依赖申请 ${id} 已提交，等待研究者在“运行环境”确认。没有安装任何包。`);
