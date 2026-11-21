import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runCommand } from "./iteration-github.mjs";
import { assertWorkspaceSourcesUnchanged, createWorkspaceCommit, scanWorkspaceChanges, workspacePathExclusion } from "./iteration-workspace.mjs";

const git = (cwd, ...args) => runCommand("git", args, { cwd }).then((value) => value.trim());

async function createRepository(context) {
  const temporary = await mkdtemp(join(tmpdir(), "ar-organizer-"));
  context.after(async () => {
    if (!relative(tmpdir(), resolve(temporary)).startsWith("ar-organizer-")) throw new Error("临时目录越界");
    await rm(temporary, { recursive: true, force: true });
  });
  const repository = join(temporary, "source");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Workspace Organizer Test");
  await git(repository, "config", "user.email", "organizer@example.invalid");
  await writeFile(join(repository, "package.json"), JSON.stringify({ name: "autoresearch-desktop", version: "1.0.0", scripts: { test: "node -e \"process.stdout.write('unit tests passed')\"", build: "node -e \"process.stdout.write('build passed')\"" } }, null, 2));
  await writeFile(join(repository, "package-lock.json"), JSON.stringify({ name: "autoresearch-desktop", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "autoresearch-desktop", version: "1.0.0" } } }, null, 2));
  await writeFile(join(repository, ".gitignore"), "node_modules/\n");
  await writeFile(join(repository, ".autoresearch-root"), "AutoResearch root\n");
  await mkdir(join(repository, "electron"));
  await writeFile(join(repository, "electron", "app.mjs"), "export const value = 1;\n");
  await writeFile(join(repository, "index.html"), "<main>base</main>\n");
  await writeFile(join(repository, "README.md"), "base\n");
  await mkdir(join(repository, "data"), { recursive: true });
  await writeFile(join(repository, "data", "private.json"), "{\"not\":\"for tests\"}\n");
  await mkdir(join(repository, "versions"), { recursive: true });
  await writeFile(join(repository, "versions", "latest.json"), "{\"not\":\"for tests\"}\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "base");
  return { temporary, repository };
}

test("工作区扫描只开放明确源码白名单并排除归档、数据和凭据", async (context) => {
  const { repository } = await createRepository(context);
  await writeFile(join(repository, "electron", "app.mjs"), "export const value = 2;\n");
  await writeFile(join(repository, "index.html"), "<main>updated</main>\n");
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src", "new.ts"), "export const ready = true;\n");
  await writeFile(join(repository, "electron", ".env.local"), "SECRET=hidden\n");
  await mkdir(join(repository, "versions", "0.5.6", "source"), { recursive: true });
  await writeFile(join(repository, "versions", "0.5.6", "source", "app.mjs"), "not included\n");
  await mkdir(join(repository, "data"), { recursive: true });
  await writeFile(join(repository, "data", "project.json"), "{}\n");

  const inventory = await scanWorkspaceChanges(repository, runCommand);
  assert.deepEqual(inventory.files.map((file) => file.path), ["electron/.env.local", "electron/app.mjs", "index.html", "src/new.ts"]);
  assert.equal(inventory.files[0].eligible, false);
  assert.match(inventory.files[0].reason, /凭据/);
  assert.equal(inventory.files[1].eligible, true);
  assert.equal(inventory.files[2].eligible, true);
  assert.equal(inventory.files[3].status, "added");
  assert.equal(workspacePathExclusion("index.html"), null);
  assert.equal(workspacePathExclusion(".autoresearch-root"), null);
  assert.equal(workspacePathExclusion("versions/0.5.6/source/app.mjs"), "不在源码纳入白名单内");
  assert.equal(workspacePathExclusion("data/project.json"), "不在源码纳入白名单内");
  assert.equal(workspacePathExclusion("codex/core/src/lib.rs"), "不在源码纳入白名单内");
  assert.match(workspacePathExclusion("src/node_modules/dependency.js"), /归档、数据/);
});

test("候选只提交用户选中的文件，不改变原工作区或索引", async (context) => {
  const { temporary, repository } = await createRepository(context);
  await writeFile(join(repository, "electron", "app.mjs"), "export const value = 2;\n");
  await writeFile(join(repository, "README.md"), "staged only change\n");
  await git(repository, "add", "README.md");
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src", "new.ts"), "export const ready = true;\n");
  const inventory = await scanWorkspaceChanges(repository, runCommand);
  const before = await git(repository, "status", "--porcelain");
  const root = join(temporary, "iterations", "workspace-organizer", "12345678-1234-4234-8234-123456789abc");
  const worktree = join(root, "candidate");
  const branch = "organize/workspace-12345678-1234-4234-8234-123456789abc";
  await mkdir(join(temporary, "iterations", "workspace-organizer"), { recursive: true });
  const candidate = await createWorkspaceCommit({ repository, inventory, selected: ["electron/app.mjs"], worktree, branch, run: runCommand });
  assert.equal(await git(worktree, "rev-parse", "HEAD"), candidate.sha);
  assert.equal(await git(repository, "status", "--porcelain"), before);
  assert.equal(await git(repository, "diff", "--cached", "--name-only"), "README.md");
  assert.deepEqual((await git(repository, "diff", "--name-only", inventory.baseSha, candidate.sha)).split(/\r?\n/).filter(Boolean), ["electron/app.mjs"]);
  await writeFile(join(repository, "electron", "app.mjs"), "source edit after candidate\n");
  await assert.rejects(assertWorkspaceSourcesUnchanged(repository, inventory, ["electron/app.mjs"], runCommand), /发生变化/);
  await runCommand("git", ["worktree", "remove", "--force", worktree], { cwd: repository });
  await runCommand("git", ["branch", "-D", branch], { cwd: repository });
});

test("盘点后源码变化会阻止生成候选", async (context) => {
  const { repository } = await createRepository(context);
  await writeFile(join(repository, "electron", "app.mjs"), "export const value = 2;\n");
  const inventory = await scanWorkspaceChanges(repository, runCommand);
  await writeFile(join(repository, "electron", "app.mjs"), "export const value = 3;\n");
  await assert.rejects(assertWorkspaceSourcesUnchanged(repository, inventory, ["electron/app.mjs"], runCommand), /发生变化/);
});

test("候选验证在独立无凭据克隆中依次安装、测试和构建", async (context) => {
  const { temporary, repository } = await createRepository(context);
  const { validateWorkspaceCandidate } = await import("./iteration-workspace.mjs");
  await writeFile(join(repository, "electron", "app.mjs"), "export const value = 2;\n");
  const inventory = await scanWorkspaceChanges(repository, runCommand);
  const organizerRoot = join(temporary, "iterations", "workspace-organizer", "12345678-1234-4234-8234-123456789abc");
  const worktree = join(organizerRoot, "candidate");
  const branch = "organize/workspace-12345678-1234-4234-8234-123456789abc";
  const candidate = await createWorkspaceCommit({ repository, inventory, selected: ["electron/app.mjs"], worktree, branch, run: runCommand });
  const updates = [];
  const validation = await validateWorkspaceCandidate({ repository, worktree, tempDirectory: organizerRoot, sha: candidate.sha, branch, run: runCommand, onStep: async (step) => updates.push(step) });
  assert.equal(validation.result, "success");
  assert.deepEqual(validation.steps.map(({ name, exitCode }) => [name, exitCode]), [["安装依赖", 0], ["单元测试", 0], ["构建", 0]]);
  assert.equal(updates.filter((step) => step.started).length, 3);
  assert.equal(await git(join(organizerRoot, "test-tree"), "remote"), "");
  assert.equal(await readFile(join(organizerRoot, "test-tree", "index.html"), "utf8"), "<main>base</main>\n");
  assert.equal(await readFile(join(organizerRoot, "test-tree", ".autoresearch-root"), "utf8"), "AutoResearch root\n");
  await assert.rejects(readFile(join(organizerRoot, "test-tree", "data", "private.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(organizerRoot, "test-tree", "versions", "latest.json")), { code: "ENOENT" });
  await runCommand("git", ["worktree", "remove", "--force", worktree], { cwd: repository });
  await runCommand("git", ["branch", "-D", branch], { cwd: repository });
});
