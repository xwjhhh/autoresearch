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
