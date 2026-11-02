import { lazy, Suspense, useState } from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import type { AnalysisDepth, ExperimentSummary, Paper, PaperAnalysisProgress, PaperRole, Project, ResearchNote, View } from "../../types";
import { PapersView } from "./PaperAnalysisWorkspace";
import { PaperAnalysisDetailView } from "./PaperAnalysisDetail";
import { isAnalyzing, isLiveProgress } from "../../app/tasks";
import "./screen.css";

const PdfCitationViewer = lazy(() => import("../../components/PdfCitationViewer"));

interface PaperAnalysisPageProps {
  project: Project;
  view: View;
  selectedPaperId: string;
  /** 正在进行的长时间操作，见 app/tasks.ts */
  tasks: ReadonlySet<string>;
  progressFor: (paperId: string) => PaperAnalysisProgress | null;
  /** 这个课题的实验摘要；null 表示还在读取 */
  experiments: ExperimentSummary[] | null;
  onView: (view: View) => void;
  onSelectPaper: (paperId: string) => void;
  onImport: () => void;
  onAnalyze: (paper: Paper) => void;
  onAnalyzeAll: () => void;
  onOpenPaper: (paper: Paper, page?: number, quote?: string) => void;
  onOpenExternal: (paper: Paper) => void;
  onUpdatePaper: (paper: Paper, payload: { role?: PaperRole; analysisDepth?: AnalysisDepth }) => void;
  /** 带着这篇论文去新建复现实验 */
  onReproduce: (paper: Paper) => void;
  onOpenExperiment: (experimentId: string) => void;
  onAgentMessage: (paperId: string, content: string) => Promise<{ answer: string; paper: Paper }>;
  onPaperChange: (paper: Paper) => void;
  onSaveNote: (text: string, options: { paperId?: string; fromMessageId?: string }) => Promise<ResearchNote | null>;
}

export function PaperAnalysisPage(props: PaperAnalysisPageProps) {
  const { project, view, selectedPaperId, tasks, progressFor, experiments, onView, onSelectPaper } = props;
  const selectedPaper = project.papers.find((paper) => paper.id === selectedPaperId) ?? null;
  // 讲解稿或分析过程里点到本论文的页码时，左边的 PDF 直接翻到那一页；其他论文用弹出的阅读器打开。
  const [jump, setJump] = useState<{ paperId: string; page: number; quote?: string; nonce: number } | null>(null);
  const openInDetail = (paper: Paper, page = 1, quote?: string) => {
    if (selectedPaper && paper.id === selectedPaper.id) setJump({ paperId: paper.id, page, quote, nonce: Date.now() });
    else props.onOpenPaper(paper, page, quote);
  };
  const pdfAt = jump && selectedPaper && jump.paperId === selectedPaper.id ? jump : null;

  // 打开只是打开：没有分析稿时，详情页里有“开始分析”按钮。
  const openDetail = (paper: Paper) => {
    onSelectPaper(paper.id);
    onView("paper-detail");
  };
  const toggleRole = (paper: Paper) => props.onUpdatePaper(paper, { role: (paper.role ?? "core") === "core" ? "atypical" : "core" });

  if (view === "papers") return <PapersView
    project={project}
    papers={project.papers}
    tasks={tasks}
    progressFor={progressFor}
    experiments={experiments}
    onImport={props.onImport}
    onAnalyze={props.onAnalyze}
    onAnalyzeAll={props.onAnalyzeAll}
    onOpen={openDetail}
    onOpenExternal={props.onOpenExternal}
    onToggleRole={toggleRole}
    onReproduce={props.onReproduce}
    onOpenExperiment={props.onOpenExperiment}
  />;

  if (!selectedPaper) return <div className="pa-page">
    <button type="button" className="pa-link-button" onClick={() => onView("papers")}><ArrowLeft size={14} />文献</button>
    <p className="pa-table-empty">找不到所选论文，请返回文献列表重新选择。</p>
  </div>;

  return <PaperAnalysisDetailView
    key={selectedPaper.id}
    project={project}
    paper={selectedPaper}
    experiments={experiments}
    analyzing={isAnalyzing(tasks, project.id, selectedPaper.id) || isLiveProgress(progressFor(selectedPaper.id))}
    progress={progressFor(selectedPaper.id)}
    onBack={() => onView("papers")}
    onAnalyze={props.onAnalyze}
    onOpenPaper={openInDetail}
    onUpdatePaper={(payload) => props.onUpdatePaper(selectedPaper, payload)}
    onReproduce={props.onReproduce}
    onOpenExperiment={props.onOpenExperiment}
    onAgentMessage={(content) => props.onAgentMessage(selectedPaper.id, content)}
    onPaperChange={props.onPaperChange}
    onSaveNote={props.onSaveNote}
    pdfPane={<Suspense fallback={<div className="pdf-loading"><LoaderCircle className="spin" size={18} />正在打开原文</div>}><PdfCitationViewer key={pdfAt ? `${pdfAt.page}:${pdfAt.nonce}` : "start"} projectId={project.id} paper={selectedPaper} page={pdfAt?.page ?? 1} quote={pdfAt?.quote} onClose={() => undefined} embedded /></Suspense>}
  />;
}
