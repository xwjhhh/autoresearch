---
name: write-acceptance-test
description: 把 AutoResearch 应用迭代任务的验收条件写成测试（tests/acceptance/iter-N/）。在验收阶段、或需要为某个需求写 Playwright 场景测试和单元测试时使用。
---

# 编写验收测试

验收测试一旦确认就会冻结，实现阶段改不了。所以这一步决定了整个任务最后交付的是不是用户想要的东西。

## 1. 把验收条件拆成测试

- 每条验收条件对应一个 `test(...)`，**测试名直接用验收条件的原文**（去掉列表符号）。人工试用页也按同样的条目列出，名称一致便于对照。
- 界面上看得见的行为写成 Playwright 场景（`.spec.mjs`）。纯逻辑、数据格式、主进程服务写成单元测试（`.test.mjs`）。一个条件两边都能测时，优先场景测试。
- 条件写得含糊（比如"更好用""更快"）时，挑一个能客观判断的具体表现来测，并在总结里写明你是怎么理解的。

## 2. 场景测试模板

```js
import { captureFixture, expect, fixture, launchFixture, test } from "../../e2e/electron-fixture.mjs";

test("<验收条件原文>", async ({ desktop }, info) => {
  const { page } = desktop;
  await page.getByRole("button", { name: fixture.projectTitle }).click();
  // 操作：按用户会做的步骤点击、输入
  await page.getByRole("button", { name: "某个按钮", exact: true }).click();
  // 断言：用户能看到的结果
  await expect(page.getByRole("heading", { name: "期望的标题", exact: true })).toBeVisible();
  // 需要核对后端状态时直接调 API
  await expect.poll(() => page.evaluate(async () => (await window.autoresearch.loadWorkspace()).projects.length)).toBe(1);
  await captureFixture(desktop.app, info.outputPath("<条件简称>.png"));
});
```

- 引用路径：验收目录在 `tests/acceptance/iter-N/`，辅助文件在 `tests/e2e/`，所以是 `../../e2e/electron-fixture.mjs`。有子目录时相应加 `../`。
- 每个场景至少截一张图，人工审阅和你自己检查界面都要用。
- 定位：`getByRole` + 中文名 + `exact: true`。不要依赖 CSS 类名、`nth`、元素顺序。
- 等待：用 `expect(...).toBeVisible()`、`toHaveValue`、`expect.poll`。不要用 `waitForTimeout`。
- 单个测试超时 45 秒。

## 3. 需要特殊数据或设置

示例数据和启动辅助文件是冻结的，改不了。需要别的数据时自己准备：

```js
test("<条件>", async ({}, info) => {
  const desktop = await launchFixture(info, {
    settings: JSON.stringify({ /* settings.json 内容 */ }),
    iterationState: { /* userData/iterations/state.json 内容 */ },
    // 或者：先往 info.outputPath("data") 里写好文件，再传 data: info.outputPath("data")
  });
  try { /* ... */ } finally { await desktop.app.close(); }
});
```

示例数据用 `wx` 写入，已经存在的文件不会被覆盖，所以事先写好的文件会保留。

## 4. 单元测试模板

```js
import assert from "node:assert/strict";
import test from "node:test";
import { someFunction } from "../../../electron/some-module.mjs";

test("<验收条件原文>", async () => {
  assert.equal(await someFunction(input), expected);
});
```

如果要测的函数还不存在，按你预期的名字和参数写，实现阶段照着实现。在总结里列出这些接口约定。

## 5. 确认测试会失败

```
node scripts/iteration-check.mjs tests/acceptance/iter-N --expect-fail
```

- 必须失败，而且失败原因要是"功能还没做"：找不到新按钮、断言值不符、函数不存在。
- 如果是语法错误、导入路径写错、选择器拼错导致的失败，这不算数，要修好再跑。
- 如果全部通过，说明测试没测到新需求，要改。
- 在总结里写一句：每个测试现在是因为什么失败的。
