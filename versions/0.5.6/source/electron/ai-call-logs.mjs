import { mkdir, readFile, readdir, writeFile, lstat, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const scopeIdPattern = /^(?:paper_\d{3,}|idea_\d{3,}|project)$/;
const callIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertIds(scopeId, callId) {
  if (typeof scopeId !== "string" || !scopeIdPattern.test(scopeId)) throw new Error("调用日志归属编号无效。");
  if (typeof callId !== "string" || !callIdPattern.test(callId)) throw new Error("调用日志编号无效。");
}

async function ensureLogDirectory(projectRoot, scopeId) {
  const root = resolve(projectRoot);
  let current = root;
  for (const segment of ["ai-call-logs", scopeId]) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("调用日志目录无效。");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current, { recursive: true });
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("调用日志目录无效。");
    }
  }
  return current;
}

export async function writeAiCallLog(projectRoot, scopeId, callId, record) {
  assertIds(scopeId, callId);
  if (!record || record.id !== callId || (record.scopeId ?? record.paperId) !== scopeId) throw new Error("调用日志内容无效。");
  const directory = await ensureLogDirectory(projectRoot, scopeId);
  const path = join(directory, `${callId}.json`);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("调用日志文件无效。");
  return path;
}

export async function readAiCallLog(projectRoot, scopeId, callId) {
  assertIds(scopeId, callId);
  const directory = await ensureLogDirectory(projectRoot, scopeId);
  const path = resolve(directory, `${callId}.json`);
  if (dirname(path) !== resolve(directory)) throw new Error("调用日志路径无效。");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("调用日志文件无效。");
  return JSON.parse(await readFile(path, "utf8"));
}

export async function interruptRunningAiCallLogs(projectRoot, scopeId, error, finishedAt) {
  const directory = await ensureLogDirectory(projectRoot, scopeId);
  const interrupted = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const callId = entry.name.slice(0, -5);
    if (!callIdPattern.test(callId)) continue;
    try {
      const record = await readAiCallLog(projectRoot, scopeId, callId);
      if (record.status !== "running") continue;
      const updated = { ...record, status: "failed", error, finishedAt };
      await writeAiCallLog(projectRoot, scopeId, callId, updated);
      interrupted.push(updated);
    } catch {
      // A damaged log should not prevent recovery of the paper checkpoint.
    }
  }
  return interrupted;
}

export async function interruptRunningAiCallLogsInProject(projectRoot, error, finishedAt) {
  const root = resolve(projectRoot);
  const directory = join(root, "ai-call-logs");
  let info;
  try {
    info = await lstat(directory);
  } catch (readError) {
    if (readError.code === "ENOENT") return [];
    throw readError;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("调用日志目录无效。");
  const interrupted = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !scopeIdPattern.test(entry.name)) continue;
    interrupted.push(...await interruptRunningAiCallLogs(root, entry.name, error, finishedAt));
  }
  return interrupted;
}
