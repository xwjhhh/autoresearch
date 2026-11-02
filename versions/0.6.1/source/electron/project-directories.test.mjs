import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProjectDirectories, projectDirectoryName, renameProjectDirectory } from "./project-directories.mjs";

const projectId = "de47d4d6-639b-4050-82df-2c77d0ed7d52";

test("project directory names keep a readable title and stable id", () => {
  assert.equal(projectDirectoryName("RSI", projectId), `RSI--${projectId}`);
  assert.equal(projectDirectoryName("研究: /A?*", projectId), `研究 A--${projectId}`);
  assert.equal(projectDirectoryName("... ", projectId), `课题--${projectId}`);
  assert.equal(projectDirectoryName("😀".repeat(100), projectId).split("--")[0].length <= 160, true);
});

test("project discovery reads identity from project.json in legacy and named folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-project-dirs-"));
  try {
    const projectsRoot = join(root, "Projects");
    const legacyRoot = join(projectsRoot, projectId);
    const namedRoot = join(projectsRoot, `Readable name--${projectId}`);
    await Promise.all([mkdir(legacyRoot, { recursive: true }), mkdir(namedRoot, { recursive: true })]);
    await Promise.all([
      writeFile(join(legacyRoot, "project.json"), JSON.stringify({ id: projectId, title: "Legacy" })),
      writeFile(join(namedRoot, "project.json"), JSON.stringify({ id: "21cb4bae-e446-432f-8734-09c9c0e80b0f", title: "Named" })),
    ]);
    const found = await discoverProjectDirectories(projectsRoot);
    assert.deepEqual(found.map(({ project }) => project.id).sort(), [projectId, "21cb4bae-e446-432f-8734-09c9c0e80b0f"].sort());
    assert.ok(found.some(({ root: path, project }) => path === legacyRoot && project.id === projectId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy project directories rename in place and retain their contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-project-migrate-"));
  try {
    const projectsRoot = join(root, "Projects");
    const legacyRoot = join(projectsRoot, projectId);
    const project = { id: projectId, title: "RSI" };
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(join(legacyRoot, "kept.txt"), "content");
    const renamedRoot = await renameProjectDirectory(projectsRoot, legacyRoot, project);
    assert.equal(renamedRoot, join(projectsRoot, `RSI--${projectId}`));
    assert.equal(await readFile(join(renamedRoot, "kept.txt"), "utf8"), "content");
    await assert.rejects(access(legacyRoot), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project directory migration does not overwrite an existing destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-project-conflict-"));
  try {
    const projectsRoot = join(root, "Projects");
    const legacyRoot = join(projectsRoot, projectId);
    const namedRoot = join(projectsRoot, `RSI--${projectId}`);
    await Promise.all([mkdir(legacyRoot, { recursive: true }), mkdir(namedRoot, { recursive: true })]);
    await assert.rejects(renameProjectDirectory(projectsRoot, legacyRoot, { id: projectId, title: "RSI" }), { code: "EEXIST" });
    await access(legacyRoot);
    await access(namedRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
