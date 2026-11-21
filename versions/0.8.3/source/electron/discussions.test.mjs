import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscussionStore, titleFromQuestion } from "./discussions.mjs";

const projectId = "33333333-3333-4333-8333-333333333333";
const message = (role, content, extra = {}) => ({ id: `${role}-${content}`, role, content, createdAt: new Date().toISOString(), sources: [], ...extra });

async function setup({ legacy = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-discussions-"));
  let cleared = 0;
  const store = new DiscussionStore({
    projectRoot: () => root,
    legacyMessages: async () => legacy,
    clearLegacyMessages: async () => { cleared += 1; },
  });
  return { root, store, cleared: () => cleared };
}

test("标题取自第一个问题，过长时截断", () => {
  assert.equal(titleFromQuestion("  失败原因\n的定义有什么不同？ "), "失败原因 的定义有什么不同？");
  assert.equal(titleFromQuestion("一".repeat(30)), `${"一".repeat(24)}…`);
  assert.equal(titleFromQuestion(""), "新讨论");
});

test("旧版的单条对话迁移成第一个讨论，只迁移一次", async () => {
  const ctx = await setup({ legacy: [message("user", "失败原因的定义有什么不同？"), message("assistant", "两篇论文……", { scope: "analysis" })] });
  try {
    const list = await ctx.store.list(projectId);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "disc_001");
    assert.equal(list[0].title, "失败原因的定义有什么不同？");
    assert.equal(list[0].messageCount, 2);
    assert.equal(ctx.cleared(), 1);
    const discussion = await ctx.store.get(projectId, "disc_001");
    assert.equal(discussion.scope, "analysis");
    await ctx.store.list(projectId);
    assert.equal(ctx.cleared(), 1);
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("没有 project.json 里的旧对话时，从 Discussions/messages.json 迁移", async () => {
  const ctx = await setup();
  try {
    await mkdir(join(ctx.root, "Discussions"), { recursive: true });
    await writeFile(join(ctx.root, "Discussions", "messages.json"), JSON.stringify([message("user", "最小实验是什么"), message("assistant", "从 50 个样本开始")]));
    const list = await ctx.store.list(projectId);
    assert.equal(list[0].title, "最小实验是什么");
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("新建、发送、改名、删除；发送时记下引用范围，新讨论用第一个问题做标题", async () => {
  const ctx = await setup();
  try {
    assert.deepEqual(await ctx.store.list(projectId), []);
    const { discussion: empty } = await ctx.store.create(projectId);
    assert.equal(empty.id, "disc_001");
    const first = await ctx.store.appendExchange(projectId, empty.id, {
      userMessage: message("user", "MBPP 评测设置差异在哪？"), assistantMessage: message("assistant", "附录 C 是 3-shot"),
      paperIds: ["paper_001", "paper_001", "paper_002"], scope: "snippets",
    });
    assert.equal(first.discussion.title, "MBPP 评测设置差异在哪？");
    assert.deepEqual(first.discussion.paperIds, ["paper_001", "paper_002"]);
    assert.equal(first.discussion.scope, "snippets");

    const second = await ctx.store.appendExchange(projectId, null, {
      userMessage: message("user", "长上下文分块"), assistantMessage: message("assistant", "……"), paperIds: [], scope: "all",
    });
    assert.equal(second.discussion.id, "disc_002");
    assert.equal(second.discussion.scope, "analysis");
    assert.deepEqual(second.discussions.map((item) => item.id), ["disc_002", "disc_001"]);

    const renamed = await ctx.store.rename(projectId, "disc_001", "  评测 设置  ");
    assert.equal(renamed.discussions.find((item) => item.id === "disc_001").title, "评测 设置");
    await assert.rejects(ctx.store.rename(projectId, "disc_001", "  "), /不能为空/);

    const removed = await ctx.store.remove(projectId, "disc_002");
    assert.deepEqual(removed.discussions.map((item) => item.id), ["disc_001"]);
    await assert.rejects(ctx.store.get(projectId, "disc_002"), /不存在/);
    await assert.rejects(ctx.store.appendExchange(projectId, "disc_002", { userMessage: message("user", "x"), assistantMessage: message("assistant", "y") }), /已被删除/);
    await assert.rejects(ctx.store.get(projectId, "../x"), /编号无效/);
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("两个讨论同时发送时索引不会丢失任何一个", async () => {
  const ctx = await setup();
  try {
    const [a, b] = await Promise.all([
      ctx.store.appendExchange(projectId, null, { userMessage: message("user", "问题 A"), assistantMessage: message("assistant", "答 A") }),
      ctx.store.appendExchange(projectId, null, { userMessage: message("user", "问题 B"), assistantMessage: message("assistant", "答 B") }),
    ]);
    assert.notEqual(a.discussion.id, b.discussion.id);
    const index = JSON.parse(await readFile(join(ctx.root, "Discussions", "index.json"), "utf8"));
    assert.equal(index.length, 2);
    assert.deepEqual((await readdir(join(ctx.root, "Discussions"))).filter((name) => name.startsWith("disc_")).sort(), ["disc_001.json", "disc_002.json"]);
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});
