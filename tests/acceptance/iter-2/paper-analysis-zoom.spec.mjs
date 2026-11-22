import { captureFixture, expect, fixture, test } from "../../e2e/electron-fixture.mjs";

test("课题分析时可以放大文献", async ({ desktop }, info) => {
  const { page } = desktop;
  await page.getByRole("button", { name: fixture.projectTitle, exact: true }).click();
  await page.getByRole("navigation", { name: "研究", exact: true }).getByRole("button", { name: /^文献分析/ }).click();
  const paper = await page.evaluate(async (projectId) => (await window.autoresearch.loadWorkspace()).projects.find((project) => project.id === projectId)?.papers[0], fixture.projectId);
  expect(paper).toBeDefined();
  await page.getByRole("region", { name: "论文列表", exact: true }).getByRole("button", { name: paper.title }).click();

  const viewer = page.getByRole("region", { name: `阅读 ${paper.title}`, exact: true });
  await expect(viewer).toBeVisible();
  const pdfPage = viewer.getByLabel(`${paper.title} 第 1 页`, { exact: true });
  await expect(pdfPage).toBeVisible();
  await captureFixture(desktop.app, info.outputPath("paper-analysis-pdf-zoom.png"));

  const zoomIn = viewer.getByRole("button", { name: "放大", exact: true });
  await expect(zoomIn).toBeVisible();
  const originalWidth = await pdfPage.evaluate((canvas) => canvas.getBoundingClientRect().width);
  await zoomIn.click();
  await expect.poll(() => pdfPage.evaluate((canvas) => canvas.getBoundingClientRect().width)).toBeGreaterThan(originalWidth);
});
