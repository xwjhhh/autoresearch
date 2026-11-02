import { useEffect, useRef, useState } from "react";
import { ArrowDown, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, X } from "lucide-react";
import { GlobalWorkerOptions, getDocument, TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Paper } from "../types";

GlobalWorkerOptions.workerSrc = workerSrc;

const normalized = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\p{Z}\s\p{Cf}]+/gu, "");

export default function PdfCitationViewer({ projectId, paper, page: initialPage, quote, onClose, embedded = false, onSelectText }: { projectId: string; paper: Paper; page: number; quote?: string; onClose: () => void; embedded?: boolean; onSelectText?: (quote: string, page: number) => void }) {
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [pageCount, setPageCount] = useState(paper.pageCount || 0);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [matchInPage, setMatchInPage] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageShellRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let loaded: PDFDocumentProxy | null = null;
    setBusy(true);
    setError("");
    window.autoresearch.readPaper({ projectId, paperId: paper.id }).then((data) => getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise).then((pdf) => {
      if (disposed) { void pdf.destroy(); return; }
      loaded = pdf;
      setDocumentProxy(pdf);
      setPageCount(pdf.numPages);
      setPage(Math.max(1, Math.min(initialPage, pdf.numPages)));
    }).catch((reason: unknown) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; if (loaded) void loaded.destroy(); };
  }, [projectId, paper.id, initialPage]);

  useEffect(() => {
    if (!documentProxy || !canvasRef.current || !pageShellRef.current) return;
    let disposed = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | null = null;
    let textLayer: TextLayer | null = null;
    setBusy(true);
    setMatchInPage(false);
    documentProxy.getPage(page).then(async (pageProxy) => {
      const [textContent, shellWidth] = await Promise.all([
        pageProxy.getTextContent(),
        Promise.resolve(pageShellRef.current?.clientWidth ?? 720),
      ]);
      if (disposed || !canvasRef.current) return;
      const viewport = pageProxy.getViewport({ scale: 1 });
      const scale = Math.min(1.45, Math.max(0.6, (shellWidth - 34) / viewport.width));
      const scaled = pageProxy.getViewport({ scale });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("无法创建 PDF 页面画布。");
      canvas.width = Math.round(scaled.width);
      canvas.height = Math.round(scaled.height);
      setPageSize({ width: scaled.width, height: scaled.height });
      renderTask = pageProxy.render({ canvasContext: context, viewport: scaled });
      await renderTask.promise;
      if (disposed || !textLayerRef.current) return;
      const layerElement = textLayerRef.current;
      layerElement.replaceChildren();
      layerElement.style.width = `${scaled.width}px`;
      layerElement.style.height = `${scaled.height}px`;
      textLayer = new TextLayer({ textContentSource: textContent, container: layerElement, viewport: scaled });
      await textLayer.render();
      if (disposed) return;
      const itemTexts = textLayer.textContentItemsStr;
      const joined = itemTexts.join("");
      const target = quote ? normalized(quote) : "";
      const start = target ? normalized(joined).indexOf(target) : -1;
      let offset = 0;
      itemTexts.forEach((text, index) => {
        const itemStart = offset;
        const itemEnd = itemStart + normalized(text).length;
        offset = itemEnd;
        if (start >= 0 && itemStart < start + target.length && itemEnd > start) textLayer?.textDivs[index]?.classList.add("pdf-text-highlight");
      });
      setMatchInPage(start >= 0);
      if (start >= 0) {
        window.requestAnimationFrame(() => pageShellRef.current?.querySelector(".pdf-text-highlight")?.scrollIntoView({ block: "center", behavior: "smooth" }));
      }
    }).catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; renderTask?.cancel(); textLayer?.cancel(); };
  }, [documentProxy, page, quote]);

  const changePage = (next: number) => setPage(Math.max(1, Math.min(pageCount, next)));

  const viewer = <section className={`pdf-viewer ${embedded ? "pdf-viewer--embedded" : ""}`} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={`阅读 ${paper.title}`}>
      <header className="pdf-viewer-header"><div><span className="eyebrow">SOURCE DOCUMENT</span><h2>{paper.title}</h2></div><button className="pdf-viewer-close" type="button" aria-label="关闭 PDF 阅读器" onClick={onClose}><X size={17} /></button></header>
      <div className="pdf-viewer-toolbar"><button type="button" className="pdf-toolbar-button" onClick={() => changePage(page - 1)} disabled={page <= 1}><ChevronLeft size={15} />上一页</button><label>页码<input type="number" min={1} max={pageCount || undefined} value={page} onChange={(event) => changePage(Number(event.target.value) || 1)} /><span>/ {pageCount || "--"}</span></label><button type="button" className="pdf-toolbar-button" onClick={() => changePage(page + 1)} disabled={page >= pageCount}>下一页<ChevronRight size={15} /></button>{quote && <span className={`pdf-match-status ${matchInPage ? "is-found" : ""}`}>{matchInPage ? <ArrowDown size={13} /> : <CircleAlert size={13} />}{matchInPage ? "摘录已在页面上标出" : "页面未找到摘录，原文保留如下"}</span>}</div>
      {quote && <div className="pdf-source-excerpt"><strong>引用原文</strong><p>{quote}</p></div>}
      <div className="pdf-viewer-body">
        <div className="pdf-page-shell" ref={pageShellRef}>{busy && <div className="pdf-loading"><LoaderCircle className="spin" size={18} />正在加载页面</div>}{error && <div className="pdf-error"><CircleAlert size={17} />{error}</div>}<div className="pdf-canvas-wrap" style={pageSize ? { width: `${pageSize.width}px`, height: `${pageSize.height}px` } : undefined}><canvas ref={canvasRef} aria-label={`${paper.title} 第 ${page} 页`} /><div className="pdf-text-layer" ref={textLayerRef} aria-label="PDF 页面文字" onMouseUp={() => { const selection = window.getSelection()?.toString().trim(); if (selection) onSelectText?.(selection, page); }} /></div></div>
      </div>
  </section>;
  return embedded ? viewer : <div className="pdf-viewer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{viewer}</div>;
}
