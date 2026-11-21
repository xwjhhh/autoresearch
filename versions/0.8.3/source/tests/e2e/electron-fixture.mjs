import { _electron as electron } from "playwright";
import { expect, test as base } from "playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, prepareIterationFixture } from "../../scripts/iteration-fixture.mjs";

export { expect, fixture };

export async function captureFixture(app, path) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true, stayAwake: true });
    return image.toPNG().toString("base64");
  });
  if (!png) throw new Error("候选窗口截图为空。");
  await writeFile(path, Buffer.from(png, "base64"));
}

export async function launchFixture(testInfo, { name = "main", preview = false, data, settings, iterationState } = {}) {
  const profile = testInfo.outputPath(`${name}-profile`);
  const dataPath = data || testInfo.outputPath(`${name}-data`);
  await mkdir(profile, { recursive: true });
  if (settings) await writeFile(join(profile, "settings.json"), settings);
  if (iterationState) {
    await mkdir(join(profile, "iterations"), { recursive: true });
    await writeFile(join(profile, "iterations", "state.json"), JSON.stringify(iterationState));
  }
  await prepareIterationFixture(dataPath);
  const env = { ...process.env, AUTORESEARCH_E2E_HIDDEN: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.AUTORESEARCH_E2E_EXECUTABLE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ["."]), "--profile", profile, "--data-dir", dataPath, ...(preview ? ["--iteration-preview"] : [])], env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: fixture.projectTitle }).waitFor();
  return { app, page, profile, data: dataPath, settings: join(profile, "settings.json") };
}

export const test = base.extend({
  desktop: async ({}, use, testInfo) => {
    const desktop = await launchFixture(testInfo);
    try { await use(desktop); }
    finally { await desktop.app.close(); }
  },
});
