import { access, readFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectIdPattern = /^[0-9a-f-]{36}$/i;

export function isProjectId(value) {
  return typeof value === "string" && projectIdPattern.test(value);
}

export function projectDirectoryName(title, projectId) {
  if (!isProjectId(projectId)) throw new Error("课题编号无效。");
  const readable = Array.from(String(title ?? "").normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, ""))
    .slice(0, 80)
    .join("") || "课题";
  return `${readable}--${projectId}`;
}

export async function discoverProjectDirectories(projectsRoot) {
  const entries = await readdir(projectsRoot, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const root = join(projectsRoot, entry.name);
    let project;
    try {
      project = JSON.parse(await readFile(join(root, "project.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (isProjectId(project?.id)) projects.push({ project, root });
  }
  return projects;
}

export async function renameProjectDirectory(projectsRoot, currentRoot, project) {
  const targetRoot = join(projectsRoot, projectDirectoryName(project.title, project.id));
  if (resolve(currentRoot) === resolve(targetRoot)) return currentRoot;
  try {
    await access(targetRoot);
    const error = new Error("目标课题目录已存在。");
    error.code = "EEXIST";
    throw error;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rename(currentRoot, targetRoot);
  return targetRoot;
}
