import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runCommand } from "./iteration-github.mjs";
import { copyPreviewData, seedDependencies, unitTestFiles } from "./iteration-runtime.mjs";
import { applyLocalUpdate, prepareUpdateHelper, restoreLocalUpdate, startUpdateHelper } from "./iteration-update.mjs";

async function temporary(context) {
  const root = await mkdtemp(join(tmpdir(), "ar-update-test-"));
  context.after(async () => {
    if (dirname(root) !== tmpdir() || !basename(root).startsWith("ar-update-test-")) throw new Error("临时目录越界");
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

const git = (cwd, ...args) => runCommand("git", args, { cwd }).then((output) => output.trim());

async function repository(context, { lockChanged = false, fail = false } = {}) {
  const path = await temporary(context);
  const binding = { path, main: "main" };
  await git(path, "init", "-b", "main");
  await git(path, "config", "core.autocrlf", "false");
  await git(path, "config", "user.name", "Test");
  await git(path, "config", "user.email", "test@example.invalid");
  await writeFile(join(path, ".gitignore"), "dist/\nnode_modules/\n");
  for (const [file, value] of Object.entries({
    "package.json": { name: "synthetic-update", version: "1.0.0", scripts: { build: "node build.cjs" } },
    "package-lock.json": { name: "synthetic-update", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "synthetic-update", version: "1.0.0" } } },
  })) await writeFile(join(path, file), JSON.stringify(value));
  await writeFile(join(path, "build.cjs"), 'const fs = require("node:fs"); fs.mkdirSync("dist"); fs.writeFileSync("dist/index.html", "built after exit");');
  await writeFile(join(path, "app.txt"), "old\n");
  await git(path, "add", ".");
  await git(path, "commit", "-m", "old");
  const previous = await git(path, "rev-parse", "HEAD");
  await writeFile(join(path, "app.txt"), "new\n");
  if (lockChanged) await writeFile(join(path, "package-lock.json"), (await readFile(join(path, "package-lock.json"), "utf8")) + "\n");
  await git(path, "commit", "-am", "new");
  const target = await git(path, "rev-parse", "HEAD");
  await git(path, "reset", "--keep", previous);
  await mkdir(join(path, "dist"));
  await mkdir(join(path, "node_modules"));
  await writeFile(join(path, "dist", "index.html"), "old\n");
  await writeFile(join(path, "node_modules", "state.txt"), "old\n");
  const commands = [];
  const run = async (_file, args) => {
    if (args.includes("ci")) {
      commands.push("ci");
      await mkdir(join(path, "node_modules"));
      await writeFile(join(path, "node_modules", "state.txt"), "new\n");
    } else {
      commands.push("build");
      await mkdir(join(path, "dist"));
      await writeFile(join(path, "dist", "index.html"), "new\n");
      if (fail) throw new Error("模拟构建失败");
    }
  };
  return { path, binding, previous, target, commands, git, run };
}

test("更新快进到指定提交；旧源码、依赖和 dist 可一起恢复", async (context) => {
  const repo = await repository(context, { lockChanged: true });
  const update = await applyLocalUpdate(repo);
  assert.equal(await git(repo.path, "rev-parse", "HEAD"), repo.target);
  assert.deepEqual(repo.commands, ["ci", "build"]);
  assert.equal(await readFile(join(update.backup, "dist", "index.html"), "utf8"), "old\n");
  await restoreLocalUpdate({ ...repo, update });
  assert.equal(await git(repo.path, "rev-parse", "HEAD"), repo.previous);
  assert.equal(await readFile(join(repo.path, "node_modules", "state.txt"), "utf8"), "old\n");
  assert.equal(await readFile(join(repo.path, "dist", "index.html"), "utf8"), "old\n");
});

test("构建失败恢复旧 HEAD、dist 和依赖", async (context) => {
  const repo = await repository(context, { lockChanged: true, fail: true });
  await assert.rejects(applyLocalUpdate(repo), /已恢复.*模拟构建失败/);
  assert.equal(await git(repo.path, "rev-parse", "HEAD"), repo.previous);
  assert.equal(await readFile(join(repo.path, "dist", "index.html"), "utf8"), "old\n");
  assert.equal(await readFile(join(repo.path, "node_modules", "state.txt"), "utf8"), "old\n");
});

test("工作树脏时拒绝更新；未改变 lock 时不运行 ci", async (context) => {
  const repo = await repository(context);
  const changed = join(repo.path, "app.txt");
  await writeFile(changed, "uncommitted\n");
  await assert.rejects(applyLocalUpdate(repo), /未提交/);
  assert.equal(await readFile(changed, "utf8"), "uncommitted\n");
  await git(repo.path, "restore", "--", "app.txt");
  await applyLocalUpdate(repo);
  assert.deepEqual(repo.commands, ["build"]);
});

test("延迟更新器等待应用退出、执行真实构建并请求重启", async (context) => {
  const repo = await repository(context, { lockChanged: true });
  const original = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", windowsHide: true });
  const exited = once(original, "exit");
  context.after(async () => { original.kill(); await exited; });
  await once(original, "spawn");
  const marker = join(repo.path, "dist", "relaunched");
  const folder = await prepareUpdateHelper({ ...repo, restart: { executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready')`] } });
  const requestFile = join(folder, "request.json");
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  await writeFile(requestFile, JSON.stringify({ ...request, pid: original.pid }));
  await startUpdateHelper(folder);
  await delay(350);
  assert.equal(await git(repo.path, "rev-parse", "HEAD"), repo.previous);
  original.kill();
  await exited;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await readFile(marker, "utf8").catch(() => "") === "ready") break;
    await delay(250);
  }
  const result = JSON.parse(await readFile(join(folder, "result.json"), "utf8"));
  assert.equal(result.ok, true, result.error);
  assert.equal(await readFile(marker, "utf8"), "ready");
  assert.equal(await git(repo.path, "rev-parse", "HEAD"), repo.target);
  assert.equal(await readFile(join(repo.path, "dist", "index.html"), "utf8"), "built after exit");
});

test("快照不复制环境、产物、凭据或指向正式数据的链接", async (context) => {
  const root = await temporary(context);
  const source = join(root, "source");
  const snapshot = join(root, "snapshot");
  const project = join(source, "Projects", "example");
  await mkdir(join(project, "workspace", "runs"), { recursive: true });
  await writeFile(join(project, "project.json"), "{}\n");
  await writeFile(join(project, "api-key.bin"), "synthetic");
  await writeFile(join(project, "workspace", "runs", "large.txt"), "synthetic");
  await symlink(project, join(source, "linked"), process.platform === "win32" ? "junction" : "dir");
  await copyPreviewData(source, snapshot);
  const cloned = join(snapshot, "Projects", "example");
  await writeFile(join(cloned, "project.json"), '{"preview":true}\n');
  assert.equal(await readFile(join(project, "project.json"), "utf8"), "{}\n");
  await assert.rejects(readFile(join(snapshot, "linked", "project.json")));
  await assert.rejects(readFile(join(cloned, "workspace", "runs", "large.txt")));
  await assert.rejects(readFile(join(cloned, "api-key.bin")));
  await assert.rejects(copyPreviewData(source, join(source, "nested")), /不能写入/);
});

test("单元回归收集历次和本次的验收测试，不重复运行场景", async (context) => {
  const root = await temporary(context);
  for (const entry of ["tests/acceptance/iter-1", "tests/acceptance/iter-2/nested", "electron"]) await mkdir(join(root, entry), { recursive: true });
  for (const file of ["tests/acceptance/iter-1/old.test.mjs", "tests/acceptance/iter-2/nested/new.test.mjs", "tests/acceptance/iter-2/window.spec.mjs", "electron/base.test.mjs"]) await writeFile(join(root, file), "");
  assert.deepEqual(await unitTestFiles(root), ["electron/base.test.mjs", "tests/acceptance/iter-1/old.test.mjs", "tests/acceptance/iter-2/nested/new.test.mjs"]);
});

test("相同锁文件可复制本地依赖，但写入候选不改变原安装", async (context) => {
  const root = await temporary(context);
  const source = join(root, "source");
  const candidate = join(root, "candidate");
  const modules = join(source, "node_modules");
  const lock = JSON.stringify({ packages: { "node_modules/electron": { version: "45.0.0", integrity: "mocked" } } });
  const sha = createHash("sha256").update(lock).digest("hex");
  await mkdir(join(modules, "electron", "dist"), { recursive: true });
  await mkdir(candidate);
  await writeFile(join(source, "package-lock.json"), lock);
  await writeFile(join(modules, ".package-lock.json"), lock);
  await writeFile(join(modules, "electron", "dist", "version"), "45.0.0");
  assert.equal(await seedDependencies(candidate, source, "different"), false);
  assert.equal(await seedDependencies(candidate, source, sha), true);
  await writeFile(join(candidate, "node_modules", "electron", "dist", "version"), "modified");
  assert.equal(await readFile(join(modules, "electron", "dist", "version"), "utf8"), "45.0.0");
});
