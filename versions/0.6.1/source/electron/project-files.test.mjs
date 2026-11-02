import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importIntoProject, listProjectFiles, resolveProjectEntry } from "./project-files.mjs";

async function withRoots(run) {
  const base = await mkdtemp(join(tmpdir(), "autoresearch-project-files-"));
  const project = join(base, "project");
  const source = join(base, "source");
  await mkdir(project);
  await mkdir(source);
  try { await run({ base, project, source }); }
  finally { await rm(base, { recursive: true, force: true }); }
}

test("lists nested files and hides internal metadata unless requested", async () => {
  await withRoots(async ({ project }) => {
    await mkdir(join(project, "PaperInfo", "references"), { recursive: true });
    await writeFile(join(project, "project.json"), "{}");
    await writeFile(join(project, "PaperInfo", "references", "paper.pdf"), "pdf");
    const visible = await listProjectFiles(project);
    assert.equal(visible[0].name, "PaperInfo");
    assert.equal(visible[0].children.length, 0);
    assert.equal(visible[0].childrenLoaded, false);
    const paperInfo = await listProjectFiles(project, { path: "PaperInfo" });
    assert.equal(paperInfo[0].name, "references");
    assert.equal(paperInfo[0].childrenLoaded, false);
    const references = await listProjectFiles(project, { path: "PaperInfo/references" });
    assert.equal(references[0].name, "paper.pdf");
    assert.equal(references[0].childrenLoaded, true);
    assert.equal((await listProjectFiles(project, { showSystemFiles: true })).some((item) => item.name === "project.json"), true);
  });
});

test("imports files and folders without overwriting same-name project entries", async () => {
  await withRoots(async ({ project, source }) => {
    await mkdir(join(project, "PaperInfo", "attachments"), { recursive: true });
    await mkdir(join(source, "bundle"));
    await writeFile(join(source, "notes.md"), "first");
    await writeFile(join(source, "bundle", "data.csv"), "1,2");
    const first = await importIntoProject(project, [join(source, "notes.md"), join(source, "bundle")], "PaperInfo/attachments");
    const second = await importIntoProject(project, [join(source, "notes.md")], "PaperInfo/attachments");
    assert.deepEqual(first, ["PaperInfo/attachments/notes.md", "PaperInfo/attachments/bundle"]);
    assert.deepEqual(second, ["PaperInfo/attachments/notes (2).md"]);
    assert.equal(await readFile(join(project, "PaperInfo", "attachments", "bundle", "data.csv"), "utf8"), "1,2");
  });
});

test("rejects traversal and symlinked project entries", async () => {
  await withRoots(async ({ project, source }) => {
    await mkdir(join(project, "PaperInfo"));
    await writeFile(join(source, "outside.txt"), "outside");
    await symlink(source, join(project, "linked"), "junction");
    await assert.rejects(resolveProjectEntry(project, "../outside.txt"), /路径无效/);
    await assert.rejects(resolveProjectEntry(project, "linked/outside.txt"), /符号链接/);
    await assert.rejects(importIntoProject(project, [join(source, "outside.txt")], "../"), /路径无效/);
  });
});
