---
name: check-ui-change
description: 改了 AutoResearch 的界面（src/ 下的组件或样式）之后，用截图亲眼确认效果。在实现阶段改动界面、或用户反馈"界面不对""看不到"时使用。
---

# 检查界面改动

测试通过不代表界面看起来对：元素可能被挡住、挤成一团、文字溢出。改了界面就要看截图。

## 1. 生成截图

```
node scripts/iteration-check.mjs tests/acceptance/iter-N
```

脚本最后会列出所有场景截图的绝对路径。用查看图片的工具（view_image）逐张打开。

## 2. 对照检查

逐条看：

- 验收条件描述的东西是否真的出现在画面里，位置是否合理。
- 文字有没有被截断、重叠、溢出容器。
- 新加的元素和周围元素的间距、字号、颜色是否一致（参考同页面已有的按钮、标题）。
- 空状态、加载中、出错时的提示是否合理（如果测试覆盖到了）。
- 窄窗口下是否还能用（如果改动涉及布局）。

## 3. 需要额外截图

验收测试冻结了，不能往里加截图。要看别的状态时，临时写一个场景：

1. 新建 `tests/scratch-iter-N/look.spec.mjs`，按 `write-acceptance-test` 技能的模板操作到想看的状态，然后 `captureFixture`。
2. 运行：`node node_modules/playwright/cli.js test --config playwright.config.mjs tests/scratch-iter-N/`（先 `npm run build`）。
3. 截图在 Playwright 输出目录（`test-results/` 或 `AUTORESEARCH_E2E_OUTPUT` 指定的目录）。
4. **看完删掉 `tests/scratch-iter-N/` 和 `test-results/`**，用 `git status` 确认没有残留，否则会被平台一起提交。

## 4. 样式改动的位置

- 页面样式在 `src/screens/<页面>/screen.css`，沿用已有的类名前缀和变量。
- 不要为了一个页面去改全局样式。
