import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveVersion } from "./archive-version.mjs";

const asar = createRequire(import.meta.url)("@electron/asar");
const version = "7.8.9";
async function put(root, relative, value) {
  const path = join(root, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-release-test-"));
  const pkg = { version, build: { directories: { output: "versions/.build/windows" } } };
  await put(root, "package.json", pkg);
  await put(root, "package-lock.json", { version, packages: { "": { version } } });
  await put(root, "electron/main.mjs", "export const application = true;\n");
  await put(root, "dist/index.html", "<main>application</main>");
  await put(root, "assets/icon.txt", "icon");
  await put(root, "src/app.ts", "export {};");
  await put(root, "scripts/example.mjs", "export {};");
  await put(root, "README.md", "source docs");
  const stage = join(root, "versions/.build/windows");
  const target = join(root, "versions", version);
  async function build({ packagedVersion = version, includeData = false } = {}) {
    const payload = join(root, "fixture-payload");
    await put(payload, "package.json", { version: packagedVersion });
    for (const file of ["electron/main.mjs", "dist/index.html", "assets/icon.txt"]) await put(payload, file, await readFile(join(root, file), "utf8"));
    if (includeData) await put(payload, "data/secret.json", "do not publish");
    await mkdir(join(stage, "win-unpacked/resources"), { recursive: true });
    await asar.createPackage(payload, join(stage, "win-unpacked/resources/app.asar"));
    await put(stage, `AutoResearch-${version}-Windows-Setup.exe`, "installer test fixture");
  }
  return { root, stage, target, build, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("release uses only the canonical version folder and excludes research data from its source snapshot", async () => {
  const ctx = await fixture();
  try {
    await put(ctx.root, "data/chat.json", "preserve research");
    await put(ctx.root, "node_modules/secret.txt", "not source");
    await put(ctx.root, "old-release.zip", "not source");
    await ctx.build();
    const result = await archiveVersion({ root: ctx.root });
    assert.equal(result.archiveDirectory, ctx.target);
    assert.equal(await readFile(join(ctx.target, "source/src/app.ts"), "utf8"), "export {};");
    for (const excluded of ["data", "node_modules", "old-release.zip", "fixture-payload", "versions/.build"]) await assert.rejects(access(join(ctx.target, "source", excluded)), { code: "ENOENT" });
    assert.equal(await readFile(join(ctx.root, "data/chat.json"), "utf8"), "preserve research");
    assert.match(result.installer.sha256, /^[a-f0-9]{64}$/);
    const latest = JSON.parse(await readFile(join(ctx.root, "versions/latest.json"), "utf8"));
    assert.equal(latest.installer, `${version}/windows/AutoResearch-${version}-Windows-Setup.exe`);
    assert.equal(latest.sha256, result.installer.sha256);
    await assert.rejects(access(ctx.stage), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(ctx.root, "versions/.build")), []);
  } finally { await ctx.cleanup(); }
});

test("preflight refuses accidental same-version replacement before building", async () => {
  const ctx = await fixture();
  try {
    await put(ctx.target, "version.json", "existing archive");
    await assert.rejects(archiveVersion({ root: ctx.root, checkOnly: true }), /already exists/);
    const result = await archiveVersion({ root: ctx.root, checkOnly: true, replaceExisting: true });
    assert.equal(result.stagingDirectory, ctx.stage);
    await assert.rejects(access(join(ctx.root, "versions/.build")), { code: "ENOENT" });
  } finally { await ctx.cleanup(); }
});

test("authorized replacement preserves earlier builds, shared packages and notes without nesting history", async () => {
  const ctx = await fixture();
  try {
    await ctx.build();
    await archiveVersion({ root: ctx.root });
    await put(ctx.target, "history/older/keep.txt", "older history");
    await put(ctx.target, "packages/reading.zip", "reading package");
    await put(ctx.target, "docs/release.md", "release notes");
    await ctx.build();
    const result = await archiveVersion({ root: ctx.root, replaceExisting: true });
    assert.equal(await readFile(join(ctx.target, "history/older/keep.txt"), "utf8"), "older history");
    assert.equal(await readFile(join(ctx.target, "packages/reading.zip"), "utf8"), "reading package");
    assert.equal(await readFile(join(ctx.target, "docs/release.md"), "utf8"), "release notes");
    assert.equal(await readFile(join(ctx.target, result.previousBuild, `windows/AutoResearch-${version}-Windows-Setup.exe`), "utf8"), "installer test fixture");
    await assert.rejects(access(join(ctx.target, result.previousBuild, "history")), { code: "ENOENT" });
  } finally { await ctx.cleanup(); }
});

test("version mismatch and noncanonical build output fail preflight", async () => {
  const ctx = await fixture();
  try {
    await put(ctx.root, "package-lock.json", { version: "0.0.0", packages: { "": { version } } });
    await assert.rejects(archiveVersion({ root: ctx.root, checkOnly: true }), /same application version/);
    await put(ctx.root, "package-lock.json", { version, packages: { "": { version } } });
    await put(ctx.root, "package.json", { version, build: { directories: { output: "release-staging" } } });
    await assert.rejects(archiveVersion({ root: ctx.root, checkOnly: true }), /refusing a scattered release/);
  } finally { await ctx.cleanup(); }
});

test("stale packaged runtime is refused and its build files are retained", async () => {
  const ctx = await fixture();
  try {
    await ctx.build();
    await put(ctx.root, "electron/main.mjs", "export const updated = true;");
    await assert.rejects(archiveVersion({ root: ctx.root }), /differs from current source/);
    await access(ctx.stage);
    await assert.rejects(access(ctx.target), { code: "ENOENT" });
  } finally { await ctx.cleanup(); }
});

test("an installer accompanied by the wrong application version cannot be archived", async () => {
  const ctx = await fixture();
  try {
    await ctx.build({ packagedVersion: "0.0.1" });
    await assert.rejects(archiveVersion({ root: ctx.root }), /does not match/);
    await access(ctx.stage);
  } finally { await ctx.cleanup(); }
});

test("research data in app.asar blocks publication", async () => {
  const ctx = await fixture();
  try {
    await ctx.build({ includeData: true });
    await assert.rejects(archiveVersion({ root: ctx.root }), /possible research data/);
    await access(ctx.stage);
  } finally { await ctx.cleanup(); }
});

test("a failure after moving the build restores both the old version and pending build", async () => {
  const ctx = await fixture();
  try {
    await ctx.build();
    await put(ctx.target, "version.json", "original version");
    // A corrupt history file causes failure after the build has been moved.
    await put(ctx.target, "history", "keep this unexpected file");
    await assert.rejects(archiveVersion({ root: ctx.root, replaceExisting: true }));
    assert.equal(await readFile(join(ctx.target, "version.json"), "utf8"), "original version");
    assert.equal(await readFile(join(ctx.target, "history"), "utf8"), "keep this unexpected file");
    await access(join(ctx.stage, `AutoResearch-${version}-Windows-Setup.exe`));
    assert.deepEqual(await readdir(join(ctx.root, "versions/.build")), ["windows"]);
  } finally { await ctx.cleanup(); }
});

test("a concurrent archive lock prevents changes", async () => {
  const ctx = await fixture();
  try {
    await ctx.build();
    await put(ctx.root, "versions/.build/archive.lock", "busy");
    await assert.rejects(archiveVersion({ root: ctx.root }), /may be active/);
    await access(ctx.stage);
    assert.equal(await readFile(join(ctx.root, "versions/.build/archive.lock"), "utf8"), "busy");
  } finally { await ctx.cleanup(); }
});
