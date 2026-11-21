import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { captureFixture, expect, fixture, launchFixture, test } from "./electron-fixture.mjs";

const sampleImage = (page) => page.evaluate(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 195;
  const context = canvas.getContext("2d");
  context.fillStyle = "#edf4ee";
  context.fillRect(0, 0, 320, 195);
  context.fillStyle = "#245b49";
  context.font = "20px sans-serif";
  context.fillText("验收样例", 30, 40);
  for (const [index, size] of [105, 146, 224].entries()) context.fillRect(30, 65 + index * 35, size, 16);
  return canvas.toDataURL("image/png").split(",")[1];
});

test("迭代对话可添加文件夹和粘贴图片，附件单独发送后仍在历史中", async ({}, info) => {
  const task = { id: "attachment-draft", title: "调整文献预览", description: "提高预览可读性。", status: "draft", messages: [], verifications: [], outbox: [] };
  const desktop = await launchFixture(info, { iterationState: { binding: null, tasks: [task], retryLimit: 5 } });
  try {
    const folder = info.outputPath("示例资料");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "说明.json"), '{"zoom":150}');
    await desktop.app.evaluate(({ dialog }, selectedFolder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedFolder] });
    }, folder);
    await desktop.page.getByRole("button", { name: "应用迭代", exact: true }).click();
    const composer = desktop.page.locator(".ar-chat-compose");
    await composer.getByRole("button", { name: "添加附件", exact: true }).click();
    await expect(composer.getByRole("button", { name: "添加文件", exact: true })).toBeVisible();
    await composer.getByRole("button", { name: "添加文件夹", exact: true }).click();
    await expect(composer.getByRole("button", { name: /查看附件 .*说明.json/ })).toBeVisible();

    const field = composer.getByRole("textbox", { name: "发给 Agent 的意见" });
    await field.evaluate((node, encoded) => {
      const clipboardData = new DataTransfer();
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      clipboardData.items.add(new File([bytes], "截图.png", { type: "image/png" }));
      node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    }, await sampleImage(desktop.page));
    await expect(composer.getByRole("img", { name: "截图.png" })).toBeVisible();
    await composer.getByRole("button", { name: "查看附件 截图.png" }).click();
    await expect(desktop.page.getByRole("dialog", { name: "截图.png" })).toBeVisible();
    await desktop.page.getByRole("button", { name: "关闭图片" }).click();
    await expect(desktop.page.getByRole("dialog", { name: "截图.png" })).toBeHidden();
    await composer.getByRole("textbox", { name: "发给 Agent 的意见" }).focus();
    await captureFixture(desktop.app, info.outputPath("iteration-attachments.png"));
    await composer.getByRole("button", { name: "发送消息" }).click();
    await expect(desktop.page.locator(".iter-thread").getByRole("button", { name: "查看附件 截图.png" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "发送消息" })).toBeDisabled();
    const saved = await desktop.page.evaluate(async () => (await window.autoresearch.iterationSnapshot()).tasks[0].messages.at(-1).attachments);
    expect(saved.map(({ name }) => name)).toEqual(["示例资料/说明.json", "截图.png"]);
    expect(saved.every((item) => !Object.hasOwn(item, "path"))).toBe(true);
  } finally { await desktop.app.close(); }
});

test("讨论把拖进来的文件和图片交给模型，并保存附件记录", async ({ desktop }, info) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "已收到表格和截图。" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    await desktop.page.evaluate(async (url) => {
      const api = window.autoresearch;
      const state = await api.saveLlmProvider({ name: "本地附件测试", preset: "custom", baseUrl: url, protocols: ["chat"], models: ["fixture-chat"] });
      await api.selectLlmModel("active", state.providers.find((provider) => provider.name === "本地附件测试").id, "fixture-chat");
    }, baseUrl);
    await desktop.page.getByRole("button", { name: "研究讨论", exact: true }).click();
    const composer = desktop.page.locator(".ar-chat-compose");
    await composer.evaluate((node, encoded) => {
      const dataTransfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      dataTransfer.items.add(new File([bytes], "结果.png", { type: "image/png" }));
      dataTransfer.items.add(new File(["metric,value\naccuracy,0.91\n"], "结果.csv", { type: "text/csv" }));
      dataTransfer.items.add(new File(["removed"], "移除我.txt"));
      node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    }, await sampleImage(desktop.page));
    await composer.getByRole("button", { name: "移除附件 移除我.txt" }).click();
    await composer.getByRole("textbox", { name: "研究问题" }).fill("对照截图和表格。");
    await captureFixture(desktop.app, info.outputPath("discussion-attachments.png"));
    await composer.getByRole("button", { name: "发送消息" }).click();
    await expect(desktop.page.getByText("已收到表格和截图。", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    const sent = requests[0].messages.at(-1).content;
    expect(sent.some((part) => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,"))).toBe(true);
    expect(sent.some((part) => part.text?.includes("accuracy,0.91"))).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("移除我.txt");
    const persisted = await desktop.page.evaluate((projectId) => window.autoresearch.getDiscussion({ projectId, discussionId: "disc_001" }), fixture.projectId);
    expect(persisted.messages[0].attachments.map(({ name }) => name)).toEqual(["结果.png", "结果.csv"]);
    await composer.getByRole("textbox", { name: "研究问题" }).fill("刚才的数据是多少？");
    await composer.getByRole("textbox", { name: "研究问题" }).press("Enter");
    await expect.poll(() => requests.length).toBe(2);
    expect(JSON.stringify(requests[1].messages.at(-1).content)).toContain("accuracy,0.91");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
