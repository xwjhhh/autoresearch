import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const versionDirectory = join(root, "versions", packageJson.version);
const outputDirectory = join(versionDirectory, "packages", "modules");
const stagingRoot = join(root, "versions", ".build", "windows", "module-zips");
const shared = [
  "src/app/App.tsx",
  "src/types.ts",
  "src/uiText.ts",
  "electron/preload.cjs",
  "electron/main.mjs",
];

const modules = [
  {
    name: "课题概览",
    file: "01-课题概览.zip",
    summary: "课题主页、研究进展概览和关联实验/运行环境摘要。",
    frontend: [
      "src/screens/overview/OverviewView.tsx",
      "src/screens/overview/screen.css",
      "src/screens/paper-analysis/PaperAnalysisWorkspace.tsx",
      "src/screens/project-environment/model.ts",
      "src/app/tasks.ts",
      "src/components/Shared.tsx",
    ],
    backend: ["electron/experiments/service.mjs", "electron/environments/service.mjs"],
    channels: ["workspace:load", "experiment:list", "project-environment:get"],
  },
  {
    name: "文献分析",
    file: "02-文献分析.zip",
    summary: "论文导入、阅读分析、文献问答、引用证据和分析记录。",
    frontend: [
      "src/screens/paper-analysis/PaperAnalysisPage.tsx",
      "src/screens/paper-analysis/PaperAnalysisWorkspace.tsx",
      "src/screens/paper-analysis/PaperAnalysisDetail.tsx",
      "src/screens/paper-analysis/PaperCodexDock.tsx",
      "src/screens/paper-analysis/PaperReviewRail.tsx",
      "src/screens/paper-analysis/screen.css",
      "src/components/PaperRow.tsx",
      "src/components/PdfCitationViewer.tsx",
      "src/components/markdown.jsx",
      "src/components/Shared.tsx",
      "src/components/AgentQuestionDialog.tsx",
      "src/components/agent-question.css",
      "src/app/tasks.ts",
    ],
    backend: [
      "electron/research-workflows.mjs",
      "electron/prompts.mjs",
      "electron/retrieval.mjs",
      "electron/evidence.mjs",
      "electron/ai-call-logs.mjs",
      "electron/agent-questions.mjs",
      "electron/codex-sdk.mjs",
      "electron/codex-config.mjs",
      "electron/retry.mjs",
      "electron/project-directories.mjs",
    ],
    channels: ["paper:import", "paper:analyze", "paper:analyze-all", "paper-agent:*", "paper:read", "paper:update"],
  },
  {
    name: "研究讨论",
    file: "03-研究讨论.zip",
    summary: "围绕课题和文献开展对话，并保存笔记或设想。",
    frontend: ["src/screens/research-discussion/DiscussionView.tsx", "src/screens/research-discussion/screen.css", "src/components/markdown.jsx"],
    backend: [
      "electron/discussions.mjs",
      "electron/retrieval.mjs",
      "electron/evidence.mjs",
      "electron/ai-call-logs.mjs",
      "electron/codex-config.mjs",
      "electron/codex-sdk.mjs",
      "electron/agent-questions.mjs",
      "electron/retry.mjs",
    ],
    channels: ["chat:send", "research-note:save", "idea:save"],
  },
  {
    name: "研究笔记",
    file: "04-研究笔记.zip",
    summary: "查看、创建和更新课题研究笔记。",
    frontend: ["src/screens/research-notes/ResearchNotesView.tsx", "src/screens/research-notes/screen.css"],
    backend: [],
    channels: ["research-note:save", "research-note:update"],
  },
  {
    name: "课题文件",
    file: "05-课题文件.zip",
    summary: "浏览课题目录、导入文件、打开文件或在资源管理器中定位。",
    frontend: ["src/screens/project-files/ProjectFilesView.tsx", "src/screens/project-files/screen.css"],
    backend: ["electron/project-files.mjs", "electron/project-directories.mjs"],
    channels: ["project-files:list", "project-files:import", "project-files:choose-import", "project-files:open-root", "project-files:open", "project-files:reveal", "project-files:start-drag"],
  },
  {
    name: "实验",
    file: "06-实验.zip",
    summary: "设想、设计实验、论文复现、任务执行、终端和代码差异。",
    frontend: [
      "src/screens/experiments/ExperimentView.tsx",
      "src/screens/experiments/ExperimentSidebar.tsx",
      "src/screens/experiments/IdeaWorkbench.tsx",
      "src/screens/experiments/DiffTab.tsx",
      "src/screens/experiments/TerminalDock.tsx",
      "src/screens/experiments/logScreen.ts",
      "src/screens/experiments/screen.css",
      "src/components/Shared.tsx",
      "src/components/markdown.jsx",
      "src/components/AgentQuestionDialog.tsx",
      "src/components/agent-question.css",
    ],
    backend: [
      "electron/experiments/service.mjs",
      "electron/experiments/brief.mjs",
      "electron/experiments/git.mjs",
      "electron/experiments/run-helper.mjs",
      "electron/experiments/job-runner.mjs",
      "electron/experiments/question-server.mjs",
      "electron/experiments/conclude-helper.mjs",
      "electron/environments/runtime.mjs",
      "electron/agent-questions.mjs",
      "electron/retry.mjs",
      "electron/codex-sdk.mjs",
      "electron/codex-recovery.mjs",
      "electron/ai-call-logs.mjs",
    ],
    channels: ["experiment:list", "experiment:get", "experiment:create", "experiment:conversation:*", "experiment:send", "experiment:job*", "experiment:run", "experiment:terminal", "experiment:record", "experiment:files", "experiment:diff"],
  },
  {
    name: "运行环境",
    file: "07-运行环境.zip",
    summary: "创建、绑定、检查和更新课题运行环境。",
    frontend: ["src/screens/project-environment/ProjectEnvironmentView.tsx", "src/screens/project-environment/model.ts", "src/screens/project-environment/screen.css"],
    backend: [
      "electron/environments/service.mjs",
      "electron/environments/runtime.mjs",
      "electron/environments/request-helper.mjs",
      "electron/experiments/service.mjs",
      "electron/project-directories.mjs",
    ],
    channels: ["project-environment:get", "project-environment:create", "project-environment:bind", "project-environment:check", "project-environment:prepare", "project-environment:approve", "project-environment:reject"],
  },
  {
    name: "模型与数据设置",
    file: "08-模型与数据设置.zip",
    summary: "配置模型接口、连接测试和研究数据工作区路径。",
    frontend: ["src/styles/global.css", "src/components/Shared.tsx"],
    backend: ["electron/codex-config.mjs", "electron/codex-sdk.mjs", "electron/ai-call-logs.mjs", "electron/retry.mjs"],
    integration: ["src/app/App.tsx"],
    channels: ["settings:get", "settings:save", "settings:test", "workspace:choose"],
  },
  {
    name: "打开数据目录",
    file: "09-打开数据目录.zip",
    summary: "显示当前研究数据工作区路径并在文件管理器中打开。",
    frontend: ["src/styles/global.css"],
    backend: ["electron/data-path.mjs"],
    integration: ["src/app/App.tsx"],
    channels: ["workspace:path", "workspace:open"],
  },
];

const exists = async (path) => access(path).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});

function moduleReadme(module, files) {
  const section = (title, entries) => `## ${title}\n\n${entries.length ? entries.map((path) => `- \`${path}\``).join("\n") : "无独立文件；对应逻辑集中在共享集成文件中。"}\n`;
  return [
    `# ${module.name}`,
    "",
    `版本：${packageJson.version}`,
    "",
    module.summary,
    "",
    "本包按当前源码中的功能边界整理，保留原目录结构。`App.tsx`、`main.mjs` 和 `preload.cjs` 是共享接线文件，相关功能只占其中一部分。",
    "",
    section("前端入口", module.frontend),
    section("后端服务", module.backend),
    section("共享集成文件", [...new Set([...shared, ...(module.integration ?? [])])]),
    `## 主要 IPC\n\n${module.channels.map((channel) => `- \`${channel}\``).join("\n")}\n`,
    "## 文件清单",
    "",
    ...files.map((path) => `- \`${path}\``),
    "",
    "该 ZIP 不包含 `data/`、课题环境、论文实验输出、聊天记录、凭据、`node_modules/` 或构建产物。",
    "",
  ].join("\n");
}

if (!(await exists(versionDirectory))) throw new Error(`Version archive is missing: ${versionDirectory}. Build and archive the installer first.`);
await mkdir(outputDirectory, { recursive: true });
await mkdir(stagingRoot, { recursive: true });

const packageManifest = [];
try {
  for (const module of modules) {
    const files = [...new Set([...module.frontend, ...module.backend, ...shared, ...(module.integration ?? [])])].sort();
    for (const path of files) {
      if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`Invalid manifest path: ${path}`);
      const sourcePath = join(root, path);
      if (!(await exists(sourcePath)) || !(await stat(sourcePath)).isFile()) throw new Error(`Missing module source: ${path}`);
    }

    const stage = join(stagingRoot, module.file.replace(/\.zip$/i, ""));
    const temporaryArchive = join(stagingRoot, `${module.file.replace(/\.zip$/i, "")}.tmp.zip`);
    const finalArchive = join(outputDirectory, module.file);
    await rm(stage, { recursive: true, force: true });
    await rm(temporaryArchive, { force: true });
    await mkdir(stage, { recursive: true });
    for (const path of files) await cp(join(root, path), join(stage, path), { recursive: false });
    await writeFile(join(stage, "README.md"), moduleReadme(module, files), "utf8");
    execFileSync("tar.exe", ["-a", "-c", "-f", temporaryArchive, "-C", stage, "."], { stdio: "inherit" });
    const entries = execFileSync("tar.exe", ["-t", "-f", temporaryArchive], { encoding: "utf8" })
      .split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""));
    for (const path of files) if (!entries.includes(path)) throw new Error(`ZIP verification failed for ${module.file}: ${path}`);
    await rename(temporaryArchive, finalArchive);
    const bytes = await readFile(finalArchive);
    packageManifest.push({
      file: module.file,
      module: module.name,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      files: ["README.md", ...files],
    });
  }

  const generatedAt = new Date().toISOString();
  await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify({ version: packageJson.version, generatedAt, packages: packageManifest }, null, 2)}\n`, "utf8");
  const index = [
    `# AutoResearch ${packageJson.version} 模块源码包`,
    "",
    "每个压缩包对应一个主导航功能，包含该模块的前端入口、后端服务和共享 IPC/类型接线文件。重复出现的 `App.tsx`、`main.mjs`、`preload.cjs` 用于理解它们在整套应用中的调用关系。",
    "",
    ...packageManifest.map((item) => `- [${item.file}](${item.file})：${item.module}，${item.files.length - 1} 个源码文件，SHA-256：\`${item.sha256}\``),
    "",
    "清单：`manifest.json`。所有文件来自该版本源码，不含课题数据、聊天记录、实验环境、凭据或依赖目录。",
    "",
  ].join("\n");
  await writeFile(join(outputDirectory, "README.md"), index, "utf8");
  process.stdout.write(`Created ${packageManifest.length} module ZIPs for AutoResearch ${packageJson.version}: ${relative(root, outputDirectory)}\n`);
  for (const item of packageManifest) process.stdout.write(`${item.file}\t${item.size}\t${item.sha256}\n`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
