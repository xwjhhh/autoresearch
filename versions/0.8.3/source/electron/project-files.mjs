import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const hiddenNames = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const systemNames = new Set(["project.json", "metadata.json", "chunks.jsonl"]);
const copyFlags = 1;

function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeParts(value, allowRoot = false) {
  if (allowRoot && value === "") return [];
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw new Error("课题文件路径无效。");
  }
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("课题文件路径无效。");
  return parts;
}

async function checkedPath(projectRoot, value, { allowRoot = false, allowMissing = false } = {}) {
  const root = await realpath(projectRoot);
  const parts = safeParts(value, allowRoot);
  const target = resolve(root, ...parts);
  if (!inside(root, target)) throw new Error("课题文件不能离开当前课题目录。");
  let cursor = root;
  let info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error("课题目录不能是符号链接。");
  for (const part of parts) {
    cursor = join(cursor, part);
    try { info = await lstat(cursor); }
    catch (error) {
      if (allowMissing && error.code === "ENOENT") return { root, path: target, exists: false };
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error("不支持通过符号链接访问课题文件。");
  }
  return { root, path: target, info, exists: true };
}

function visibleName(name, showSystemFiles) {
  if (hiddenNames.has(name)) return false;
  return showSystemFiles || !systemNames.has(name);
}

export async function listProjectFiles(projectRoot, { showSystemFiles = false, path = "" } = {}) {
  const root = await realpath(projectRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("课题目录无效。");
  const directory = await checkedPath(root, path, { allowRoot: true });
  if (!directory.info?.isDirectory?.() && path !== "") throw new Error("课题文件夹无效。");
  const entries = await readdir(directory.path, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries) {
    if (!visibleName(entry.name, showSystemFiles)) continue;
    const childPath = path ? `${path}/${entry.name}` : entry.name;
    const absolute = join(directory.path, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      nodes.push({ name: entry.name, path: childPath, kind: "directory", size: 0, modifiedAt: info.mtime.toISOString(), children: [], childrenLoaded: false });
    } else if (info.isFile()) {
      nodes.push({ name: entry.name, path: childPath, kind: "file", size: info.size, modifiedAt: info.mtime.toISOString(), children: [], childrenLoaded: true });
    }
  }
  return nodes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) || a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" }));
}

export async function resolveProjectEntry(projectRoot, path) {
  const entry = await checkedPath(projectRoot, path);
  if (!entry.info.isFile() && !entry.info.isDirectory()) throw new Error("不支持打开这种课题文件。");
  return entry.path;
}

function safeName(path) {
  const name = basename(resolve(path)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[ .]+$/g, "").trim();
  if (!name || name === "." || name === "..") throw new Error("文件或文件夹名称无效。");
  return name;
}

function safeSegment(value) {
  const name = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[ .]+$/g, "").trim();
  if (!name || name === "." || name === "..") throw new Error("文件或文件夹名称无效。");
  return name;
}

async function uniqueDestination(directory, name) {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let index = 1; index <= 10_000; index += 1) {
    const candidateName = index === 1 ? name : `${stem} (${index})${ext}`;
    const candidate = join(directory, candidateName);
    try { await lstat(candidate); }
    catch (error) { if (error.code === "ENOENT") return candidate; throw error; }
  }
  throw new Error("同名文件过多，无法自动命名。");
}

async function copyTree(source, destination, state, depth = 0) {
  if (depth > 32) throw new Error("导入文件夹嵌套超过 32 层。");
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error("导入内容包含符号链接，已停止复制。");
  if (info.isDirectory()) {
    await mkdir(destination);
    const children = await readdir(source, { withFileTypes: true });
    for (const child of children) {
      if (hiddenNames.has(child.name)) continue;
      const sourceChild = join(source, child.name);
      const targetChild = join(destination, child.name);
      const childInfo = await lstat(sourceChild);
      if (childInfo.isSymbolicLink()) throw new Error("导入内容包含符号链接，已停止复制。");
      await copyTree(sourceChild, targetChild, state, depth + 1);
    }
  } else if (info.isFile()) {
    if (state.files >= 10_000) throw new Error("单次最多导入 10,000 个文件。");
    await copyFile(source, destination, copyFlags);
    state.files += 1;
  } else {
    throw new Error("不支持导入快捷方式或特殊文件。");
  }
}

export async function importIntoProject(projectRoot, sourcePaths, targetPath = "") {
  if (!Array.isArray(sourcePaths) || sourcePaths.length > 500) throw new Error("一次最多导入 500 个文件或文件夹。");
  const target = await checkedPath(projectRoot, targetPath, { allowRoot: true });
  if (!target.info.isDirectory()) throw new Error("导入目标必须是课题文件夹。");
  const copied = [];
  const state = { files: 0 };

  for (const rawPath of sourcePaths) {
    const entry = typeof rawPath === "string" ? { path: rawPath } : rawPath;
    if (typeof entry?.path !== "string" || !entry.path.trim()) continue;
    const source = resolve(entry.path);
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error("不能导入符号链接。");
    const sourceReal = await realpath(source);
    if (inside(sourceReal, target.path) || (info.isDirectory() && inside(sourceReal, target.root))) {
      throw new Error("不能把课题目录导入到自身或其子目录中。");
    }
    if (entry.relativePath) {
      if (!info.isFile()) throw new Error("拖入目录的相对路径只能用于文件。");
      const segments = safeParts(entry.relativePath).map(safeSegment);
      let parent = target.path;
      const targetParts = [...safeParts(targetPath, true), ...segments.slice(0, -1)];
      let cursor = target.root;
      for (const part of targetParts) {
        cursor = join(cursor, part);
        try {
          const existing = await lstat(cursor);
          if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error("导入目标包含不安全的同名路径。");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await mkdir(cursor);
        }
        parent = cursor;
      }
      const destination = await uniqueDestination(parent, segments.at(-1));
      if (state.files >= 10_000) throw new Error("单次最多导入 10,000 个文件。");
      await copyFile(sourceReal, destination, copyFlags);
      state.files += 1;
      copied.push(relative(target.root, destination).split(sep).join("/"));
      continue;
    }
    const name = safeName(source);
    const destination = await uniqueDestination(target.path, name);
    await copyTree(sourceReal, destination, state);
    copied.push(relative(target.root, destination).split(sep).join("/"));
  }
  return copied;
}
