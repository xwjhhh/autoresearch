import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDefaultDataRoot } from "./data-path.mjs";

test("development defaults to the data folder beside the app source", () => {
  const projectRoot = resolve("C:/work/desktop-app");
  assert.equal(
    resolveDefaultDataRoot({ isDev: true, sourceDirectory: join(projectRoot, "electron") }),
    join(projectRoot, "data"),
  );
});

test("packaged builds use data beside the marked project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-data-path-"));
  try {
    const exeDirectory = join(root, "versions", "0.1.6", "windows", "win-unpacked");
    await mkdir(exeDirectory, { recursive: true });
    await writeFile(join(root, ".autoresearch-root"), "AutoResearch project root\n");
    assert.equal(
      resolveDefaultDataRoot({
        isDev: false,
        executablePath: join(exeDirectory, "AutoResearch.exe"),
        documentsPath: join(root, "Documents"),
      }),
      join(root, "data"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged installs outside the project use Documents as a fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-data-path-"));
  try {
    assert.equal(
      resolveDefaultDataRoot({
        isDev: false,
        executablePath: join(root, "Program Files", "AutoResearch", "AutoResearch.exe"),
        documentsPath: join(root, "Documents"),
      }),
      join(root, "Documents", "AutoResearch"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit data directory overrides the default", () => {
  assert.equal(
    resolveDefaultDataRoot({ isDev: true, sourceDirectory: "C:/work/app/electron", envPath: "C:/custom/data" }),
    resolve("C:/custom/data"),
  );
});
