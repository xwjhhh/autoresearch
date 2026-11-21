import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectDirectoryName } from "../electron/project-directories.mjs";

export const fixture = {
  projectId: "50100000-0000-4000-8000-000000000001",
  projectTitle: "迭代测试示例课题",
  experimentId: "exp_001",
  experimentTitle: "示例复现实验",
  failedJob: "fixture-failed-job",
  failure: "Fixture error: expected input is missing",
};

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function paperPdf(text) {
  const stream = `BT /F1 18 Tf 60 700 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const xref = ["0000000000 65535 f "];
  for (const [index, object] of objects.entries()) {
    xref.push(`${String(pdf.length).padStart(10, "0")} 00000 n `);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  return `${pdf}xref\n0 ${xref.length}\n${xref.join("\n")}\ntrailer\n<< /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;
}

export async function prepareIterationFixture(directory) {
  const { projectId, projectTitle, experimentId, experimentTitle, failure, failedJob } = fixture;
  const date = "2026-01-01T00:00:00.000Z";
  const root = join(directory, "Projects", projectDirectoryName(projectTitle, projectId));
  const papers = [];
  for (const number of [1, 2]) {
    const id = `paper_00${number}`;
    const title = `示例论文 ${number}`;
    const text = `AutoResearch sample paper ${number}`;
    const pdf = paperPdf(text);
    const paper = { id, title, filename: `${id}.pdf`, importedAt: date, pageCount: 1, chunkCount: 1, sourceSha256: createHash("sha256").update(pdf).digest("hex"), status: "ready", analysisStatus: "none" };
    papers.push(paper);
    const folder = join(root, "PaperInfo", "references", id);
    await write(join(folder, "original.pdf"), pdf);
    await write(join(folder, "parsed", "chunks.jsonl"), `${JSON.stringify({ id: `${id}_001`, paperId: id, page: 1, text })}\n`);
  }
  await write(join(root, "project.json"), json({ id: projectId, title: projectTitle, direction: "合成示例数据，仅供应用迭代试用。", createdAt: date, updatedAt: date, papers, ideas: [], messages: [] }));
  const experiment = join(root, "Experiments", "PaperReproductions", experimentId);
  const conversationId = "conv_001";
  await write(join(experiment, "experiment.json"), json({ id: experimentId, projectId, title: experimentTitle, kind: "reproduction", paperId: papers[0].id, paperTitle: papers[0].title, goal: "验证后台任务失败及重试体验。", settings: { continuous: false, network: false, approveJobs: true }, agent: "idle", conversations: [{ id: conversationId, title: "示例会话", createdAt: date, updatedAt: date }], conversationSchemaVersion: 1, createdAt: date, updatedAt: date }));
  await write(join(experiment, "workspace", "REPRO.md"), "# 示例复现实验\n\n用于应用迭代验收。\n");
  for (const [id, name, status, command, lastLine] of [
    ["job_001", failedJob, "failed", "node -e \"console.error('Fixture error: expected input is missing'); process.exit(1)\"", failure],
    ["job_002", "fixture-completed-job", "done", "node -e \"console.log('completed')\"", "completed"],
  ]) {
    const log = `.ar/logs/${id}-${name}.log`;
    await write(join(experiment, "jobs", `${id}.json`), json({ id, name, status, command, cwd: ".", note: "合成任务", conversationId, requestedAt: date, startedAt: date, finishedAt: date, exitCode: status === "failed" ? 1 : 0, log, lastLine }));
    await write(join(experiment, "workspace", log), `${lastLine}\n`);
  }
  return fixture;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("请指定示例数据目录。");
  await prepareIterationFixture(resolve(process.argv[2]));
}
