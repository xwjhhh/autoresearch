---
name: add-ipc-api
description: 给 AutoResearch 界面新增一个调用主进程的能力（读写文件、调用服务、启动任务等）。在需求要求界面做到渲染进程本身做不到的事时使用。
---

# 新增主进程 API

渲染进程不能直接访问文件系统或 Node。新能力要经过四处，按顺序改，缺一处就会在运行时报"不是函数"或类型错误。

## 1. 主进程实现：`electron/main.mjs`

在已有的 `ipcMain.handle(...)` 附近注册，通道名用 `<模块>:<动作>`：

```js
ipcMain.handle("project:export", (_event, { projectId, format }) => exportProject(projectId, format));
```

- 参数统一用一个对象传，便于以后加字段。
- 逻辑超过几行就放到对应的服务模块（`electron/*.mjs`）里，`main.mjs` 只做注册。
- 出错直接 `throw new Error("中文说明")`，渲染进程会收到这条信息。

## 2. 暴露给渲染进程：`electron/preload.cjs`

在 `contextBridge.exposeInMainWorld("autoresearch", { ... })` 里同一模块的位置加一行：

```js
exportProject: (projectId, format) => invoke("project:export", { projectId, format }),
```

## 3. 类型声明：`src/types.ts`

在 `window.autoresearch` 的接口里加上同名方法：

```ts
exportProject(projectId: string, format: "zip" | "md"): Promise<{ path: string }>;
```

## 4. 页面里调用

```ts
const result = await window.autoresearch.exportProject(project.id, "zip");
```

沿用页面已有的错误处理方式（通常是 `setError(errorText(error))` 一类的写法），不要直接 `alert`。

## 5. 测试

- 服务模块里的逻辑写单元测试：`electron/<模块>.test.mjs`（放在 `electron/` 顶层）。
- 场景测试里可以用 `page.evaluate(() => window.autoresearch.exportProject(...))` 直接验证 API。
- 改了 `preload.cjs` 或 `main.mjs` 后需要重启应用才生效；场景测试每次都会重新启动，没有这个问题。
