import { spawn } from "node:child_process";
import { copyFile, lstat, mkdtemp, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand, withIterationEnvironment } from "./iteration-runtime.mjs";
import { runCommand } from "./iteration-github.mjs";

async function cleanMain(binding, git) {
  if (await git(binding.path, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "") !== binding.main) throw new Error(`请先切换到本地主线 ${binding.main}。`);
  if (await git(binding.path, "status", "--porcelain")) throw new Error("源码仓库有未提交或未跟踪的文件，未执行本地更新。 ");
  return git(binding.path, "rev-parse", "HEAD");
}

async function directory(path) {
  const info = await lstat(path).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`不操作链接或非目录：${path}`);
  return Boolean(info);
}

export async function applyLocalUpdate({ binding, target, git, run = runCommand }) {
  const path = binding.path;
  const previous = await cleanMain(binding, git);
  if (previous === target) throw new Error("本地主线已经在此提交，无需更新。 ");
  await git(path, "merge-base", "--is-ancestor", previous, target).catch(() => { throw new Error("无法快进至该合并，请检查本地主线是否已前进或分叉。 "); });
  const changedLock = Boolean(await git(path, "diff", "--name-only", previous, target, "--", "package-lock.json"));
  if (!await directory(join(path, "dist"))) throw new Error("找不到当前构建的 dist，无法保留回退版本。 ");
  const hasModules = await directory(join(path, "node_modules"));
  const install = changedLock || !hasModules;
  const storage = await realpath(await git(path, "rev-parse", "--absolute-git-dir"));
  const backup = await mkdtemp(join(storage, "autoresearch-update-"));
  const update = { path, previous, target, backup, install, hasModules };
  await writeFile(join(backup, "update.json"), JSON.stringify(update, null, 2), { flag: "wx" });
  let movedDist = false, movedModules = false, advanced = false;
  try {
    await rename(join(path, "dist"), join(backup, "dist"));
    movedDist = true;
    if (changedLock && hasModules) {
      await rename(join(path, "node_modules"), join(backup, "node_modules"));
      movedModules = true;
    }
    if (await cleanMain(binding, git) !== previous) throw new Error("准备更新时本地主线已变化。 ");
    await git(path, "merge", "--ff-only", "--no-overwrite-ignore", target);
    advanced = true;
    await withIterationEnvironment(async (env) => {
      const npm = (args) => {
        const [file, commandArgs] = npmCommand(args);
        return run(file, commandArgs, { cwd: path, env, timeout: 600_000 });
      };
      if (install) await npm(["ci", "--prefer-offline"]);
      await npm(["run", "build"]);
    });
    await readFile(join(path, "dist", "index.html"));
    if (await cleanMain(binding, git) !== target) throw new Error("构建期间源码发生变化。 ");
    return update;
  } catch (error) {
    try {
      if (advanced) {
        if (await cleanMain(binding, git) !== target) throw new Error("工作树已变化，不覆盖现有修改。");
        await git(path, "reset", "--keep", previous);
      }
      if (movedDist) await replaceDirectory(path, backup, "dist", true);
      if (movedModules || (advanced && !hasModules)) await replaceDirectory(path, backup, "node_modules", movedModules);
    } catch (restoreError) {
      throw new Error(`更新失败：${error.message}\n自动恢复未完成：${restoreError.message}\n备份：${backup}`);
    }
    throw new Error(`更新失败，已恢复本地主线和旧构建：${error.message}`);
  }
}

export async function prepareUpdateHelper({ binding, target, update, restart, git }) {
  const current = await cleanMain(binding, git);
  if (update ? current !== update.target : current === target) throw new Error("本地主线已在其他提交，不执行延迟更新。");
  if (!update) await git(binding.path, "merge-base", "--is-ancestor", current, target);
  const storage = await realpath(await git(binding.path, "rev-parse", "--absolute-git-dir"));
  const folder = await mkdtemp(join(storage, "autoresearch-restart-"));
  for (const file of ["iteration-update-helper.mjs", "iteration-update.mjs", "iteration-runtime.mjs", "iteration-github.mjs"]) {
    await copyFile(fileURLToPath(new URL(file, import.meta.url)), join(folder, file));
  }
  const request = { binding, target, update, current, restart, pid: process.pid };
  await writeFile(join(folder, "request.json"), JSON.stringify(request), { flag: "wx" });
  return folder;
}

export async function startUpdateHelper(folder) {
  const log = await open(join(folder, "helper.log"), "a");
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn("node", [join(folder, "iteration-update-helper.mjs")], { cwd: folder, env, detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  } finally { await log.close(); }
}

async function replaceDirectory(path, backup, name, restore) {
  const active = join(path, name);
  if (await directory(active)) {
    const displaced = await mkdtemp(join(backup, "displaced-"));
    await rename(active, join(displaced, name));
    if (restore) {
      try { await rename(join(backup, name), active); }
      catch (error) { await rename(join(displaced, name), active); throw error; }
    }
  } else if (restore) await rename(join(backup, name), active);
}

export async function restoreLocalUpdate({ update, binding, git }) {
  const { path, previous, target, backup, install, hasModules } = update;
  if (path !== binding.path || await cleanMain(binding, git) !== target) throw new Error("本地主线已变化，不能自动恢复旧构建。 ");
  const storage = await realpath(await git(path, "rev-parse", "--absolute-git-dir"));
  if (dirname(backup) !== storage || !basename(backup).startsWith("autoresearch-update-") || await realpath(backup) !== backup) throw new Error("本地构建备份目录无效。 ");
  if (!await directory(join(backup, "dist")) || (install && hasModules && !await directory(join(backup, "node_modules")))) throw new Error("旧构建备份不完整。 ");
  if (!await directory(join(path, "dist"))) throw new Error("当前构建不存在，请使用备份手动恢复。 ");
  const scratch = await mkdtemp(join(backup, "restore-"));
  const swapped = [];
  try {
    for (const [name, useBackup] of [["dist", true], ...(install ? [["node_modules", hasModules]] : [])]) {
      const active = join(path, name);
      const present = await directory(active);
      if (present) await rename(active, join(scratch, name));
      const change = { name, active, present, restored: false };
      swapped.push(change);
      if (useBackup) { await rename(join(backup, name), active); change.restored = true; }
    }
    await git(path, "reset", "--keep", previous);
  } catch (error) {
    for (const { name, active, present, restored } of swapped.reverse()) {
      if (restored) await rename(active, join(backup, name));
      if (present) await rename(join(scratch, name), active);
    }
    throw error;
  }
}
