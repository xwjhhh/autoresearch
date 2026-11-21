// 由 AutoResearch 放进设计实验工作目录的 .ar/conclude.mjs。
// agent 用它提交实验结论：这里只写一个请求文件，平台在本轮结束后读取并记到实验上。
// 用法：node .ar/conclude.mjs --verdict supported|refuted|inconclusive --summary "一句话结论"
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const usage = '用法：node .ar/conclude.mjs --verdict supported|refuted|inconclusive --summary "一句话结论"';
const fail = (message) => {
  console.error(message);
  console.error(usage);
  process.exit(2);
};

const args = process.argv.slice(2);
let verdict = "";
let summary = "";
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--verdict") verdict = args[++index] ?? "";
  else if (args[index] === "--summary") summary = args[++index] ?? "";
  else fail(`不认识的参数：${args[index]}`);
}
if (!["supported", "refuted", "inconclusive"].includes(verdict)) fail("--verdict 只能是 supported（支持假设）、refuted（不支持）或 inconclusive（不确定）。");
summary = summary.trim();
if (!summary) fail("--summary 不能为空：用一两句话说明结论和依据。");
if (summary.length > 1000) fail("--summary 太长，请控制在 1000 字以内，细节写进 EXPERIMENT.md。");

const here = dirname(fileURLToPath(import.meta.url));
const conversationId = process.env.AUTORESEARCH_CONVERSATION_ID;
if (conversationId && !/^conv_[A-Za-z0-9_-]{3,64}$/.test(conversationId)) fail("会话编号无效。");
const directory = conversationId ? join(here, "conversations", conversationId, "conclusions") : join(here, "conclusions");
mkdirSync(directory, { recursive: true });
const file = join(directory, `${Date.now()}-${process.pid}.json`);
writeFileSync(`${file}.tmp`, `${JSON.stringify({ verdict, summary, submittedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
renameSync(`${file}.tmp`, file);
const labels = { supported: "支持假设", refuted: "不支持假设", inconclusive: "不确定" };
console.log(`已提交结论：${labels[verdict]}。平台会在本轮结束后记录。`);
