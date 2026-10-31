// Codex 需要研究者决定时的提问通道，协议与实验复现相同：
// question-server.mjs（MCP 工具 request_user_input）把问题写进 questions/，等 question-answers/ 里出现回答。
// 这里负责发现问题、校验回答、写回答文件；界面通过回调得知有新问题。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const requestPattern = /^[0-9a-f-]{36}\.json$/i;
const str = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, path);
}

export function normalizeQuestionRequest(value, expectedId) {
  if (!value || value.requestId !== expectedId || !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 3) return null;
  const ids = new Set();
  const questions = [];
  for (const item of value.questions) {
    const id = str(item?.id, 64);
    const question = str(item?.question, 2000);
    const options = (Array.isArray(item?.options) ? item.options : []).slice(0, 6).map((option) => ({
      label: str(option?.label, 200), description: str(option?.description, 500),
    })).filter((option) => option.label);
    const isOther = item?.isOther === true;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id) || !question || (!options.length && !isOther)) return null;
    ids.add(id);
    questions.push({ id, header: str(item?.header, 40) || `问题 ${questions.length + 1}`, question, options, isOther });
  }
  return { requestId: expectedId, createdAt: str(value.createdAt, 40) || new Date().toISOString(), questions };
}

/** 回答必须覆盖每个问题；没有“其他”选项时只能从给定选项里选。 */
export function validateQuestionAnswers(request, rawAnswers) {
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) throw new Error("请为每个问题提供答案。");
  return request.questions.map((item) => {
    const answer = str(rawAnswers[item.id], 2000);
    const matchesOption = item.options.some((option) => option.label === answer);
    if (!answer || (!matchesOption && !item.isOther)) throw new Error(`请回答“${item.header}”。`);
    return { id: item.id, answer };
  });
}

export function formatQuestionAnswers(request, answers) {
  const answerById = new Map(answers.map((item) => [item.id, item.answer]));
  return ["对 Codex 提出的决定问题的回答：", ...request.questions.map((item) => `${item.header}：${item.question}\n研究者选择：${answerById.get(item.id)}`)].join("\n\n");
}

export class QuestionChannel {
  /**
   * @param {object} options
   * @param {string} options.root 放 questions/、question-answers/ 和提问服务脚本的目录
   * @param {() => void} [options.onChange] 出现新问题或问题被回答、取消时调用
   */
  constructor({ root, onChange = () => {}, pollMs = 200 }) {
    this.root = root;
    this.requests = join(root, "questions");
    this.answers = join(root, "question-answers");
    this.onChange = onChange;
    this.pollMs = pollMs;
    this.pending = null;
    this.timer = null;
    this.polling = null;
  }

  /** 准备目录和提问服务脚本，返回传给 Codex 的 MCP 服务配置。 */
  async prepare({ serverSource, nodePath = process.execPath, runAsNode = Boolean(process.versions.electron) }) {
    await Promise.all([mkdir(this.requests, { recursive: true }), mkdir(this.answers, { recursive: true })]);
    // 清掉上次异常退出留下的问题，避免新一轮一开始就弹出过期问题。
    for (const directory of [this.requests, this.answers]) {
      for (const file of await readdir(directory).catch(() => [])) await rm(join(directory, file), { force: true });
    }
    const serverPath = join(this.root, "question-server.mjs");
    await writeFile(serverPath, serverSource, "utf8");
    return {
      command: nodePath,
      args: [serverPath],
      env: {
        AUTORESEARCH_QUESTION_REQUESTS: this.requests,
        AUTORESEARCH_QUESTION_ANSWERS: this.answers,
        ...(runAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    };
  }

  start() {
    if (this.timer) return;
    const tick = () => { void this.poll().catch(() => {}); };
    tick();
    this.timer = setInterval(tick, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      if (this.pending) return;
      const files = (await readdir(this.requests).catch(() => [])).filter((file) => requestPattern.test(file)).sort();
      for (const file of files) {
        const requestId = file.slice(0, -5);
        if (await readJson(join(this.answers, file))) continue;
        const request = normalizeQuestionRequest(await readJson(join(this.requests, file)), requestId);
        if (!request) {
          await atomicJson(join(this.answers, file), { requestId, error: "问题格式无效，请重新提交。", answers: [] });
          continue;
        }
        this.pending = request;
        this.onChange();
        return;
      }
    })();
    try { await this.polling; }
    finally { this.polling = null; }
  }

  /** 校验并写入回答；返回写进对话的文字。 */
  async answer(requestId, rawAnswers) {
    const request = this.pending;
    if (!request || request.requestId !== requestId) throw new Error("这个问题已失效，请查看当前状态。");
    const answers = validateQuestionAnswers(request, rawAnswers);
    await atomicJson(join(this.answers, `${requestId}.json`), { requestId, answers });
    this.pending = null;
    this.onChange();
    return { request, answers, text: formatQuestionAnswers(request, answers) };
  }

  /** 取消待回答的问题：提问工具会收到错误并返回，Codex 不会继续等。 */
  async cancel(reason = "研究者取消了这个问题。") {
    const request = this.pending;
    this.pending = null;
    if (request) await atomicJson(join(this.answers, `${request.requestId}.json`), { requestId: request.requestId, error: reason, answers: [] });
    if (request) this.onChange();
  }

  async cleanup() {
    this.stop();
    const hadPending = Boolean(this.pending);
    this.pending = null;
    for (const directory of [this.requests, this.answers]) {
      for (const file of await readdir(directory).catch(() => [])) await rm(join(directory, file), { force: true });
    }
    if (hadPending) this.onChange();
  }
}
