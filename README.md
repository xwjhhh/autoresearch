# AutoResearch Desktop

AutoResearch Desktop 是一个本地优先的研究工作区，用于管理课题、导入和分析论文、开展研究讨论、整理和筛选研究 Idea，以及在独立工作目录中复现实验。当前版本为 **0.8.3**。

## 0.8.3 更新

- 应用迭代接入 Codex App Server，支持原生审批、实时事件和中断，并加入人工试用、回退及本地更新流程。
- 实验、文献分析和研究讨论共用聊天输入区，支持添加文件、文件夹、拖拽文件和粘贴图片。
- Codex CLI/App Server 上游源码固定在 `codex/`，快照对应 `rust-v0.162.0-alpha.17.2`，并保留 Apache-2.0 许可证与 NOTICE。它不是 Codex 桌面应用的界面源码，也不会自动替换 AutoResearch 当前使用的 Codex；构建要求、平台限制和 `CODEX_CLI_PATH` 用法见 `codex/UPSTREAM.md`。

## 0.7.1 更新

0.7.1 增加模型服务商管理，可配置 OpenAI、DeepSeek 和兼容服务，并分别切换分析/讨论模型与 Agent 模型；Agent 可使用应用内配置的 Responses 服务商。实验工作流增加方案设计、预算执行、结论归档和代码差异查看。Windows 安装包不再附带 Codex CLI。

本次更新只修改源码和版本元数据，不迁移、清空或重建研究数据。当前课题的数据目录仍由工作区设置决定；实验会话记录继续保存在课题目录下的 `Experiments/PaperReproductions/exp_NNN/experiment.json`、`events.jsonl`、`workspace/REPRO.md` 和对应工作区文件中。

## 项目结构规则

1. 每个主界面必须有自己的目录，统一放在 `src/screens/<screen-name>/`。该目录负责主界面入口、仅供本界面使用的子组件和 `screen.css`；不要把多个界面的界面代码或样式堆进同一个文件。
2. 被两个或更多界面复用的 UI 组件放在 `src/components/`。界面目录之间不得直接引用对方的内部组件；需要复用时先提取到 `src/components/`。
3. `src/app/App.tsx` 只负责应用外壳、导航、全局状态协调和页面装配。界面专属的展示与交互留在对应的 `src/screens/` 目录。
4. `src/styles/global.css` 只放设计变量、浏览器重置、应用外壳和真正跨界面共用的基础样式。单个界面的样式放在该界面的 `screen.css`。
5. 项目根目录保留当前 AutoResearch Desktop 的源码和构建配置。正式安装包、版本源码快照、版本 ZIP 和修复说明统一放在 `versions/<版本号>/`；临时构建统一放在 `versions/.build/windows/`。同版本旧构建归入该版本 `history/`，不散放在根目录。清理其他内容前先确认运行、构建、测试和研究数据依赖。

新增或修改界面前，先确定它所属的主界面目录；跨界面复用时先提取公共组件。删除功能或旧版本前，先确认没有运行、构建、测试或用户数据路径依赖。

## 主界面目录

| 主界面 | 目录 | 入口/主要文件 |
| --- | --- | --- |
| 课题概览 | `src/screens/overview/` | `OverviewView.tsx` |
| 文献分析 | `src/screens/paper-analysis/` | `PaperAnalysisPage.tsx`、`PaperAnalysisWorkspace.tsx` |
| 研究讨论 | `src/screens/research-discussion/` | `DiscussionView.tsx` |
| Idea 池 | `src/screens/idea-pool/` | `IdeaPoolView.tsx`、`IdeaModal.tsx` |
| 实验复现 | `src/screens/experiments/` | `ExperimentView.tsx`、`TerminalDock.tsx`、`logScreen.ts` |
| 运行环境 | `src/screens/project-environment/` | `ProjectEnvironmentView.tsx`、`model.ts` |
| 研究笔记 | `src/screens/research-notes/` | `ResearchNotesView.tsx` |
| 课题文件 | `src/screens/project-files/` | `ProjectFilesView.tsx` |

跨界面组件位于 `src/components/`；应用级导航和页面协调位于 `src/app/`；Electron 主进程、预加载层和本地研究服务位于 `electron/`。研究项目数据保存在用户选择的数据目录，不放在源码目录中。

## 开发与验证

需要 Windows 10 或更新版本、Node.js 20.19+ 和 npm。

```powershell
npm ci
npm test
npm run build
npm run dist:win
```

`npm start` 启动已构建的开发版。发布新版本时，先运行 `npm version <新版本号> --no-git-tag-version`，再运行 `npm run dist:win`；构建会把源码快照和完整 Windows 应用归档到 `versions/<版本号>/`。归档前检查版本一致和包内代码，默认拒绝覆盖已有版本。研究者授权同版本重发时用 `npm run dist:win:replace`，旧构建保存在该版本 `history/`。唯一临时构建位置是 `versions/.build/windows/`，最近发布位置记录在 `versions/latest.json`；详细规则见 `versions/README.md`。界面显示的版本号会从 `package.json` 自动读取。

## 应用迭代 V1

左侧栏的「应用迭代」独立于课题。左列保留当前任务与历史任务，右侧展示任务对话、逐文件差异、按提交查看的验证历史和候选预览。顶部「迭代设置」用于绑定仓库和调整自动修复次数。

| 环节 | 集成方式 |
| --- | --- |
| 仓库与基线 | 主进程检查 GitHub 写权限和 Issue 配置并补齐标签。构建记录 Git 提交和源码是否包含未提交改动。源码目录有未提交改动时，新建任务须显式选择基线。 |
| 任务与验收 | 平台创建 Issue 和独立 worktree；验收确认冻结该任务的测试及 Playwright 配置、示例数据和 Electron 启动辅助文件。旧版未完成任务须重新确认验收。 |
| 实现与验证 | 对话实时显示 Agent 命令、文件改动和验证步骤。验证在后台运行，每类测试只跑一次，同时覆盖历次验收。锁文件匹配时复制本地依赖，不共享可写目录；不匹配时用缓存优先安装。 |
| 审阅与预览 | 候选版使用独立 profile，默认读写合成示例数据。可确认复制正式数据的临时快照；跳过链接、常见实验环境、产物和凭据文件，关闭候选版后清理。不会复制已配置的模型密钥。 |
| 人工试用 | 自动验证通过后，打开当前提交的预览，按验收条件逐条填写试用结果。未通过的项目须写明实际现象，平台将其带入 Agent 的返工意见。试用结果同步到 PR，提交变化后须重新试用。 |
| 批准与合并 | 批准绑定候选提交、成功验证和全部通过的人工试用。同一提交可复用结果，提交变更后重新验证、试用并批准。平台记录匹配 PR head 的 squash 回执；没有回执的远程合并标记为异常并留言。 |
| 更新与回退 | 从当前绑定源码运行时，主线干净且可快进才能「更新并重启」。锁文件变更时重装依赖，保留旧 `dist`；构建失败自动尝试恢复。安装版和绑定其他仓库时不自动生效。「回退这次合并」创建新的验收、验证和批准任务，不直接修改远程主线。 |
| 恢复与记录 | 本地状态、待发 GitHub 记录、完整会话和验证产物保存在 `userData/iterations/`。网络恢复后选择「同步 GitHub」。中断的验证可在重启后重跑。 |

使用 `npm run build` 和 `npm start` 打开开发版。首次迭代的基线须包含本次新增的 Playwright 和示例数据底座。真实 GitHub 流程需要用 `gh auth login --hostname github.com --git-protocol https --web` 登录有写权限的账号，并在仓库启用 Issues 和 squash 合并。Agent 使用顶栏选定的 Agent 模型与本机 Codex CLI。

### Codex App Server

「应用迭代」默认从本机已安装的 Codex 中选择支持 App Server stdio 的可执行文件。若机器上有多个版本，可在启动 AutoResearch 前将 `AUTORESEARCH_CODEX_PATH` 指向要用的原生 CLI 可执行文件。「迭代设置 → 迭代运行时」可切换至旧 SDK，两个运行时各自保存续接 ID。实验和论文 Agent 本版仍使用 SDK。

Agent 的输出和操作会显示在对话页。「停止」通过协议中断当前回合。Codex 发出的命令、文件改动、网络和附加权限请求由你在审批卡决定。命令和补丁可允许一次，附加权限可允许到当前回合结束。平台在迭代流程中独立检查验收冻结和合并批准。

「迭代设置 → Agent 权限」默认是「完全」。Codex 以当前系统用户权限运行，可以直接执行命令和联网。App Server 在此次进程内信任工作树和主仓库，启用钩子与子智能体，并读取用户配置的 MCP。切换到「受限」后，App Server 使用工作区写入沙箱，额外的网络和目录访问由审批卡处理。两种模式下，平台都检查验收冻结、人工试用和合并批准。

迭代 Agent 读取仓库里的 `AGENTS.md` 和 `.agents/skills/`。实现阶段运行 `node scripts/iteration-check.mjs tests/acceptance/iter-<编号>` 可快速自检。验收阶段加 `--expect-fail` 检查测试是否在实现前失败，并核对失败原因是否对应验收条件。可复用的经验记录在 `AGENTS.md`，随任务差异一起审阅。

更换本机 Codex 后，可运行 `npm run test:codex-protocol` 检查实际选中的可执行文件及其版本。测试用临时 Codex 配置和本地模拟 Responses 服务验证协议类型、创建、续接、流式输出、原生审批与中断。

本地更新备份位于仓库 Git 目录的 `autoresearch-update-*`，`update.json` 记录原提交、目标提交和依赖是否更改。Windows 上如果要替换依赖，更新器会等 App 退出、解除 Electron 文件锁后再安装和构建；日志在同一 Git 目录的 `autoresearch-restart-*/helper.log`。新构建能启动时可点「恢复上次本地构建」；如无法启动，先退出 AutoResearch、核对工作树干净，再按备份记录恢复原提交和旧 `dist`（如存在旧 `node_modules` 备份则一起恢复）。本地恢复不会撤销 GitHub 合并。

使用 `npm run test:e2e` 运行合成课题场景。启动参数 `--profile <绝对路径>` 指定独立设置目录，`--data-dir <绝对路径>` 覆盖该 profile 的数据目录。

## 数据与模型

应用迭代、研究讨论、论文 Codex 和实验会话的输入框支持添加文件、文件夹、拖拽和粘贴图片。每个文件最多 25 MB，每条消息最多 50 个文件、合计 100 MB。附件副本和图片预览保存在本机，应用迭代的附件不随 Issue 或 PR 上传。Codex 会话可读取本地附件并直接接收图片。研究讨论发送到当前模型，文档和图片的读取能力由模型接口决定。

在本项目开发版和项目目录内的版本包中，默认研究数据位于 `desktop-app/data/Projects/`；每个课题目录使用“课题名称--课题ID”，例如 `RSI--de47d4d6-639b-4050-82df-2c77d0ed7d52`。课题 ID 保存在 `project.json` 中，作为稳定身份；目录名称会清理 Windows 不允许的字符，并随课题改名更新。应用启动恢复后，会在没有活动任务时把旧版纯 UUID 目录原位迁移；任务运行期间会延后迁移。从项目外安装运行且找不到项目根目录时，默认回退到 `%USERPROFILE%\Documents\AutoResearch`。可在应用的“模型与数据设置”中切换目录。`data/` 是本机数据目录，不进入源码快照。应用可使用当前 Codex 配置或手动兼容接口；凭据由 Electron 主进程处理，不应写入源码、README、测试输出或提交的项目文件。

PDF 文本在本地解析；扫描版 PDF 不会自动 OCR。文献检索、模型判断和 Idea 新颖性检查均需研究者核对。批量 Idea 流程支持分批生成、去重、筛选、提案展开、可行性检查和排序，并将可恢复进度保存到项目数据目录。

## 实验复现

一个实验对应一个独立工作目录和一个持续的 Codex 会话。在“实验复现”里选择已解析论文，填写复现目标和可选代码地址，即可开始。平台负责工作目录、对话记录、后台任务和结果回传；具体的代码、环境、数据集与评测步骤由 agent 根据论文和仓库确定。

1. 创建工作目录，写入带页码的 `paper/paper.md`、原 PDF（如有）、讲解稿（如有）、`AGENTS.md` 和 `REPRO.md`。
2. agent 以 `workspace-write`、不申请提升权限的模式运行。联网开关控制下一轮 agent 的网络和网页搜索。命令、文件改动及消息写入 `events.jsonl`。
3. 长任务通过 `node .ar/run.mjs <名字> -- "<命令>"` 提交。这个帮助脚本只写请求文件；新实验默认开启“后台任务自动运行”，已确认范围内不再逐项确认；关闭后通过任务卡确认。打开开关时，现有待运行任务也会启动（等待作答或已停止时保持暂停）。Windows 使用 PowerShell 执行，输出写入 `.ar/logs/`。
4. 任务结束后，平台将退出码和日志末尾交回同一 Codex 会话。新实验默认开启“持续接续”：成功结果到达后继续下一步，不因累计八次而停；连续八次接续没有成功的后台任务结果时暂停，发新消息后重置。关闭后仍采用累计八次暂停。旧实验保留原有设置，需在顶栏自行开启这两个开关。失败或中断时，尚未送达的通知会保留。每轮动态注入当前执行规则，已有授权持续有效，短检查和同一目的的命令修正无需重复提问；改变模型、预算、范围及共享环境依赖仍需确认。

界面中央展示对话、可折叠的命令和文件改动，以及带“开始运行 / 不运行 / 停止”的任务卡。任务卡显示最新输出，点击“在终端查看”切换到对应日志。右栏提供“复现记录 / 后台任务 / 文件”；复现记录可直接编辑。每个实验的 `AGENTS.md` 可独立修改，下一轮会重新读取。

底部终端横跨对话区和右栏，可折叠并拖动上边缘调整高度。每个后台任务一个标签页，开始运行时自动展开并选中任务；折叠时保留运行状态与最新一行输出。日志每秒按字节偏移增量读取，首次只加载末尾 512KB，支持 UTF-8、常见 ANSI 颜色与加粗、tqdm 回车覆盖、查找、复制已加载输出、打开完整日志和停止任务。向上翻看会暂停跟随，点击“回到最新”恢复。它是日志终端，不是完整的交互式终端模拟器。

“Agent 命令”标签页展示正在执行的短命令和最近 20 条已结束命令。实时输出依赖 Codex CLI 是否发送命令更新事件；如果没有更新事件，会先显示命令和计时，结束后再展示输出。平台对实时命令推送按 400ms 节流。

“手动运行”把你输入的命令直接交给同一后台执行器，不再二次确认，结果和日志会保留。默认不会自动唤醒 agent，结果附在下一条消息中；勾选“结束后交给 agent”才会自动回传并按既有唤醒规则处理。Agent 提交的请求仍遵循“后台任务自动运行”设置，不能通过请求文件伪造手动来源绕过确认。非交互 shell 中请使用 `conda run -n 环境名 命令`，不要依赖 `conda activate`。

“打开 PowerShell”在实验工作目录打开独立系统窗口，打开位置必须位于实验目录内。窗口里的手动操作独立于平台，不会自动变成后台任务，也不会自动记录和回传结果；需要这些能力时使用“手动运行”。

## 课题运行环境

每个课题 ID 最多绑定一个独立 Conda 环境，默认创建在 `Environments/<project-id>/conda/`；环境清单和依赖修订保存在 `Environments/<project-id>/environment.json`。也可以绑定现有环境；同一个环境不能绑定给多个课题。切换论文复现或自主实验时，短命令、后台任务与实验 PowerShell 都使用课题环境，不为单个实验创建 `.venv`。未配置环境时，实验 agent、后台任务和实验终端不能执行。

Agent 缺少依赖时提交申请。平台先解析实际安装计划，再由研究者确认；安装完成后保存依赖快照并检查兼容性。实验或终端使用环境期间，环境变更和重新绑定会锁定。创建、绑定或更新环境都只在研究者从“运行环境”明确提交后进行。

每个课题的实验按目的分开，位于 `Projects/<课题名称>--<project-id>/Experiments/`：

```text
PaperReproductions/       论文复现实验；当前“实验复现”功能在这里创建和运行实验
  exp_NNN/
DesignedExperiments/      自主设计实验的独立存放目录；当前尚未接入单独的界面和运行流程
```

论文复现实验的目录内容如下：

```text
PaperReproductions/exp_NNN/
experiment.json   实验设置、Codex 会话编号、状态与未送达通知
events.jsonl      用户消息、agent 消息、命令、文件改动及任务事件
jobs/             后台任务记录、执行说明和退出状态
job-runner.mjs    独立任务运行脚本
workspace/
  AGENTS.md       本实验常驻说明
  REPRO.md        复现记录
  paper/          论文全文、PDF 与可用讲解稿
  .ar/run.mjs     长任务提交工具
  .ar/requests/   待接收的任务请求
  .ar/logs/       后台任务日志
```

旧版本直接放在 `Experiments/exp_NNN/` 的记录仍可读取和恢复；新建的实验会进入 `PaperReproductions/`。

应用退出或切换数据目录时会停止并保存 agent 的当前轮次，**已启动的后台任务继续运行**。重新打开对应数据目录后恢复任务状态，并在符合唤醒条件时回传结果。退出应用不会停止训练；要结束任务，请使用任务卡的“停止”。电脑关机或重启会终止本机进程，不会自动恢复训练本身。

### 运行环境与边界

2026-10-29 的 0.2.1 执行器修复版改进了 CLI 自动查找：显式指定和 PATH 中的 `codex.exe` 仍然优先；回退查找时，优先选择本机 Codex 桌面版已安装的运行时，再查全局 npm CLI，避免桌面工具配置与另一份 CLI 的 Windows 沙箱不兼容。执行器初始化错误会立即结束本轮，并保留原始错误，不再让 agent 反复尝试替换命令。修复版安装包保存在 `versions/0.2.1/hotfix/windows/`，最初归档包保留。

- 实验 agent 需要本机可用且已配置的 Codex CLI；手动兼容接口不能替代实验执行 agent。应用不会自动安装或更新 Codex。
- `workspace-write` 的实际隔离取决于本机 Codex 与 Windows 沙箱配置。当前 Windows 环境已验证：工作目录内写入成功，受控目录外写入被拒绝；不能据此保证所有机器的配置相同。
- 后台任务以当前用户权限在 **Codex 沙箱外** 执行，可以联网，也不受实验“允许联网”开关限制。审批开关控制的是这些提交任务，agent 自己的短命令不逐条审批；常驻说明要求它把训练、完整评测等长命令提交给平台。
- 后台任务使用环境变量白名单，默认不继承 API 密钥等变量；这不是系统级隔离，也不能阻止命令访问当前用户本来可访问的文件。额外变量可在启动应用前通过 `AUTORESEARCH_JOB_ENV=HF_TOKEN,WANDB_API_KEY` 放行。
- 默认用 Electron 自带的 Node 启动后台任务（`ELECTRON_RUN_AS_NODE`）。如果部署环境禁用了该能力，可设置 `AUTORESEARCH_NODE_PATH` 为独立 `node.exe` 的绝对路径。
- 任务工作目录和文件打开路径检查真实路径，拒绝越界和指向目录外的符号链接 / Windows junction。`.py`、`.bat`、`.ps1` 等执行类文件从文件列表打开时只在资源管理器中定位。
- 平台不内置 GPU 调度、远程服务器、容器、数据集授权流程或论文结果验收。依赖安装、模型与数据下载和实验结论仍取决于实际环境；`REPRO.md` 中的结果需注明来源并人工核对。
