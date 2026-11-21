import { readFile, writeFile } from "node:fs/promises";
import { captureFixture, expect, fixture, launchFixture, test } from "./electron-fixture.mjs";

test("可打开应用迭代工作区和仓库设置", async ({ desktop }, info) => {
  expect(await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  await desktop.page.getByRole("button", { name: "应用迭代", exact: true }).click();
  await expect(desktop.page.getByRole("heading", { name: "自身", exact: true })).toBeVisible();
  await expect(desktop.page.getByRole("button", { name: "选择源码仓库" })).toBeVisible();
  await expect(desktop.page.getByRole("button", { name: "新建", exact: true })).toBeDisabled();
  await desktop.page.getByRole("button", { name: "迭代设置" }).click();
  await expect(desktop.page.getByRole("spinbutton", { name: "验证失败上限" })).toHaveValue("5");
  await captureFixture(desktop.app, info.outputPath("iteration-workspace.png"));
  const runtime = desktop.page.getByRole("combobox", { name: "迭代运行时" });
  const access = desktop.page.getByRole("combobox", { name: "Agent 权限" });
  await expect(runtime).toHaveValue("app-server");
  await expect(access).toHaveValue("full");
  await runtime.selectOption("sdk");
  await access.selectOption("restricted");
  await desktop.page.getByRole("region", { name: "应用迭代工作区" }).getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => desktop.page.evaluate(async () => (await window.autoresearch.iterationSnapshot()).runtime)).toBe("sdk");
  await expect.poll(() => desktop.page.evaluate(async () => (await window.autoresearch.iterationSnapshot()).access)).toBe("restricted");
});

test("示例课题包含两篇论文和失败的复现任务", async ({ desktop }, info) => {
  const workspace = await desktop.page.evaluate(() => window.autoresearch.loadWorkspace());
  const project = workspace.projects.find((project) => project.id === fixture.projectId);
  expect(project.papers).toHaveLength(2);
  const experiment = await desktop.page.evaluate(({ projectId, experimentId }) => window.autoresearch.getExperiment(projectId, experimentId), fixture);
  expect(experiment.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ name: fixture.failedJob, status: "failed", lastLine: fixture.failure })]));
  await desktop.page.getByRole("button", { name: "实验", exact: true }).click();
  await expect(desktop.page.getByText(fixture.experimentTitle, { exact: true }).first()).toBeVisible();
  await captureFixture(desktop.app, info.outputPath("fixture-experiment.png"));
});

test("预览和正式版可同时启动，数据参数覆盖已保存设置", async ({ desktop }, info) => {
  const settings = '{"workspacePath":"not-the-fixture","model":"original"}';
  await writeFile(desktop.settings, settings);
  const preview = await launchFixture(info, { preview: true, name: "preview", settings });
  try {
    await expect(preview.page.getByText("候选预览", { exact: true })).toBeVisible();
    await expect(preview.page.getByRole("button", { name: "应用迭代", exact: true })).toHaveCount(0);
    await expect(preview.page.evaluate(() => window.autoresearch.chooseWorkspace())).rejects.toThrow(/只能使用启动时指定的数据副本/);
    await expect(desktop.page.getByRole("button", { name: fixture.projectTitle })).toBeVisible();
    expect(await readFile(desktop.settings, "utf8")).toBe(settings);
  } finally { await preview.app.close(); }
});

test("待审阅页面按提交展示验证，保留预览和批准入口", async ({}, info) => {
  const sha = "2e51acc1e3bc0fed12345678900987654321abcde";
  const at = "2026-11-19T07:15:00.000Z";
  const task = {
    id: "review-fixture", number: 12, title: "改进失败任务的重试体验", description: "在任务卡展示失败原因。",
    criteria: "点击重试时，只重新运行所选任务。", status: "review", branch: "iterate/12-retry-failed-job", sha,
    base: "a".repeat(40), issueUrl: "https://github.com/example/test/issues/12", prUrl: "https://github.com/example/test/pull/31",
    freeze: { sha, hash: "b".repeat(40), at }, outbox: [],
    messages: [{ role: "agent", at, text: "已调整失败任务卡和单任务重试入口。" }],
    verifications: [{ id: 1, sha, startedAt: at, result: "success", screenshots: [], steps: [
      { name: "单元测试", command: "npm test", durationMs: 13200, exitCode: 0, logFile: "01.log" },
      { name: "构建", command: "npm run build", durationMs: 5100, exitCode: 0, logFile: "02.log" },
      { name: "验收场景测试", command: "playwright test", durationMs: 2200, exitCode: 0, logFile: "03.log" },
      { name: "全部场景测试", command: "npm run test:e2e", durationMs: 4200, exitCode: 0, logFile: "04.log" },
    ] }],
  };
  const desktop = await launchFixture(info, { iterationState: { binding: { path: process.cwd(), repository: "example/test", remote: "origin", main: "main" }, tasks: [task], retryLimit: 5 } });
  try {
    await desktop.page.getByRole("button", { name: "应用迭代", exact: true }).click();
    await desktop.page.getByRole("button", { name: "验证", exact: true }).click();
    await expect(desktop.page.getByText("验证 #1", { exact: true })).toBeVisible();
    await expect(desktop.page.getByRole("button", { name: "批准此提交" })).toBeDisabled();
    await expect(desktop.page.getByRole("button", { name: "自动验证已通过，去预览中试用后再批准" })).toBeVisible();
    await captureFixture(desktop.app, info.outputPath("iteration-review.png"));
    await desktop.page.getByRole("button", { name: "预览", exact: true }).click();
    await desktop.page.getByRole("radio", { name: "正式数据的临时快照" }).check();
    await expect(desktop.page.getByRole("button", { name: "打开预览" })).toBeDisabled();
    await desktop.page.getByRole("checkbox", { name: /我同意候选版读取并修改临时副本/ }).check();
    await expect(desktop.page.getByRole("button", { name: "打开预览" })).toBeEnabled();
    const trial = desktop.page.getByRole("region", { name: "人工试用" });
    await expect(trial.getByText("点击重试时，只重新运行所选任务。")).toBeVisible();
    await expect(trial.getByRole("button", { name: "提交试用结果" })).toBeDisabled();
  } finally { await desktop.app.close(); }
});

test("当前提交的人工试用通过后才能批准", async ({}, info) => {
  const sha = "3f62bdd2f4cd1fed12345678900987654321abcde";
  const at = "2026-11-20T03:00:00.000Z";
  const task = {
    id: "trial-fixture", number: 13, title: "失败任务显示日志摘要", description: "在任务卡展示失败原因。",
    criteria: "失败任务显示最后一行日志", status: "review", branch: "iterate/13-log-summary", sha,
    base: "a".repeat(40), prUrl: "https://github.com/example/test/pull/32", freeze: { sha, hash: "c".repeat(40), at }, outbox: [], messages: [],
    previews: [{ sha, startedAt: at, endedAt: at, realData: false }],
    trial: { sha, at, passed: true, note: "", preview: { startedAt: at, realData: false }, items: [{ criterion: "失败任务显示最后一行日志", result: "pass", note: "" }] },
    verifications: [{ id: 1, sha, startedAt: at, result: "success", screenshots: [], steps: [{ name: "构建", command: "npm run build", durationMs: 5100, exitCode: 0, logFile: "01.log" }] }],
  };
  const desktop = await launchFixture(info, { iterationState: { binding: { path: process.cwd(), repository: "example/test", remote: "origin", main: "main" }, tasks: [task], retryLimit: 5 } });
  try {
    await desktop.page.getByRole("button", { name: "应用迭代", exact: true }).click();
    await expect(desktop.page.getByRole("button", { name: "批准此提交" })).toBeEnabled();
    await desktop.page.getByRole("button", { name: "预览", exact: true }).click();
    await expect(desktop.page.getByText("当前提交的人工试用已通过")).toBeVisible();
  } finally { await desktop.app.close(); }
});
