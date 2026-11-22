# 项目约定

## Application self-updates

- Do not download, install, stage, repair, or update Codex or ChatGPT application packages, or re-enable their automatic updaters, unless the user explicitly authorizes that specific application update. This requirement does not restrict installation of other software or dependencies.

## 发布和版本归档

- 所有 AutoResearch 发布物统一放在 `versions/`。正式版本使用 `versions/<版本号>/`，沿用 `source/`、`windows/`、`version.json`；版本说明放 `docs/`，源码压缩包和阅读包放 `packages/`。
- 唯一临时构建目录为 `versions/.build/windows/`。不要再新建根目录 `release*`、`*-staging` 或在根目录散放带版本号的安装包、压缩包和修复说明。
- 新版本运行 `npm run dist:win`，自动校验并归档。用户授权同版本重发时运行 `npm run dist:win:replace`；旧构建保存在该版本的 `history/`，不得静默删除或覆盖历史。
- 给用户的安装包路径必须是 `versions/<版本号>/windows/` 中的最终文件，不是临时目录。发布前核对版本号、安装包校验和、包内运行代码与源码一致，以及 `version.json`、`versions/latest.json`。
- 源码快照用明确的文件清单，禁止复制整个工作目录；`data/`、课题环境、论文实验、聊天记录、凭据和 `node_modules/` 都不能进入源码归档。不要为整理发布物停止研究任务或修改实验数据。

详细规则见 `versions/README.md`。

## 代码结构

| 位置 | 内容 |
| --- | --- |
| `electron/main.mjs` | 主进程入口：窗口、各服务的创建、全部 `ipcMain.handle` 注册 |
| `electron/preload.cjs` | 渲染进程能调用的 API，全部挂在 `window.autoresearch` 上 |
| `electron/*.mjs` | 各服务的实现（应用迭代在 `iterations.mjs`、`iteration-*.mjs`，Codex 接入在 `codex-*.mjs`） |
| `src/app/App.tsx` | 侧栏和页面切换 |
| `src/types.ts` | `window.autoresearch` 的类型声明 |
| `src/screens/<页面>/` | 各页面的组件、类型（`model.ts`）和样式（`screen.css`） |
| `tests/e2e/` | Playwright 场景测试和 Electron 启动辅助（`electron-fixture.mjs`） |
| `tests/acceptance/iter-<编号>/` | 每个应用迭代任务的验收测试 |
| `scripts/` | 测试入口、示例数据（`iteration-fixture.mjs`）、迭代自检（`iteration-check.mjs`） |

给界面加一个新的后端能力，通常要依次改四处：`main.mjs` 注册 `ipcMain.handle` → `preload.cjs` 暴露方法 → `src/types.ts` 声明类型 → 页面组件里调用。详细步骤见技能 `add-ipc-api`。

## 常用命令

所有命令在仓库根目录执行，Windows 和 Linux 通用。

| 目的 | 命令 |
| --- | --- |
| 类型检查 + 构建界面 | `npm run build` |
| 全部单元测试 | `npm test` |
| 单个单元测试文件 | `node --test electron/iterations.test.mjs` |
| 全部场景测试 | `npm run test:e2e`（先 `npm run build`） |
| 单个场景文件 | `node node_modules/playwright/cli.js test --config playwright.config.mjs tests/e2e/iteration.spec.mjs` |
| 迭代任务快速自检 | `node scripts/iteration-check.mjs tests/acceptance/iter-<编号>`（`--expect-fail` 验收阶段用，`--skip-build` 跳过构建，`--all` 跑全部场景） |

## 测试约定

- 单元测试用 `node:test` 和 `node:assert/strict`，文件以 `.test.mjs` 结尾。平台只收集 `electron/`、`scripts/` 顶层的 `.test.mjs`，以及 `tests/acceptance/` 下任意深度的 `.test.mjs`；放在 `electron/` 子目录里的测试不会被运行。
- 场景测试用 Playwright 驱动 Electron，文件以 `.spec.mjs` 或 `.spec.ts` 结尾，放在 `tests/` 下。串行运行（`workers: 1`），单个测试 45 秒超时。
- 场景测试加载的是 `dist/` 里的构建产物。改了 `src/` 之后不重新 `npm run build`，看到的是旧界面。
- 场景测试从 `tests/e2e/electron-fixture.mjs` 引入 `test`、`expect`、`fixture`、`launchFixture`、`captureFixture`。`test` 自带 `desktop` 夹具：`{ app, page, profile, data, settings }`，窗口隐藏运行。
- 示例数据由 `scripts/iteration-fixture.mjs` 生成：课题「迭代测试示例课题」，两篇论文，一个实验 `exp_001`，其中有一个失败的任务。常量在 `fixture` 对象里，测试里用常量，不要手写字符串。
- 定位元素优先用 `getByRole(角色, { name: "中文名", exact: true })`，其次 `getByText`；不要用 CSS 类名或 `nth`。等待用 `expect(...).toBeVisible()` 和 `expect.poll`，不要 `waitForTimeout`。
- 需要检查后端状态时，用 `page.evaluate(() => window.autoresearch.xxx())` 直接调 API。
- 截图用 `captureFixture(desktop.app, info.outputPath("名字.png"))`。

## 写代码的习惯

- 主进程代码是 ESM（`.mjs`），渲染进程是 React + TypeScript。沿用周围代码的紧凑写法，不要引入新的格式风格。
- 界面文字、错误信息、测试名称都用中文。
- 尽量不加新依赖。改了 `package-lock.json`，平台验证会重新 `npm ci`，明显变慢。
- 命令和脚本要在 Windows 上能跑：用 Node 脚本，不写 bash 专用语法。

## 应用迭代任务

你在应用迭代任务里工作时：

1. 不要 `git commit`、`push` 或操作 GitHub，平台会做。
2. 验收阶段只改 `tests/acceptance/iter-<编号>/`。写法见技能 `write-acceptance-test`。写完运行 `node scripts/iteration-check.mjs <目录> --expect-fail`，确认新测试在功能实现前会失败。
3. 实现阶段不能改冻结路径：本任务的验收目录、`tests/e2e/electron-fixture.mjs`、`scripts/iteration-fixture.mjs`、`playwright.config.mjs`。结束前运行 `node scripts/iteration-check.mjs <目录>` 直到通过。改了界面按技能 `check-ui-change` 看截图。
4. 平台验证失败时，提示里会给出失败步骤和完整日志目录，按技能 `fix-validation-failure` 处理。
5. 收尾时用 `git status` 确认没有留下临时文件。
6. 这轮踩到以后值得记住的坑，在下面「经验记录」末尾追加一条。只记以后会再遇到的，不记一次性的细节。

## 经验记录

格式：`- [#任务编号] 现象 → 原因 → 以后怎么做`。新条目追加在末尾；过时的条目直接删掉。

- [初始] 场景测试看到的还是旧界面 → 场景测试加载 `dist/`，改 `src/` 后没重新构建 → 用 `iteration-check.mjs`（默认会构建），或先 `npm run build`。
- [初始] 验收测试需要示例数据里没有的内容 → `scripts/iteration-fixture.mjs` 对每个任务都是冻结的，改不了 → 在验收测试里自己准备：用 `launchFixture` 的 `settings`、`iterationState` 参数；或先在 `info.outputPath(...)` 目录里写好文件，再 `launchFixture(info, { data: 该目录 })`。示例数据用 `wx` 写入，不会覆盖你事先写好的文件。
- [初始] 新写的单元测试没有被运行 → 放在了 `electron/` 的子目录 → 放到 `electron/` 顶层，或放进本任务的验收目录。
- [#2] 隐藏窗口通过 BrowserWindow.capturePage 截到旧帧 → 渲染器已更新但隐藏窗口截图仍显示前一帧 → 验证动态界面时等待状态稳定，并用 Playwright 的 page.screenshot 核对当前画面。
- [#4] Windows 修改后差异显示全文件重写 → 工作区换行变成 CRLF，索引使用 LF → 用 `git ls-files --eol` 核对，仅恢复本轮改动文件的原有换行，再跑 `git diff --check`。
