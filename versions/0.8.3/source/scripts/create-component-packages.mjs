import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const output = join(root, "versions", "0.4.1", "packages");
mkdirSync(output, { recursive: true });
const common = ["src/types.ts", "src/styles/global.css", "electron/main.mjs", "electron/preload.cjs"];
const groups = {
  "01-课题概览": ["src/app/App.tsx", "src/screens/overview", ...common, "electron/experiments/service.mjs", "electron/environments/service.mjs"],
  "02-文献分析": ["src/screens/paper-analysis", "src/components/PdfCitationViewer.tsx", "src/components/markdown.jsx", "src/components/AgentQuestionDialog.tsx", "src/components/agent-question.css", ...common, "electron/research-workflows.mjs", "electron/retrieval.mjs", "electron/evidence.mjs", "electron/agent-questions.mjs"],
  "03-研究讨论": ["src/screens/research-discussion", "src/components/markdown.jsx", "src/app/tasks.ts", ...common, "electron/discussions.mjs", "electron/agent-questions.mjs", "electron/codex-sdk.mjs", "electron/retrieval.mjs", "electron/evidence.mjs"],
  "04-Idea池": ["src/screens/idea-pool", "src/components/markdown.jsx", ...common, "electron/research-workflows.mjs"],
  "05-研究笔记": ["src/screens/research-notes", ...common],
  "06-课题文件": ["src/screens/project-files", ...common, "electron/project-files.mjs"],
  "07-实验复现": ["src/screens/experiments", "src/components/AgentQuestionDialog.tsx", "src/components/agent-question.css", "src/app/tasks.ts", ...common, "electron/experiments"],
  "08-运行环境": ["src/screens/project-environment", ...common, "electron/environments"],
};
for (const [name, files] of Object.entries(groups)) {
  const stage = mkdtempSync(join(tmpdir(), "autoresearch-component-"));
  for (const relative of files) {
    const source = join(root, relative);
    if (!existsSync(source)) continue;
    const target = join(stage, relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  writeFileSync(join(stage, "README.md"), `# ${name}\n\nAutoResearch 0.4.1 的 ${name} 前后端关键源码提取包。\n\n包含对应页面、Electron IPC、preload 桥接、服务模块和直接依赖。排除 data/、聊天记录、实验环境、凭据和 node_modules。\n`, "utf8");
  const zip = join(output, `${name}.zip`);
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`], { stdio: "ignore" });
  rmSync(stage, { recursive: true, force: true });
}
for (const file of readdirSync(output).filter((name) => name.endsWith(".zip"))) console.log(`${file}\t${statSync(join(output, file)).size}`);
