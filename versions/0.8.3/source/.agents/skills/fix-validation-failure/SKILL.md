---
name: fix-validation-failure
description: AutoResearch 平台验证失败后定位和修复问题。在提示里出现"平台验证失败"、给出验证日志目录时使用。
---

# 处理平台验证失败

平台验证依次跑：安装依赖（锁文件变了才跑）→ 单元测试（含历次验收）→ 构建 → 全部场景测试（含历次验收）。遇到第一个失败就停。

## 1. 看完整日志，不要只看末尾

提示里给了日志目录。目录里每一步一个日志文件（`01.log`、`02.log`……），第一行是实际执行的命令；场景测试的截图在 `screenshots/` 下。

- 先找**第一个**报错，后面的报错常常是连带的。
- 场景测试失败时打开对应截图，看失败那一刻界面是什么样。

## 2. 在本地复现这一步

| 失败步骤 | 复现命令 |
| --- | --- |
| 安装依赖 | `npm ci --prefer-offline` |
| 单元测试 | `node --test <日志里报错的文件>`，修好后 `npm test` |
| 构建 | `npm run build`（`tsc` 报类型错误，或 `vite` 打包错误） |
| 场景测试 | `npm run build` 后 `node node_modules/playwright/cli.js test --config playwright.config.mjs <报错的 spec 文件>` |

先复现，再修。复现不出来时，在总结里写明原因（比如只在平台的隔离环境里出现）。

## 3. 常见原因

- **历次验收失败**（`tests/acceptance/iter-<别的编号>/`）：你的改动破坏了以前做好的功能。修代码，不要改那些测试。
- **场景测试找不到元素**：先确认 `npm run build` 过；再看截图，可能是文字或按钮名称改了、元素被遮挡、需要先点开某个面板。
- **类型错误**：改了 `model.ts` 或 `src/types.ts` 之后，其他用到这个类型的地方没跟着改。
- **超时**：某个操作没有触发预期的状态变化。不要通过加长等待来解决，找出为什么状态没变。

## 4. 修完

```
node scripts/iteration-check.mjs tests/acceptance/iter-N --all
```

`--all` 跑全部场景测试，等同平台验证。通过后再结束本轮。如果这次的原因以后可能再遇到，在 AGENTS.md「经验记录」追加一条。
