import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Search,
  Upload,
  X,
} from "lucide-react";
import "./screen.css";

export interface ProjectFileNode {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
  children: ProjectFileNode[];
  childrenLoaded?: boolean;
}

export interface ProjectFilesViewProps {
  files: ProjectFileNode[];
  busy: boolean;
  showSystemFiles: boolean;
  onShowSystemFilesChange: (show: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onImportFiles: () => void;
  onImportFolder: () => void;
  onOpenRoot: () => void;
  onRefresh: () => void;
  onLoadFolder: (path: string) => Promise<boolean>;
  onDrop: (files: File[], targetPath: string) => void;
  onDragOut: (path: string) => void;
  onOpenFile: (path: string) => void;
}

type DropEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?: (success: (file: File) => void, error?: (reason: unknown) => void) => void;
  createReader?: () => { readEntries: (success: (entries: DropEntry[]) => void, error?: (reason: unknown) => void) => void };
};

const normalizeRelativePath = (path: string) => path
  .replaceAll("\\", "/")
  .split("/")
  .filter((part) => part && part !== "." && part !== "..")
  .join("/");

const systemFileNames = new Set(["project.json", "metadata.json", "chunks.jsonl"]);
const isSystemPath = (path: string) => path
  .replaceAll("\\", "/")
  .split("/")
  .some((part) => part.startsWith(".") || systemFileNames.has(part.toLocaleLowerCase()));

function readEntryFile(entry: DropEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    if (!entry.file) {
      reject(new Error("无法读取拖入的文件"));
      return;
    }
    entry.file(resolve, reject);
  });
}

function readEntryChildren(entry: DropEntry): Promise<DropEntry[]> {
  return new Promise((resolve, reject) => {
    const reader = entry.createReader?.();
    if (!reader) {
      resolve([]);
      return;
    }
    const all: DropEntry[] = [];
    const readBatch = () => reader.readEntries((batch) => {
      if (!batch.length) {
        resolve(all);
        return;
      }
      all.push(...batch);
      readBatch();
    }, reject);
    readBatch();
  });
}

async function collectEntryFiles(entry: DropEntry, parentPath = ""): Promise<File[]> {
  const relativePath = normalizeRelativePath(parentPath ? `${parentPath}/${entry.name}` : entry.name);
  if (entry.isDirectory) {
    const files: File[] = [];
    for (const child of await readEntryChildren(entry)) {
      try {
        files.push(...await collectEntryFiles(child, relativePath));
      } catch {
        // An unreadable child should not discard other files from the drop.
      }
    }
    return files;
  }
  if (!entry.isFile) return [];
  const file = await readEntryFile(entry);
  try {
    Object.defineProperty(file, "webkitRelativePath", { configurable: true, value: relativePath || file.name });
  } catch {
    // Browsers may expose the relative path as a non-configurable property.
  }
  return [file];
}

async function collectDroppedFiles(event: DragEvent<HTMLElement>): Promise<File[]> {
  const files: File[] = [];
  const items = Array.from(event.dataTransfer.items ?? []);
  let readEntry = false;
  for (const item of items) {
    const candidate = item as DataTransferItem & { webkitGetAsEntry?: () => DropEntry | null };
    const entry = candidate.webkitGetAsEntry?.() ?? null;
    if (entry) {
      readEntry = true;
      try {
        files.push(...await collectEntryFiles(entry));
      } catch {
        // Continue with other dragged entries when one cannot be read.
      }
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (!readEntry && !files.length) files.push(...Array.from(event.dataTransfer.files ?? []));
  return files;
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function filterTree(nodes: ProjectFileNode[], query: string, showSystemFiles: boolean): ProjectFileNode[] {
  const needle = query.trim().toLocaleLowerCase();
  return nodes.flatMap((node) => {
    if (!showSystemFiles && isSystemPath(node.path)) return [];
    const selfMatches = !needle || `${node.name} ${node.path}`.toLocaleLowerCase().includes(needle);
    const children = node.kind === "directory" ? filterTree(node.children, query, showSystemFiles) : [];
    if (!selfMatches && !children.length) return [];
    return [{ ...node, children: selfMatches && node.kind === "directory" ? filterTree(node.children, "", showSystemFiles) : children }];
  });
}

function FileTreeNode({
  node,
  depth,
  expanded,
  searching,
  dropTarget,
  busy,
  onToggle,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragOut,
  onOpenFile,
}: {
  node: ProjectFileNode;
  depth: number;
  expanded: boolean;
  searching: boolean;
  dropTarget: string | null;
  busy: boolean;
  onToggle: (path: string) => void | Promise<void>;
  onDragOver: (event: DragEvent<HTMLElement>, path: string) => void;
  onDragLeave: (event: DragEvent<HTMLElement>, path: string) => void;
  onDrop: (event: DragEvent<HTMLElement>, path: string) => void;
  onDragOut: (event: DragEvent<HTMLElement>, path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const isDirectory = node.kind === "directory";
  const visibleExpanded = searching || expanded;
  const title = isDirectory
    ? node.path
    : `${node.path} · ${formatBytes(node.size)}${node.modifiedAt ? ` · ${node.modifiedAt}` : ""}`;
  const handleDragOver = (event: DragEvent<HTMLElement>) => onDragOver(event, node.path);
  const handleDragLeave = (event: DragEvent<HTMLElement>) => onDragLeave(event, node.path);
  const handleDrop = (event: DragEvent<HTMLElement>) => onDrop(event, node.path);
  const handleDragOut = (event: DragEvent<HTMLElement>) => onDragOut(event, node.path);

  return <div className="pf-node" key={node.path}>
    {isDirectory ? <>
      <button
        type="button"
        className={`pf-row pf-folder${dropTarget === node.path ? " is-drop-target" : ""}`}
        style={{ paddingLeft: `${8 + depth * 13}px` }}
        title={node.path}
        aria-expanded={visibleExpanded}
        draggable={!busy}
        onClick={() => void onToggle(node.path)}
        onDragStart={handleDragOut}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {visibleExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {visibleExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span className="pf-name">{node.name}</span>
        <span className="pf-count">{node.childrenLoaded === false ? "…" : node.children.length}</span>
      </button>
      {visibleExpanded && node.children.length > 0 && <div className="pf-children">
        {node.children.map((child) => <FileTreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          searching={searching}
          dropTarget={dropTarget}
          busy={busy}
          onToggle={onToggle}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onDragOut={onDragOut}
          onOpenFile={onOpenFile}
        />)}
      </div>}
    </> : <button
      type="button"
      className="pf-row pf-file"
      style={{ paddingLeft: `${23 + depth * 13}px` }}
      title={title}
      draggable={!busy}
      onClick={() => onOpenFile(node.path)}
      onDragStart={handleDragOut}
    >
      {node.name.toLocaleLowerCase().endsWith(".pdf") ? <FileText size={14} /> : <File size={14} />}
      <span className="pf-name">{node.name}</span>
      <span className="pf-size">{formatBytes(node.size)}</span>
    </button>}
  </div>;
}

export function ProjectFilesView({
  files,
  busy,
  showSystemFiles,
  onShowSystemFilesChange,
  query,
  onQueryChange,
  onImportFiles,
  onImportFolder,
  onOpenRoot,
  onRefresh,
  onLoadFolder,
  onDrop,
  onDragOut,
  onOpenFile,
}: ProjectFilesViewProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const visibleFiles = useMemo(() => filterTree(files, query, showSystemFiles), [files, query, showSystemFiles]);
  const searching = Boolean(query.trim());
  const visibleCount = useMemo(() => {
    const count = (nodes: ProjectFileNode[]): number => nodes.reduce((total, node) => total + 1 + count(node.children), 0);
    return count(visibleFiles);
  }, [visibleFiles]);

  const toggleFolder = (path: string) => setExpandedPaths((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const findNode = (nodes: ProjectFileNode[], path: string): ProjectFileNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.kind === "directory") {
        const match = findNode(node.children, path);
        if (match) return match;
      }
    }
    return null;
  };

  const handleToggleFolder = async (path: string) => {
    const node = findNode(files, path);
    if (!node || node.kind !== "directory") return;
    if (node.childrenLoaded === false && !loadingPaths.has(path)) {
      setLoadingPaths((current) => new Set(current).add(path));
      const loaded = await onLoadFolder(path);
      setLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      if (!loaded) return;
    }
    toggleFolder(path);
  };

  const hasFileDrag = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes("Files");
  const handleDragOver = (event: DragEvent<HTMLElement>, path: string) => {
    if (!hasFileDrag(event) || busy) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDropTargetPath(path);
  };
  const handleDragLeave = (event: DragEvent<HTMLElement>, path: string) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDropTargetPath((current) => current === path ? null : current);
  };
  const handleDrop = async (event: DragEvent<HTMLElement>, targetPath: string) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTargetPath(null);
    if (busy) return;
    const dropped = await collectDroppedFiles(event);
    if (dropped.length) onDrop(dropped, targetPath);
  };
  const handleDragOut = (event: DragEvent<HTMLElement>, path: string) => {
    event.dataTransfer.effectAllowed = "copy";
    try { event.dataTransfer.setData("text/plain", path); } catch { /* Some embedded browsers restrict custom drag payloads. */ }
    onDragOut(path);
  };

  const controls: Array<{ label: string; icon: ReactNode; action: () => void }> = [
    { label: "导入文件", icon: <Upload size={14} />, action: onImportFiles },
    { label: "导入文件夹", icon: <FolderPlus size={14} />, action: onImportFolder },
    { label: "打开课题目录", icon: <FolderOpen size={14} />, action: onOpenRoot },
    { label: "刷新文件", icon: <RefreshCw size={14} />, action: onRefresh },
  ];

  return <section className="project-files-view" aria-label="课题文件">
    <header className="pf-head">
      <div className="pf-heading"><span className="pf-eyebrow">PROJECT FILES</span><h1>课题文件</h1></div>
      <div className="pf-actions">
        {controls.map(({ label, icon, action }) => <button
          key={label}
          type="button"
          className="button pf-action"
          aria-label={label}
          title={label}
          disabled={busy}
          onClick={action}
        >{icon}<span>{label}</span></button>)}
      </div>
    </header>
    <div className="pf-toolbar">
      <label className="pf-search">
        <Search size={14} />
        <input aria-label="搜索课题文件" value={query} placeholder="搜索文件名或路径" onChange={(event) => onQueryChange(event.currentTarget.value)} />
        {query ? <button type="button" aria-label="清除搜索" title="清除搜索" onClick={() => onQueryChange("")}><X size={13} /></button> : null}
      </label>
      <label className="pf-system-toggle">
        <input type="checkbox" checked={showSystemFiles} onChange={(event) => onShowSystemFilesChange(event.currentTarget.checked)} />
        <span>显示系统文件</span>
      </label>
      <span className="pf-item-count">{visibleCount} 项</span>
    </div>
    <div
      className={`pf-root${dropTargetPath === "" ? " is-drop-target" : ""}`}
      onDragOver={(event) => handleDragOver(event, "")}
      onDragLeave={(event) => handleDragLeave(event, "")}
      onDrop={(event) => void handleDrop(event, "")}
    >
      {visibleFiles.length ? visibleFiles.map((node) => <FileTreeNode
        key={node.path}
        node={node}
        depth={0}
        expanded={expandedPaths.has(node.path)}
        searching={searching}
        dropTarget={dropTargetPath}
        busy={busy}
        onToggle={handleToggleFolder}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event, path) => void handleDrop(event, path)}
        onDragOut={handleDragOut}
        onOpenFile={onOpenFile}
      />) : <div className="pf-empty">{query.trim() ? "没有匹配的文件" : "课题目录为空"}</div>}
    </div>
  </section>;
}
