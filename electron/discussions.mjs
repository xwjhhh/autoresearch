import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const assertDiscussionId = (value) => {
  if (typeof value !== "string" || !/^disc_[0-9]{3,}$/.test(value)) throw new Error("讨论编号无效。");
  return value;
};
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(path, "utf8")); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; } };
const writeJson = async (path, value) => { await mkdir(dirname(path), { recursive: true }); const tmp = `${path}.${randomUUID()}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(tmp, path); };
const clean = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";
export const titleFromQuestion = (text) => clean(String(text ?? "").replace(/\s+/g, " "), 80) || "未命名讨论";

export class DiscussionStore {
  constructor(input = {}) { this.projectRoot = typeof input === "string" ? () => input : input.projectRoot; this.legacyMessages = input.legacyMessages ?? (async () => []); this.clearLegacyMessages = input.clearLegacyMessages ?? (async () => {}); } }
  async ensure(project) {
    await mkdir(this.root, { recursive: true });
    let index = await readJson(this.indexPath, null);
    if (!index?.discussions?.length) {
      const legacy = Array.isArray(project?.messages) ? project.messages : (await readJson(join(this.root, "messages.json"), { messages: [] })).messages;
      const item = { id: "disc_001", title: legacy?.find((m) => m.role === "user")?.content ? titleFromQuestion(legacy.find((m) => m.role === "user").content) : "研究讨论", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), scope: "project", paperIds: [] };
      await writeJson(join(this.root, `${item.id}.json`), { ...item, messages: legacy ?? [] });
      index = { discussions: [item] };
      await writeJson(this.indexPath, index);
    }
    return index.discussions;
  }
  async list(project = this.project) { return this.ensure(project); }
  async get(project, id) { const safe = assertDiscussionId(id); await this.ensure(project); return readJson(join(this.root, `${safe}.json`), null); }
  async create(project, input = {}) { const list = await this.ensure(project); const id = `disc_${String(list.length + 1).padStart(3, "0")}`; const now = new Date().toISOString(); const item = { id, title: clean(input.title, 100) || "新讨论", createdAt: now, updatedAt: now, scope: input.scope === "paper" ? "paper" : "project", paperIds: Array.isArray(input.paperIds) ? input.paperIds : [], messages: [] }; await writeJson(join(this.root, `${id}.json`), item); await writeJson(this.indexPath, { discussions: [...list, { ...item, messages: undefined }] }); return item; }
  async rename(project, id, title) { const item = await this.get(project, id); if (!item) throw new Error("讨论不存在。"); item.title = clean(title, 100) || item.title; item.updatedAt = new Date().toISOString(); await writeJson(join(this.root, `${item.id}.json`), item); const list = await this.ensure(project); await writeJson(this.indexPath, { discussions: list.map((x) => x.id === item.id ? { ...x, title: item.title, updatedAt: item.updatedAt } : x) }); return item; }
  async remove(project, id) { const safe = assertDiscussionId(id); const list = await this.ensure(project); if (list.length <= 1) throw new Error("至少保留一个讨论。"); await rm(join(this.root, `${safe}.json`), { force: true }); await writeJson(this.indexPath, { discussions: list.filter((x) => x.id !== safe) }); return true; }
  async appendExchange(project, id, exchange) { const item = await this.get(project, id); if (!item) throw new Error("讨论不存在。"); item.messages = [...(item.messages ?? []), exchange]; item.updatedAt = new Date().toISOString(); await writeJson(join(this.root, `${item.id}.json`), item); const list = await this.ensure(project); await writeJson(this.indexPath, { discussions: list.map((x) => x.id === item.id ? { ...x, title: item.title, updatedAt: item.updatedAt } : x) }); return item; }
}

