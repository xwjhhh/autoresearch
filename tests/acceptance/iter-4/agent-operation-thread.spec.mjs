import { captureFixture, expect, launchFixture, test as base } from "../../e2e/electron-fixture.mjs";

const question = "这次调整完成了吗？";
const reply = "调整已完成，可以查看验证结果。";
const logStart = "开始 · 检查界面构建结果";
const logEnd = "结束（0） · 已输出完整构建日志";
const atMinute = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const task = {
  id: "operation-thread-fixture",
  title: "对话中查看执行进度",
  description: "调整应用迭代的对话界面。",
  status: "review",
  sha: null,
  base: null,
  outbox: [],
  messages: [
    { role: "user", text: question, at: atMinute(0) },
    { role: "agent", text: reply, at: atMinute(30) },
  ],
  events: [
    { kind: "agent", text: "开始 · 读取迭代需求", at: atMinute(1) },
    { kind: "agent", text: logStart, at: atMinute(2) },
    ...Array.from({ length: 20 }, (_entry, index) => ({
      kind: "agent", text: `结束（0） · 检查第 ${index + 1} 个界面文件`, at: atMinute(index + 3),
    })),
    { kind: "agent", text: Array.from({ length: 80 }, (_line, index) => `构建输出第 ${index + 1} 行`).join("\n"), at: atMinute(23) },
    { kind: "agent", text: logEnd, at: atMinute(24) },
  ],
  verifications: [],
};

const test = base.extend({
  conversation: async ({}, use, info) => {
    const { app, page } = await launchFixture(info, { iterationState: { binding: null, tasks: [task], retryLimit: 5 } });
    try {
      await page.getByRole("button", { name: "应用迭代", exact: true }).click();
      const workspace = page.getByRole("region", { name: "应用迭代工作区", exact: true });
      await expect(workspace.getByRole("heading", { name: task.title, exact: true })).toBeVisible();
      await use({
        app,
        questionMessage: workspace.getByText(question, { exact: true }),
        replyMessage: workspace.getByText(reply, { exact: true }),
        disclosure: workspace.getByRole("button", { name: /Agent 操作/ }),
        start: workspace.getByText(logStart, { exact: true }),
        end: workspace.getByText(logEnd, { exact: true }),
      });
    } finally { await app.close(); }
  },
});

test("连续的 Agent 操作默认折叠成一条摘要，前后的普通对话直接可见", async ({ conversation }, info) => {
  const { app, questionMessage, replyMessage, disclosure, end } = conversation;
  await expect(questionMessage).toBeInViewport();
  await captureFixture(app, info.outputPath("操作摘要.png"));
  await expect(replyMessage, "连续执行记录不应把后续回复挤出视口").toBeInViewport({ ratio: 1 });
  await expect(disclosure).toHaveCount(1);
  await expect(disclosure).toBeInViewport();
  await expect(end).toBeHidden();
});

test("Agent 操作可展开，长日志在半个窗口高度内独立滚动且可重新收起", async ({ conversation }, info) => {
  const { app, replyMessage, disclosure, start, end } = conversation;
  await captureFixture(app, info.outputPath("展开前的对话.png"));
  await expect(disclosure, "Agent 操作提供可展开的摘要入口").toBeVisible();
  await disclosure.click();
  await expect(start).toBeVisible();

  const scrollPanel = await start.evaluateHandle((log) => {
    for (let parent = log.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight && /^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) return parent;
    }
    return null;
  });
  const panel = scrollPanel.asElement();
  expect(panel, "展开的长日志应有独立滚动区域").not.toBeNull();
  const { panelHeight, viewportHeight } = await panel.evaluate((element) => ({ panelHeight: element.clientHeight, viewportHeight: window.innerHeight }));
  expect(panelHeight).toBeLessThanOrEqual(viewportHeight / 2);
  await panel.scrollIntoViewIfNeeded();
  await expect(end).not.toBeInViewport();
  const beforeScroll = await replyMessage.boundingBox();
  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(end).toBeInViewport({ ratio: 1 });
  const afterScroll = await replyMessage.boundingBox();
  expect(afterScroll.y, "滚动执行日志时，普通对话应留在原位").toBeCloseTo(beforeScroll.y, 0);
  await panel.dispose();
  await captureFixture(app, info.outputPath("展开并滚动到底部的操作日志.png"));

  await disclosure.click();
  await expect(end).toBeHidden();
  await expect(replyMessage).toBeInViewport({ ratio: 1 });
});
