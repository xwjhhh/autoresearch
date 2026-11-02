import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const assertDiscussionId = (value) => {
  if (typeof value !== "string" || !/^disc_[0-9]{3,}$/.test(value)) throw new Error("讨论编号无效。");
  return value;
};
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(path, "utf8")); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; } };
const writeJson = async (path, value) => { await mkdir(dirname(path), { recursive: true }); const tmp = `${path}.${randomUUID()}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(tmp, path); };
const clean = (v, max) => typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";
export const titleFromQuestion = (text) => {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "新讨论";
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized;
};

export class DiscussionStore {
  constructor(input = {}) { this.projectRoot = typeof input === "string" ? () => input : input.projectRoot; this.legacyMessages = input.legacyMessages ?? (async () => []); this.clearLegacyMessages = input.clearLegacyMessages ?? (async () => {}); }
  get root() { return join(typeof this.projectRoot === "function" ? this.projectRoot() : this.projectRoot, "Discussions"); }
  get indexPath() { return join(this.root, "index.json"); }
  static locks = new Map();
  async locked(projectId, action) { const key = `${this.root}:${projectId}`; const previous = DiscussionStore.locks.get(key) ?? Promise.resolve(); let release; const current = new Promise((resolve) => { release = resolve; }); DiscussionStore.locks.set(key, previous.then(() => current)); await previous; try { return await action(); } finally { release(); if (DiscussionStore.locks.get(key) === current) DiscussionStore.locks.delete(key); } }
  async ensure(projectId) {
    await mkdir(this.root, { recursive: true });
    let index = await readJson(this.indexPath, null);
    if (!index) {
      const legacy = await this.legacyMessages(projectId);
      const fileLegacy = legacy.length ? legacy : await readJson(join(this.root, "messages.json"), []);
      if (fileLegacy.length) {
        const first = fileLegacy.find((m) => m.role === "user");
        const item = { id: "disc_001", title: titleFromQuestion(first?.content), messageCount: fileLegacy.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), scope: fileLegacy.find((m) => m.scope)?.scope === "analysis" ? "analysis" : "all", paperIds: [] };
        await writeJson(join(this.root, `${item.id}.json`), { ...item, messages: fileLegacy });
        index = [item];
        await this.saveIndex(index);
        await this.clearLegacyMessages(projectId);
      } else index = [];
    }
    return Array.isArray(index) ? index : index.discussions;
  }
  async saveIndex(value) { await writeJson(this.indexPath, value); }
  async list(projectId) { return this.ensure(projectId); }
  async get(projectId, id) { const safe = assertDiscussionId(id); const list = await this.ensure(projectId); if (!list.some((x) => x.id === safe)) throw new Error("讨论不存在或已被删除。"); return readJson(join(this.root, `${safe}.json`), null); }
  async create(projectId, input = {}) { const list = await this.ensure(projectId); const id = `disc_${String(list.length + 1).padStart(3, "0")}`; const now = new Date().toISOString(); const discussion = { id, title: clean(input.title, 100) || "新讨论", createdAt: now, updatedAt: now, scope: input.scope ?? "analysis", paperIds: [], messageCount: 0 }; await writeJson(join(this.root, `${id}.json`), { ...discussion, messages: [] }); const next = [discussion, ...list]; await this.saveIndex(next); return { discussion, discussions: next }; }
  async rename(projectId, id, title) { const item = await this.get(projectId, id); const cleanTitle = clean(title, 100); if (!cleanTitle) throw new Error("讨论名称不能为空。"); item.title = cleanTitle; item.updatedAt = new Date().toISOString(); await writeJson(join(this.root, `${item.id}.json`), item); const list = (await this.ensure(projectId)).map((x) => x.id === item.id ? { ...x, title: item.title, updatedAt: item.updatedAt } : x); await this.saveIndex(list); return { discussions: list }; }
  async remove(projectId, id) { const safe = assertDiscussionId(id); const list = await this.ensure(projectId); await rm(join(this.root, `${safe}.json`), { force: true }); const next = list.filter((x) => x.id !== safe); await this.saveIndex(next); return { discussions: next }; }
  async appendExchange(projectId, id, exchange) { return this.locked(projectId, async () => { const created = id ? null : await this.create(projectId); const item = id ? await this.get(projectId, id) : await this.get(projectId, created.discussion.id); const messages = [...(item.messages ?? []), exchange.userMessage, exchange.assistantMessage]; item.title = item.messageCount ? item.title : titleFromQuestion(exchange.userMessage?.content); item.paperIds = [...new Set(exchange.paperIds ?? [])]; item.scope = exchange.scope === "all" ? "analysis" : (exchange.scope ?? item.scope); item.messageCount = messages.length; item.updatedAt = new Date().toISOString(); await writeJson(join(this.root, `${item.id}.json`), { ...item, messages }); const list = (await this.ensure(projectId)).map((x) => x.id === item.id ? { ...item, messages: undefined } : x); await this.saveIndex(list); return { discussion: item, discussions: list }; }); }
}

