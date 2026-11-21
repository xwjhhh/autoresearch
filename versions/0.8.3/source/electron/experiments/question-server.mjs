import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const requestRoot = process.env.AUTORESEARCH_QUESTION_REQUESTS;
const answerRoot = process.env.AUTORESEARCH_QUESTION_ANSWERS;
if (!requestRoot || !answerRoot) throw new Error("AutoResearch question paths are not configured.");

const tool = {
  name: "request_user_input",
  description: "Ask the researcher to make a decision before continuing. This opens a blocking question dialog in AutoResearch. Use 1-3 concise questions with clear options; set isOther=true when a free-form answer should be allowed. Wait for this tool's answer before continuing any work.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "question", "options"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 64 },
            header: { type: "string", maxLength: 40 },
            question: { type: "string", minLength: 1, maxLength: 2000 },
            options: {
              type: "array",
              maxItems: 6,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label"],
                properties: {
                  label: { type: "string", minLength: 1, maxLength: 200 },
                  description: { type: "string", maxLength: 500 },
                },
              },
            },
            isOther: { type: "boolean" },
          },
        },
      },
    },
  },
};

function normalizeQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error("Provide between one and three questions.");
  const ids = new Set();
  return value.map((item) => {
    const id = String(item?.id ?? "").trim().slice(0, 64);
    const question = String(item?.question ?? "").trim().slice(0, 2000);
    const options = Array.isArray(item?.options) ? item.options.slice(0, 6).map((option) => ({
      label: String(option?.label ?? "").trim().slice(0, 200),
      description: String(option?.description ?? "").trim().slice(0, 500),
    })).filter((option) => option.label) : [];
    const isOther = item?.isOther === true;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new Error("Question ids must be unique and use letters, numbers, _ or -.");
    if (!question || (!options.length && !isOther)) throw new Error("Each question needs text and at least one answer choice.");
    ids.add(id);
    return {
      id,
      header: String(item?.header ?? "").trim().slice(0, 40) || `问题 ${ids.size}`,
      question,
      options,
      isOther,
    };
  });
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx");
  try { await file.writeFile(`${JSON.stringify(value)}\n`, "utf8"); }
  finally { await file.close(); }
  await rename(temporary, path);
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(done, milliseconds);
    function done() { signal.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function requestAnswer(requestId, signal) {
  const path = join(answerRoot, `${requestId}.json`);
  for (;;) {
    if (signal.aborted) throw signal.reason;
    try {
      const answer = JSON.parse(await readFile(path, "utf8"));
      if (answer?.requestId === requestId && Array.isArray(answer.answers)) return answer;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await wait(200, signal);
  }
}

const active = new Map();
const output = process.stdout;
function respond(id, result, error) {
  if (id === undefined) return;
  const message = error
    ? { jsonrpc: "2.0", id, error: { code: -32603, message: String(error.message ?? error) } }
    : { jsonrpc: "2.0", id, result };
  output.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "autoresearch-questions", version: "1.0.0" },
    });
    return;
  }
  if (method === "ping") { respond(id, {}); return; }
  if (method === "tools/list") { respond(id, { tools: [tool] }); return; }
  if (method === "tools/call") {
    if (params.name !== tool.name) { respond(id, undefined, new Error("Unknown tool.")); return; }
    const controller = new AbortController();
    active.set(id, controller);
    try {
      const questions = normalizeQuestions(params.arguments?.questions);
      const requestId = randomUUID();
      await mkdir(requestRoot, { recursive: true });
      await mkdir(answerRoot, { recursive: true });
      await atomicJson(join(requestRoot, `${requestId}.json`), { requestId, createdAt: new Date().toISOString(), questions });
      const answer = await requestAnswer(requestId, controller.signal);
      await Promise.all([
        rm(join(requestRoot, `${requestId}.json`), { force: true }),
        rm(join(answerRoot, `${requestId}.json`), { force: true }),
      ]);
      if (answer.error) {
        respond(id, { content: [{ type: "text", text: String(answer.error) }], isError: true });
        return;
      }
      const byId = new Map(answer.answers.map((item) => [item.id, item.answer]));
      const formatted = questions.map((item) => `${item.header}: ${item.question}\n回答：${byId.get(item.id) ?? ""}`).join("\n\n");
      respond(id, { content: [{ type: "text", text: formatted }], structuredContent: { answers: answer.answers } });
    } catch (error) {
      respond(id, { content: [{ type: "text", text: String(error.message ?? error) }], isError: true });
    } finally {
      active.delete(id);
    }
    return;
  }
  if (method === "notifications/cancelled") {
    active.get(params.requestId)?.abort(new Error("Question request cancelled."));
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/progress") return;
  respond(id, undefined, new Error(`Unsupported method: ${method}`));
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch { return; }
  if (!message || typeof message.method !== "string") return;
  if (message.method === "notifications/cancelled") {
    active.get(message.params?.requestId)?.abort(new Error("Question request cancelled."));
    return;
  }
  void handle(message).catch((error) => respond(message.id, undefined, error));
});
input.on("close", () => {
  for (const controller of active.values()) controller.abort(new Error("Question server stopped."));
});
process.on("SIGTERM", () => { input.close(); process.exitCode = 0; });
process.on("SIGINT", () => { input.close(); process.exitCode = 0; });
