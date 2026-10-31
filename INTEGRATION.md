# 文献分析 → idea → 人审批：接入说明

## 1. 文件清单

后端（gateway/）

| 文件 | 作用 |
| --- | --- |
| `pdf-parse.ts` | PDF → 可定位片段（页码、章节、坐标），不调用 AI |
| `literature.ts` / `literature-roles.ts` / `literature-api.ts` | 文献库：解析、分批精读、证据核对、跨论文综合、过期判断、任务队列、路由 |
| `idea-session.ts` / `idea-session-roles.ts` / `idea-session-api.ts` | Idea 会话：生成、AI 自检、审批、按意见修订、再要新 idea、完成审批 |
| `attachment-context.ts` | 讨论附件 → 交给 Codex 的数据块（PDF 只给摘要和片段路径） |
| `collab-codex.ts` / `collab-store.ts` | Codex 角色调用约定、JSONL 存储、事件流（之前已有，本次有小改动） |
| `codex-agent.ts` | 新增 `sandboxMode`、`outputSchema`、`webSearch`、`finalMessage` |
| `research-api.ts` | 接入三个新路由、导入 PDF 后自动分析、聊天附件 |
| `test-helpers.ts` / `literature.test.ts` / `idea-session.test.ts` / `fixtures/sample-paper.pdf` | 测试 |

前端（src/）

| 文件 | 作用 |
| --- | --- |
| `lib/literature-contract.ts` / `lib/idea-session-contract.ts` | 前后端共用的接口契约 |
| `lib/literature-client.ts` / `lib/idea-session-client.ts` | 客户端（事件流断线续传） |
| `components/research/LiteraturePage.tsx` | 文献库页 |
| `components/research/IdeaSessionsPage.tsx` | Idea 会话页（审批闭环） |
| `components/research/EvidenceViewer.tsx` | 点击引用 → PDF 对应页高亮 |
| `components/research/AttachmentPicker.tsx` | 附件选择与上传 |
| `research-ideas.css` | 以上组件的样式 |

上一版的 Idea Lab（`idea-lab*.ts`）已被 Idea 会话取代，可以删除。

## 2. 依赖

```bash
bun add pdfjs-dist
```

后端用 `pdfjs-dist/legacy/build/pdf.mjs` 解析文字；前端用 `pdfjs-dist` 渲染页面，worker 通过
`new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)` 加载（Vite 可直接识别）。

## 3. main.tsx

```ts
import "./research.css";
import "./research-ideas.css";   // 新增
```

## 4. ResearchApp.tsx

```tsx
import { httpLiteratureClient } from "./lib/literature-client";
import { httpIdeaSessionClient } from "./lib/idea-session-client";
import { LiteraturePage } from "./components/research/LiteraturePage";
import { IdeaSessionsPage } from "./components/research/IdeaSessionsPage";
import { uploadToProject } from "./components/research/AttachmentPicker";

// 状态
const [mainPanel, setMainPanel] = useState<"none" | "literature" | "ideas">("none");
const literatureClient = useMemo(() => project ? httpLiteratureClient(project.id) : null, [project?.id]);
const ideaClient = useMemo(() => project ? httpIdeaSessionClient(project.id) : null, [project?.id]);
const pdfUrl = useCallback((paperId: string) => contentUrl(project!.id, `PaperInfo/references/${paperId}/original.pdf`), [project?.id]);
const projectFiles = useMemo(() => artifacts.map((artifact) => artifact.path), [artifacts]);
const upload = useCallback(async (files: File[]) => {
  const paths = await uploadToProject(project!.id, files);   // 存进 PaperInfo/attachments/
  // 这里调用你现有的“刷新文件树”方法，让新文件出现在左侧
  return paths;
}, [project?.id]);

// 切换（showOverview 里补一句 setMainPanel("none")）
const showLiterature = () => { showOverview(); setMainPanel("literature"); };
const showIdeas = () => { showOverview(); setMainPanel("ideas"); };

// 侧边栏，放在“运行总览”按钮下面
<button className={`rs-nav-overview ${mainPanel === "literature" ? "is-active" : ""}`} onClick={showLiterature} disabled={!project}>文献库</button>
<button className={`rs-nav-overview ${mainPanel === "ideas" ? "is-active" : ""}`} onClick={showIdeas} disabled={!project}>Idea 会话</button>

// 主内容区：与运行总览同一层级判断
{mainPanel === "literature" && literatureClient
  ? <LiteraturePage literature={literatureClient} pdfUrl={pdfUrl} />
  : mainPanel === "ideas" && ideaClient && literatureClient
    ? <IdeaSessionsPage ideaSessions={ideaClient} literature={literatureClient} pdfUrl={pdfUrl} files={projectFiles} upload={upload} />
    : /* 原有内容 */ null}
```

## 5. 聊天附件

在聊天输入框上方加入附件选择，发送时把路径一起提交：

```tsx
const [attachments, setAttachments] = useState<string[]>([]);
<AttachmentPicker value={attachments} onChange={setAttachments} files={projectFiles} upload={upload} />
// 发送消息的请求体中加入：
{ content, mode, contextPath, attachments }
// 发送成功后 setAttachments([])
```

后端会把附件转成数据块：参考文献 PDF 给精读摘要和片段路径，其他 PDF 解析后给开头和片段路径，
文本小文件直接附上，大文件和二进制只给路径。用户消息里会追加一行“附件：…”，方便在历史中看到。

## 6. 运行测试

```bash
bun test gateway/literature.test.ts gateway/idea-session.test.ts gateway/collab.test.ts
```

## 7. 落盘位置

```text
PaperInfo/references/paper_001/parsed/chunks.jsonl   片段（id、页码、章节、坐标、文本）
PaperInfo/references/paper_001/parsed/meta.json      解析信息（含 PDF 哈希，用于判断过期）
PaperInfo/references/paper_001/analysis.json         精读结果（每条带证据与核对结果）
PaperInfo/references/paper_001/paper_analysis.md     人读版
PaperInfo/synthesis.json / synthesis.md              跨论文综合
PaperInfo/attachments/                               讨论时上传的文件
Ideas/sessions/session_001/                          会话：session.json、grounding.json、ideas/idea_01/{v0.json…, novelty.json, debate.jsonl, verdict.json, reviews.jsonl}、approved.md
Ideas/idea_00X/idea.md                               完成审批后写入的通过 idea
.omniscient/literature|idea-sessions/events.jsonl    事件流（前端断线续传用）
```
