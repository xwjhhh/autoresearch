// 由 AutoResearch 放进每个实验工作目录的 .ar/run.mjs。
// agent 用它把长时间运行的命令交给平台：这里只写一个请求文件，不运行命令。
// 用法：node .ar/run.mjs <名字> [--cwd 子目录] [--note "一句话说明"] -- "<完整命令>"
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = '用法：node .ar/run.mjs <名字> [--cwd 子目录] [--note "一句话说明"] -- "<完整命令>"';
const fail = (message) => {
  console.error(message);
  console.error(usage);
  process.exit(2);
};

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..");
const args = process.argv.slice(2);
const split = args.indexOf("--");
if (split < 0) fail("缺少 -- 和要运行的命令。");
const head = args.slice(0, split);
const tail = args.slice(split + 1);

const name = head[0];
if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(name)) fail("名字只能包含字母、数字、点、下划线和连字符，最长 48 个字符。");
let cwd = ".";
let note = "";
for (let index = 1; index < head.length; index += 1) {
  if (head[index] === "--cwd") cwd = head[++index] ?? fail("--cwd 后面缺少目录。");
  else if (head[index] === "--note") note = head[++index] ?? "";
  else fail(`不认识的参数：${head[index]}`);
}

const target = resolve(workspace, cwd);
const rel = relative(workspace, target);
if (rel.startsWith("..") || isAbsolute(rel)) fail("--cwd 必须在工作目录内。");

// 推荐把整条命令作为一个参数传入；拆开传入时尽量还原引号。
const quote = (part) => /^[\w@%+=:,./\\-]+$/.test(part) ? part : `"${part.replace(/"/g, '\\"')}"`;
const command = (tail.length === 1 ? tail[0] : tail.map(quote).join(" ")).trim();
if (!command) fail("命令不能为空。");
if (command.length > 8000) fail("命令太长。请先把它写成脚本，再提交运行脚本的命令。");

const conversationId = process.env.AUTORESEARCH_CONVERSATION_ID;
if (conversationId && !/^conv_[A-Za-z0-9_-]{3,64}$/.test(conversationId)) fail("会话编号无效。");
const directory = conversationId ? join(here, "conversations", conversationId, "requests") : join(here, "requests");
mkdirSync(directory, { recursive: true });
const file = join(directory, `${Date.now()}-${process.pid}.json`);
const request = { name, command, cwd: rel || ".", note: note.slice(0, 500), requestedAt: new Date().toISOString() };
writeFileSync(`${file}.tmp`, `${JSON.stringify(request, null, 2)}\n`, "utf8");
renameSync(`${file}.tmp`, file);

console.log(`已提交后台任务「${name}」：${command}`);
console.log("现在结束这一轮回复即可。平台会运行它（可能要先等研究者确认），结束后把退出码和日志末尾发给你。");
