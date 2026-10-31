// 实验工作区：一个实验 = 一个工作目录 + 一个持续的 Codex 会话。
// 平台只做四件事：准备工作目录（论文全文、AGENTS.md、REPRO.md），转发对话，运行 agent 提交的后台任务，
// 任务结束后把结果交回 agent。具体怎么复现由 agent 按每个仓库的实际情况决定。
import { execFile, spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { safeError } from "../retry.mjs";
import { environmentPrompt, environmentVariables } from "../environments/runtime.mjs";
import { agentBrief, executionPolicy, firstTurnPrompt, formatDuration, initialRecord, userTurnPrompt, wakePrompt } from "./brief.mjs";

const experimentPattern = /^exp_\d{3,}$/;
const jobPattern = /^job_\d{3,}$/;
const jobNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const paperPattern = /^paper_\d{3,}$/;
const questionRequestPattern = /^[0-9a-f-]{36}\.json$/i;
const heavyDirectories = new Set([".git", ".venv", "venv", "env", "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache", ".cache", "wandb"]);

const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
const str = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const tail = (value, max) => {
  const text = String(value ?? "");
  return text.length > max ? `…${text.slice(-max)}` : text;
};

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function normalizeQuestionRequest(value, expectedId) {
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
  return { requestId: expectedId, createdAt: str(value.createdAt, 40) || now(), questions };
}

function formatQuestionAnswers(question, answers) {
  const answerById = new Map(answers.map((item) => [item.id, item.answer]));
  return ["对 agent 提出的决定问题的回答：", ...question.questions.map((item) => `${item.header}：${item.question}\n研究者选择：${answerById.get(item.id)}`)].join("\n\n");
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function shortTitle(title) {
  return String(title ?? "").split(/[：:]/)[0].trim().slice(0, 40) || "新实验";
}

const scriptSource = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8");

/** 把本地解析的论文片段拼成一份带页码标记的 Markdown，供 agent 阅读和检索。 */
export function paperMarkdown(title, chunks) {
  const pages = new Map();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const text = String(chunk?.text ?? "").trim();
    if (!text) continue;
    const page = Number.isFinite(chunk?.page) ? chunk.page : 0;
    if (!pages.has(page)) pages.set(page, []);
    pages.get(page).push(text);
  }
  const lines = [
    `# ${title}`,
    "",
    "> AutoResearch 在本地从 PDF 解析出的全文，用 `## p.N` 标出页码。表格和公式可能被拍平或错位，数字有疑问时请对照 paper/original.pdf。",
    "",
  ];
  for (const [page, texts] of [...pages].sort((a, b) => a[0] - b[0])) lines.push(`## p.${page || "?"}`, "", texts.join("\n\n"), "");
  return lines.join("\n");
}

const allowedEnv = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS", "USERNAME", "USER", "LOGNAME",
  "SHELL", "LANG", "LANGUAGE", "TERM", "TZ", "LD_LIBRARY_PATH",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "PIP_TRUSTED_HOST", "UV_INDEX_URL",
  "HF_HOME", "HF_ENDPOINT", "HF_HUB_CACHE", "TRANSFORMERS_CACHE", "TORCH_HOME", "XDG_CACHE_HOME",
]);
const allowedPrefixes = ["CUDA", "CUDNN", "NVIDIA_", "CONDA", "LC_", "OMP_", "MKL_"];

/**
 * 后台任务在沙箱外运行，只给白名单内的环境变量。
 * 研究者可以用 AUTORESEARCH_JOB_ENV（逗号分隔的变量名）额外放行，例如 HF_TOKEN。
 */
export function buildJobEnv(source = process.env) {
  const extra = new Set(String(source.AUTORESEARCH_JOB_ENV ?? "").split(",").map((name) => name.trim().toUpperCase()).filter(Boolean));
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    const upper = key.toUpperCase();
    if (allowedEnv.has(upper) || extra.has(upper) || allowedPrefixes.some((prefix) => upper.startsWith(prefix))) env[key] = value;
  }
  env.PYTHONUNBUFFERED = "1";
  return environmentVariables(env, null);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function defaultKillTree({ runnerPid, childPid }, platform) {
  if (platform === "win32") {
    for (const pid of [runnerPid, childPid]) {
      if (!pid) continue;
      await new Promise((done) => execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => done()));
    }
    return;
  }
  for (const pid of [childPid ? -childPid : 0, childPid, runnerPid]) {
    if (!pid) continue;
    try { process.kill(pid, "SIGTERM"); } catch { /* 进程已经结束。 */ }
  }
}

const ansiPattern = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** 日志里最后一行有内容的文字：去掉颜色码，进度条（\r 覆盖）只取最后一次刷新。 */
export function lastLogLine(text) {
  const lines = String(text ?? "").replace(ansiPattern, "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const segments = lines[index].split("\r").map((part) => part.trim()).filter(Boolean);
    const line = segments.at(-1);
    if (line && !/^\[AutoResearch [^\]]*\] 结束：/.test(line)) return line.slice(0, 300);
  }
  return "";
}

const logChunkLimit = 1024 * 1024;
const logFirstWindow = 512 * 1024;

function nextNumber(names, pattern) {
  return names.reduce((max, name) => {
    const match = pattern.exec(name);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
}

export class ExperimentLab {
  /**
   * @param {object} deps
   * @param {(projectId: string) => string} deps.projectRoot 课题目录
   * @param {(projectId: string, paperId: string) => Promise<{id:string,title:string,chunks:object[],pdfPath?:string,analysisScript?:string}>} deps.loadPaper
   * @param {(prompt: string, options: object) => Promise<{finalResponse?: string}>} deps.runAgent 运行一轮 agent（Codex SDK）
   * @param {(update: object) => void} [deps.emit] 推送给界面
   */
  constructor({
    projectRoot, loadPaper, runAgent, emit = () => {},
    spawn = spawnProcess, nodePath = process.execPath, platform = process.platform, env = process.env,
    killTree = defaultKillTree, pollMs = 3000, autoWakeLimit = 8, environments = null,
  }) {
    Object.assign(this, { projectRoot, loadPaper, runAgent, emit, spawn, nodePath, platform, env, killTree, pollMs, autoWakeLimit, environments });
    this.entries = new Map();
    this.timer = null;
    this.polling = null;
    this.stopping = false;
  }

  base(projectId) { return join(this.projectRoot(projectId), "Experiments", "PaperReproductions"); }

  legacyBase(projectId) { return join(this.projectRoot(projectId), "Experiments"); }

  designedBase(projectId) { return join(this.legacyBase(projectId), "DesignedExperiments"); }

  async experimentNames(projectId) {
    const paperRoot = this.base(projectId);
    const legacyRoot = this.legacyBase(projectId);
    await Promise.all([
      mkdir(paperRoot, { recursive: true }),
      mkdir(this.designedBase(projectId), { recursive: true }),
    ]);
    const names = new Set();
    for (const directory of [paperRoot, legacyRoot]) {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        if (entry.isDirectory() && experimentPattern.test(entry.name)) names.add(entry.name);
      }
    }
    return [...names];
  }

  async resolveRoot(projectId, id) {
    const current = this.root(projectId, id);
    if (await readJson(join(current, "experiment.json"), null)) return current;
    const legacy = join(this.legacyBase(projectId), id);
    if (await readJson(join(legacy, "experiment.json"), null)) return legacy;
    return current;
  }

  root(projectId, id) {
    if (typeof id !== "string" || !experimentPattern.test(id)) throw new Error("实验编号无效。");
    return join(this.base(projectId), id);
  }

  async entry(projectId, id) {
    const key = this.root(projectId, id);
    if (!this.entries.has(key)) {
      const loading = (async () => {
        const root = await this.resolveRoot(projectId, id);
        const experiment = await readJson(join(root, "experiment.json"), null);
        if (!experiment) throw new Error("实验不存在。");
        const jobs = new Map();
        for (const file of await readdir(join(root, "jobs")).catch(() => [])) {
          if (!/^job_\d{3,}\.json$/.test(file)) continue;
          const job = await readJson(join(root, "jobs", file), null);
          if (job && jobPattern.test(job.id)) jobs.set(job.id, job);
        }
        return { root, projectId, workspace: join(root, "workspace"), experiment, jobs, controller: null, turn: null, writes: Promise.resolve(), lock: Promise.resolve(), suppressWake: false, wakeLimitNoted: false, live: null, liveTimer: null, questionTimer: null, questionPoll: null };
      })();
      this.entries.set(key, loading);
      loading.catch(() => this.entries.delete(key));
    }
    return this.entries.get(key);
  }

  async ensureEnvironmentHelper(workspace) {
    const helper = join(workspace, ".ar", "environment.mjs");
    try { await lstat(helper); return; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(dirname(helper), { recursive: true });
    const source = await readFile(new URL("../environments/request-helper.mjs", import.meta.url), "utf8");
    try { await writeFile(helper, source, { encoding: "utf8", flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }

  async ensureQuestionHelper(workspace) {
    const platformRoot = join(workspace, ".ar");
    const helper = join(platformRoot, "question-server.mjs");
    await Promise.all([
      mkdir(join(platformRoot, "questions"), { recursive: true }),
      mkdir(join(platformRoot, "question-answers"), { recursive: true }),
    ]);
    try { await lstat(helper); return; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const source = await scriptSource("question-server.mjs");
    try { await writeFile(helper, source, { encoding: "utf8", flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }

  // 串行化会改动任务和设置的操作，避免双击批准时启动两次。
  serial(entry, action) {
    const result = entry.lock.then(action);
    entry.lock = result.catch(() => {});
    return result;
  }

  summary(entry) {
    const { experiment } = entry;
    const jobs = [...entry.jobs.values()];
    const runningJobs = jobs.filter((job) => job.status === "running").length;
    const pendingJobs = jobs.filter((job) => job.status === "pending").length;
    return {
      id: experiment.id, title: experiment.title, paperId: experiment.paperId, paperTitle: experiment.paperTitle,
      agent: experiment.agent, activity: experiment.activity, error: experiment.error,
      kind: entry.root.includes(`${this.platform === "win32" ? "\\" : "/"}DesignedExperiments${this.platform === "win32" ? "\\" : "/"}`) ? "自主实验" : "论文复现",
      status: experiment.pendingQuestion ? "needs_input" : experiment.agent === "working" || runningJobs ? "running" : pendingJobs ? "waiting" : "idle",
      pendingJobs,
      runningJobs,
      updatedAt: experiment.updatedAt,
    };
  }

  publish(entry, update) {
    this.emit({ projectId: entry.projectId, experimentId: entry.experiment.id, summary: this.summary(entry), ...update });
  }

  async saveExperiment(entry, publish = true) {
    entry.experiment.updatedAt = now();
    const snapshot = clone(entry.experiment);
    const write = entry.writes.then(() => atomicJson(join(entry.root, "experiment.json"), snapshot));
    entry.writes = write.catch(() => {});
    await write;
    if (publish) this.publish(entry, { experiment: snapshot });
  }

  async append(entry, event, { publish = true } = {}) {
    const record = { id: randomUUID(), at: now(), ...event };
    const write = entry.writes.then(() => appendFile(join(entry.root, "events.jsonl"), `${JSON.stringify(record)}\n`, "utf8"));
    entry.writes = write.catch(() => {});
    await write;
    if (publish) this.publish(entry, { events: [record] });
    return record;
  }

  async pollQuestionRequests(entry) {
    if (entry.questionPoll) return entry.questionPoll;
    const polling = this.serial(entry, async () => {
      if (entry.experiment.pendingQuestion) return;
      const requestsRoot = join(entry.workspace, ".ar", "questions");
      const answersRoot = join(entry.workspace, ".ar", "question-answers");
      const files = (await readdir(requestsRoot).catch(() => [])).filter((file) => questionRequestPattern.test(file)).sort();
      for (const file of files) {
        const requestId = file.slice(0, -5);
        if (await readJson(join(answersRoot, `${requestId}.json`), null)) continue;
        const request = normalizeQuestionRequest(await readJson(join(requestsRoot, file), null), requestId);
        if (!request) {
          await atomicJson(join(answersRoot, `${requestId}.json`), { requestId, error: "问题格式无效，请重新提交。", answers: [] });
          continue;
        }
        entry.experiment.pendingQuestion = request;
        entry.experiment.agent = "waiting";
        entry.experiment.activity = "等待你作答";
        await this.append(entry, { type: "system", text: "agent 提交了需要你决定的问题。" });
        await this.saveExperiment(entry);
        return;
      }
    });
    entry.questionPoll = polling;
    try { await polling; }
    finally { if (entry.questionPoll === polling) entry.questionPoll = null; }
  }

  startQuestionPolling(entry) {
    if (entry.questionTimer) return;
    const poll = () => { void this.pollQuestionRequests(entry).catch(() => {}); };
    poll();
    entry.questionTimer = setInterval(poll, 200);
    entry.questionTimer.unref?.();
  }

  stopQuestionPolling(entry) {
    if (entry.questionTimer) clearInterval(entry.questionTimer);
    entry.questionTimer = null;
  }

  async saveJob(entry, job) {
    entry.jobs.set(job.id, job);
    const snapshot = clone(job);
    const write = entry.writes.then(() => atomicJson(join(entry.root, "jobs", `${job.id}.json`), snapshot));
    entry.writes = write.catch(() => {});
    await write;
    this.publish(entry, { jobs: [snapshot] });
  }

  async events(entry, limit = 1500) {
    const text = await readFile(join(entry.root, "events.jsonl"), "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    return text.split(/\r?\n/).filter(Boolean).slice(-limit).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }

  jobList(entry) { return [...entry.jobs.values()].sort((a, b) => a.id.localeCompare(b.id)).map(clone); }

  async record(entry) { return (await readFile(join(entry.workspace, "REPRO.md"), "utf8").catch(() => "")).slice(0, 200_000); }

  // ---------- 读取 ----------

  async list(projectId) {
    const names = await this.experimentNames(projectId);
    const summaries = [];
    for (const name of names) {
      if (!experimentPattern.test(name)) continue;
      try { summaries.push(this.summary(await this.entry(projectId, name))); }
      catch { /* 损坏或不完整的实验目录不影响其他实验。 */ }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(projectId, id) {
    const entry = await this.entry(projectId, id);
    await entry.writes;
    return { experiment: clone(entry.experiment), events: await this.events(entry), jobs: this.jobList(entry), record: await this.record(entry), live: entry.live ? clone(entry.live) : null };
  }

  // ---------- 新建 ----------

  async create(projectId, input = {}) {
    const paperId = str(input.paperId, 40);
    if (!paperPattern.test(paperId)) throw new Error("请选择一篇论文。");
    const goal = str(input.goal, 4000);
    if (!goal) throw new Error("请写下这个实验要做什么。");
    const paper = await this.loadPaper(projectId, paperId);
    const base = this.base(projectId);
    const names = await this.experimentNames(projectId);
    const id = `exp_${String(nextNumber(names, /^exp_(\d{3,})$/)).padStart(3, "0")}`;
    const root = join(base, id);
    await mkdir(root);
    const workspace = join(root, "workspace");
    await Promise.all([
      mkdir(join(workspace, "paper"), { recursive: true }),
      mkdir(join(workspace, ".ar", "requests"), { recursive: true }),
      mkdir(join(workspace, ".ar", "environment-requests"), { recursive: true }),
      mkdir(join(workspace, ".ar", "logs"), { recursive: true }),
      mkdir(join(root, "jobs"), { recursive: true }),
    ]);
    const title = str(input.title, 80) || `${shortTitle(paper.title)} 复现`;
    await writeFile(join(workspace, "paper", "paper.md"), paperMarkdown(paper.title, paper.chunks), "utf8");
    if (paper.pdfPath) await copyFile(paper.pdfPath, join(workspace, "paper", "original.pdf")).catch(() => {});
    if (str(paper.analysisScript, 10)) await writeFile(join(workspace, "paper", "analysis.md"), paper.analysisScript, "utf8");
    await writeFile(join(workspace, "AGENTS.md"), agentBrief({ platform: this.platform }), "utf8");
    await writeFile(join(workspace, "REPRO.md"), initialRecord({ title, goal }), "utf8");
    await writeFile(join(workspace, ".ar", "run.mjs"), await scriptSource("run-helper.mjs"), "utf8");
    await Promise.all([this.ensureEnvironmentHelper(workspace), this.ensureQuestionHelper(workspace)]);
    const createdAt = now();
    const experiment = {
      id, projectId, title, paperId: paper.id, paperTitle: paper.title, goal, code: str(input.code, 1000),
      settings: { network: input.settings?.network !== false, approveJobs: input.settings?.approveJobs === true, continuous: input.settings?.continuous !== false },
      threadId: null, agent: "idle", activity: "", error: null, notices: [], pendingQuestion: null, pendingContinuation: null, turns: 0, autoWakes: 0, autoWakeStalls: 0, createdAt, updatedAt: createdAt,
    };
    await atomicJson(join(root, "experiment.json"), experiment);
    const entry = await this.entry(projectId, id);
    await this.append(entry, { type: "user", text: goal });
    this.startTurn(entry, firstTurnPrompt(entry.experiment));
    return this.get(projectId, id);
  }

  // ---------- 对话 ----------

  async send(projectId, id, text) {
    const message = str(text, 8000);
    if (!message) throw new Error("消息不能为空。");
    const entry = await this.entry(projectId, id);
    return this.serial(entry, async () => {
      if (entry.experiment.pendingQuestion) throw new Error("请先回答弹窗里的问题，再继续对话。");
      if (entry.turn) throw new Error("agent 正在工作。等这一轮结束，或先停止它。");
      const { experiment } = entry;
      const notices = experiment.notices.splice(0);
      experiment.autoWakes = 0;
      experiment.autoWakeStalls = 0;
      entry.suppressWake = false;
      entry.wakeLimitNoted = false;
      await this.append(entry, { type: "user", text: message });
      this.startTurn(entry, userTurnPrompt({ text: message, notices, newThread: !experiment.threadId && experiment.turns > 0 }), notices);
      return clone(experiment);
    });
  }

  async notify(projectId, id, text, wake = false) {
    const message = str(text, 8000);
    if (!message) return;
    const entry = await this.entry(projectId, id);
    await this.serial(entry, async () => {
      entry.experiment.notices.push({ text: message, wake: wake === true });
      await this.append(entry, { type: "system", text: message });
      await this.saveExperiment(entry);
    });
    if (wake) this.maybeWake(entry);
  }

  async stop(projectId, id) {
    const entry = await this.entry(projectId, id);
    entry.suppressWake = true;
    entry.experiment.pendingContinuation = null;
    if (entry.experiment.pendingQuestion) {
      const { requestId } = entry.experiment.pendingQuestion;
      entry.experiment.pendingQuestion = null;
      entry.experiment.activity = "";
      if (!entry.turn) entry.experiment.agent = "idle";
      await Promise.all([
        rm(join(entry.workspace, ".ar", "questions", `${requestId}.json`), { force: true }),
        rm(join(entry.workspace, ".ar", "question-answers", `${requestId}.json`), { force: true }),
      ]);
      await this.append(entry, { type: "system", text: "已取消待回答的问题。" });
      await this.saveExperiment(entry);
    }
    entry.controller?.abort(new Error("已停止"));
    await entry.turn;
    return clone(entry.experiment);
  }

  async answerQuestion(projectId, id, requestId, rawAnswers) {
    const entry = await this.entry(projectId, id);
    return this.serial(entry, async () => {
      const question = entry.experiment.pendingQuestion;
      if (!question || question.requestId !== requestId) throw new Error("这个问题已失效，请查看当前实验状态。");
      if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) throw new Error("请为每个问题提供答案。");
      const answers = question.questions.map((item) => {
        const answer = str(rawAnswers[item.id], 2000);
        const matchesOption = item.options.some((option) => option.label === answer);
        if (!answer || (!matchesOption && !item.isOther)) throw new Error(`请回答“${item.header}”。`);
        return { id: item.id, answer };
      });
      const responseText = formatQuestionAnswers(question, answers);
      const responsePath = join(entry.workspace, ".ar", "question-answers", `${requestId}.json`);
      const requestPath = join(entry.workspace, ".ar", "questions", `${requestId}.json`);
      const activeTurn = Boolean(entry.turn);

      entry.experiment.pendingQuestion = null;
      entry.experiment.pendingContinuation = responseText;
      entry.experiment.activity = activeTurn ? "正在继续" : "";
      if (!activeTurn) entry.experiment.agent = "idle";
      else {
        entry.experiment.agent = "working";
        entry.experiment.inFlightNotices = [
          ...(entry.experiment.inFlightNotices ?? []),
          { text: responseText, wake: true },
        ];
      }
      await this.append(entry, { type: "user", text: responseText });
      await this.saveExperiment(entry);

      if (activeTurn) {
        await atomicJson(responsePath, { requestId, answers });
      } else {
        await Promise.all([rm(requestPath, { force: true }), rm(responsePath, { force: true })]);
        const notice = { text: responseText, wake: true };
        this.startTurn(entry, userTurnPrompt({
          text: responseText,
          notices: [],
          newThread: !entry.experiment.threadId && entry.experiment.turns > 0,
        }), [notice]);
      }
      return clone(entry.experiment);
    });
  }

  startTurn(entry, prompt, notices = []) {
    if (this.stopping || entry.closed) throw new Error("实验服务已停止，请重新打开实验。");
    const { experiment } = entry;
    const controller = new AbortController();
    entry.controller = controller;
    experiment.agent = "working";
    experiment.activity = "正在思考";
    experiment.error = null;
    experiment.turns = (experiment.turns ?? 0) + 1;
    experiment.inFlightNotices = notices;
    let finalMessage = "";
    let environmentLease;
    let turnPromise;
    const run = async () => {
      await this.saveExperiment(entry);
      try {
        environmentLease = await this.environments?.acquire(experiment.projectId, true);
        await this.ensureEnvironmentHelper(entry.workspace);
        await this.ensureQuestionHelper(entry.workspace);
        await this.environments?.writeWorkspaceInfo(entry.workspace, environmentLease?.environment ?? null);
        await this.serial(entry, () => this.launchPendingJobs(entry));
        const result = await this.runAgent(`${environmentPrompt(environmentLease?.environment ?? null)}\n\n${executionPolicy(experiment.settings, { platform: this.platform })}\n\n${prompt}`, {
          workingDirectory: entry.workspace,
          threadId: experiment.threadId,
          network: experiment.settings.network,
          env: environmentLease?.env ?? this.env,
          signal: controller.signal,
          onRetry: async ({ attempt, maxAttempts, delayMs, phase }) => {
            controller.signal.throwIfAborted();
            finalMessage = "";
            if (entry.live || entry.liveTimer) this.setLive(entry, null);
            const waiting = phase === "waiting";
            const reconnecting = phase === "reconnecting";
            const text = reconnecting
              ? `上游连接正在重试（${attempt}/${maxAttempts}），保留当前执行进度。`
              : waiting
              ? `上游限流或连接中断，${Math.ceil(delayMs / 1000)} 秒后自动恢复（${attempt}/${maxAttempts}）；保留原会话和已完成操作。`
              : "正在恢复原会话";
            experiment.activity = experiment.pendingQuestion ? "等待你作答" : text;
            await this.saveExperiment(entry);
            if (waiting || reconnecting) await this.append(entry, { type: "system", text });
          },
          onThread: async (threadId) => {
            if ((threadId ?? null) === experiment.threadId) return;
            experiment.threadId = threadId ?? null;
            await this.saveExperiment(entry, false);
          },
          onEvent: async (event) => {
            if (event?.type === "item.completed" && event.item?.type === "agent_message") {
              finalMessage = str(event.item.text, 100_000) || finalMessage;
              return;
            }
            await this.handleAgentEvent(entry, event);
          },
        });
        finalMessage = str(result?.finalResponse, 100_000) || finalMessage;
        experiment.inFlightNotices = [];
        experiment.pendingContinuation = null;
      } catch (error) {
        finalMessage = "";
        experiment.notices.unshift(...(experiment.inFlightNotices ?? []));
        experiment.inFlightNotices = [];
        if (controller.signal.aborted) await this.append(entry, { type: "system", text: "已停止 agent 这一轮。" });
        else {
          experiment.error = safeError(error);
          await this.append(entry, { type: "error", text: `agent 出错：${experiment.error}` });
        }
      } finally {
        environmentLease?.release();
        environmentLease = null;
        if (entry.live || entry.liveTimer) this.setLive(entry, null);
        entry.controller = null;
      }
      if (!this.stopping) {
        await this.collectRequests(entry);
        await this.environments?.collect(experiment.projectId, experiment, entry.workspace);
      }
      experiment.agent = experiment.pendingQuestion ? "waiting" : "idle";
      experiment.activity = experiment.pendingQuestion ? "等待你作答" : "";
      await this.saveExperiment(entry, false);
      const responseEvent = finalMessage ? await this.append(entry, { type: "agent", text: finalMessage }, { publish: false }) : null;
      const record = await this.record(entry);
      if (entry.turn === turnPromise) entry.turn = null;
      this.publish(entry, { experiment: clone(experiment), ...(responseEvent ? { events: [responseEvent] } : {}), record });
    };
    turnPromise = run().catch(async (error) => {
      experiment.agent = "idle";
      experiment.activity = "";
      experiment.error = safeError(error);
      await this.saveExperiment(entry, false).catch(() => {});
      const errorEvent = await this.append(entry, { type: "error", text: `agent 出错：${experiment.error}` }, { publish: false }).catch(() => null);
      const record = await this.record(entry).catch(() => "");
      if (entry.turn === turnPromise) entry.turn = null;
      this.publish(entry, { experiment: clone(experiment), ...(errorEvent ? { events: [errorEvent] } : {}), record });
    }).finally(() => {
      if (entry.turn === turnPromise) entry.turn = null;
      this.stopQuestionPolling(entry);
      this.maybeWake(entry);
    });
    entry.turn = turnPromise;
    this.startQuestionPolling(entry);
  }

  relativePath(entry, path) {
    const value = String(path ?? "");
    if (!value) return "";
    const target = isAbsolute(value) ? value : resolve(entry.workspace, value);
    return inside(entry.workspace, target) ? relative(entry.workspace, target).replaceAll("\\", "/") : value;
  }

  /** 把 Codex 的非最终消息事件转成对话记录；最终答复由 startTurn 在整轮完成后统一提交。 */
  /** agent 正在执行的短命令：开始、输出更新时推给界面（最多每 400 毫秒一次），结束时清空。 */
  setLive(entry, live) {
    entry.live = live;
    if (!live) {
      clearTimeout(entry.liveTimer);
      entry.liveTimer = null;
      this.publish(entry, { live: null });
      return;
    }
    if (entry.liveTimer) return;
    const publish = () => {
      entry.liveTimer = null;
      if (entry.live) {
        entry.livePublishedAt = Date.now();
        this.publish(entry, { live: clone(entry.live) });
      }
    };
    const delay = Math.max(0, 400 - (Date.now() - (entry.livePublishedAt ?? 0)));
    if (delay) {
      entry.liveTimer = setTimeout(publish, delay);
      entry.liveTimer.unref?.();
    } else publish();
  }

  async handleAgentEvent(entry, event) {
    const item = event?.item;
    if (!item) return false;
    if (item.type === "command_execution" && (event.type === "item.started" || event.type === "item.updated")) {
      this.setLive(entry, {
        id: str(item.id, 80) || entry.live?.id || randomUUID(), command: str(item.command, 4000),
        startedAt: entry.live?.command === str(item.command, 4000) ? entry.live.startedAt : now(),
        output: tail(item.aggregated_output, 20_000),
      });
    }
    if (event.type === "item.started") {
      const activity = item.type === "command_execution" ? `正在执行：${tail(item.command, 160)}`
        : item.type === "file_change" ? "正在修改文件"
        : item.type === "web_search" ? "正在搜索网页"
        : item.type === "reasoning" ? "正在思考" : "";
      if (activity && activity !== entry.experiment.activity) {
        entry.experiment.activity = activity;
        this.publish(entry, { experiment: clone(entry.experiment) });
      }
      return false;
    }
    if (event.type !== "item.completed") return false;
    if (item.type === "agent_message") {
      return true;
    }
    if (item.type === "command_execution") {
      if (entry.live) this.setLive(entry, null);
      await this.append(entry, {
        type: "command", command: str(item.command, 4000),
        exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null,
        status: str(item.status, 20), output: tail(item.aggregated_output, 3000),
      });
      if (item.exit_code === -1 && /Failed to create unified exec process:[\s\S]*(?:helper_|sandbox|setup refresh)/i.test(item.aggregated_output ?? "")) {
        throw new Error(`Windows 命令执行器初始化失败，命令尚未运行。请检查所用 Codex CLI 与 Windows 沙箱配置后再继续。原始错误：${tail(item.aggregated_output, 1500)}`);
      }
    } else if (item.type === "file_change") {
      const changes = (Array.isArray(item.changes) ? item.changes : []).slice(0, 50)
        .map((change) => ({ path: this.relativePath(entry, change?.path), kind: str(change?.kind, 20) }));
      await this.append(entry, { type: "file", changes, status: str(item.status, 20) });
      if (changes.some((change) => change.path === "REPRO.md")) this.publish(entry, { record: await this.record(entry) });
    } else if (item.type === "web_search") {
      await this.append(entry, { type: "tool", text: `搜索网页：${str(item.query, 300)}` });
    } else if (item.type === "mcp_tool_call") {
      await this.append(entry, { type: "tool", text: `调用工具：${str(item.server, 60)}.${str(item.tool, 80)}` });
    } else if (item.type === "error") {
      await this.append(entry, { type: "error", text: str(item.message, 2000) });
    }
    return false;
  }

  maybeWake(entry) {
    if (entry.turn || entry.experiment.pendingQuestion || this.stopping || entry.closed || entry.suppressWake) return;
    const { experiment } = entry;
    if (!experiment.notices.some((notice) => notice.wake)) return;
    const continuous = experiment.settings.continuous === true;
    const progress = experiment.notices.some((notice) => notice.wake && notice.progress === true);
    const wakeCount = continuous ? (progress ? 0 : experiment.autoWakeStalls ?? 0) : experiment.autoWakes ?? 0;
    if (wakeCount >= this.autoWakeLimit) {
      if (!entry.wakeLimitNoted) {
        entry.wakeLimitNoted = true;
        const text = continuous
          ? `已经连续 ${this.autoWakeLimit} 次接续没有成功的后台任务结果，先暂停以避免重复失败。查看日志后发一条消息让它继续。`
          : `已经连续自动唤醒 agent ${this.autoWakeLimit} 次，先停在这里。发一条消息让它继续。`;
        void this.append(entry, { type: "system", text }).catch(() => {});
      }
      return;
    }
    experiment.autoWakes = (experiment.autoWakes ?? 0) + 1;
    experiment.autoWakeStalls = progress ? 0 : (experiment.autoWakeStalls ?? 0) + 1;
    entry.wakeLimitNoted = false;
    // 成功结果只重置一次失败计数，不能因 agent 报错后重复投递而无限重置。
    const notices = experiment.notices.splice(0).map((notice) => ({ ...notice, progress: false }));
    void this.append(entry, { type: "system", text: "已把结果交给 agent，它会接着做。" }).catch(() => {});
    this.startTurn(entry, wakePrompt({ notices, newThread: !experiment.threadId && experiment.turns > 0 }), notices);
  }

  // ---------- 设置与记录 ----------

  async updateSettings(projectId, id, settings = {}) {
    const entry = await this.entry(projectId, id);
    return this.serial(entry, async () => {
      const current = entry.experiment.settings;
      const previouslyApproved = current.approveJobs;
      if (typeof settings.network === "boolean") current.network = settings.network;
      if (typeof settings.approveJobs === "boolean") current.approveJobs = settings.approveJobs;
      if (typeof settings.continuous === "boolean") {
        current.continuous = settings.continuous;
        entry.wakeLimitNoted = false;
      }
      const text = `允许联网：${current.network ? "开" : "关"}；后台任务自动运行：${current.approveJobs ? "关" : "开"}；持续接续：${current.continuous === true ? "开" : "关"}`;
      entry.experiment.notices.push({ text: `研究者修改了设置。${text}。`, wake: false });
      await this.append(entry, { type: "system", text: `设置已更新。${text}。联网设置从 agent 的下一轮开始生效。` });
      await this.saveExperiment(entry);
      if (previouslyApproved && current.approveJobs === false) await this.launchPendingJobs(entry);
      this.maybeWake(entry);
      return clone(entry.experiment);
    });
  }

  async saveRecord(projectId, id, text) {
    const entry = await this.entry(projectId, id);
    const value = typeof text === "string" ? text.slice(0, 200_000) : "";
    await writeFile(join(entry.workspace, "REPRO.md"), value, "utf8");
    entry.experiment.notices.push({ text: "研究者手动修改了 REPRO.md，请以文件里的最新内容为准。", wake: false });
    await this.saveExperiment(entry);
    this.publish(entry, { record: value });
    return value;
  }

  // ---------- 后台任务 ----------

  async validateRequest(entry, request) {
    if (!request || typeof request !== "object") return "请求格式无效";
    if (typeof request.name !== "string" || !jobNamePattern.test(request.name)) return "任务名字无效";
    if (typeof request.command !== "string" || !request.command.trim() || request.command.length > 8000) return "命令为空或太长";
    const cwd = typeof request.cwd === "string" && request.cwd.trim() ? request.cwd.trim() : ".";
    if (isAbsolute(cwd) || /^[a-z]:/i.test(cwd) || !inside(entry.workspace, resolve(entry.workspace, cwd))) return "工作目录不在实验目录内";
    try {
      const target = await this.resolvePath(entry.projectId, entry.experiment.id, cwd);
      if (!(await stat(target)).isDirectory()) return "工作目录不是文件夹";
    } catch { return "工作目录不存在或不在实验目录内"; }
    return "";
  }

  async collectRequests(entry) {
    const directory = join(entry.workspace, ".ar", "requests");
    const files = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    for (const file of files) {
      const path = join(directory, file);
      let request = null;
      let problem = "";
      try { request = JSON.parse(await readFile(path, "utf8")); }
      catch { problem = "请求文件不是有效的 JSON"; }
      await rm(path, { force: true });
      if (!problem) problem = await this.validateRequest(entry, request);
      if (problem) {
        entry.experiment.notices.push({ text: `你提交的后台任务请求被忽略了：${problem}。请修正后重新提交。`, wake: true });
        await this.append(entry, { type: "system", text: `忽略了一个后台任务请求：${problem}。` });
        await this.saveExperiment(entry);
        continue;
      }
      await this.serial(entry, () => this.createJob(entry, request));
    }
  }

  async createJob(entry, request, { origin, notify } = {}) {
    const id = `job_${String(nextNumber([...entry.jobs.keys()], /^job_(\d{3,})$/)).padStart(3, "0")}`;
    const job = {
      id, name: request.name, command: request.command.trim(), cwd: str(request.cwd, 500) || ".", note: str(request.note, 500),
      status: "pending", requestedAt: str(request.requestedAt, 40) || now(), log: `.ar/logs/${id}-${request.name}.log`, exitCode: null,
      // 手动来源只由界面 IPC 的 runCommand 传入，不能信任 agent 写入请求文件的字段。
      ...(origin === "user" ? { origin: "user", notify: notify === true } : {}),
    };
    await this.saveJob(entry, job);
    await this.append(entry, { type: "job", jobId: id });
    if (job.origin === "user" || (!entry.experiment.settings.approveJobs && !entry.experiment.pendingQuestion && !entry.suppressWake)) await this.launchJob(entry, job);
    return job;
  }

  /** 研究者在终端面板里手动运行的命令：不需要再确认，同样走后台执行器、写日志。 */
  async runCommand(projectId, id, input = {}) {
    const entry = await this.entry(projectId, id);
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command || command.length > 8000) throw new Error("命令为空或太长。");
    const request = { name: "manual", command, cwd: str(input.cwd, 500) || ".", note: "研究者手动运行", requestedAt: now() };
    const problem = await this.validateRequest(entry, request);
    if (problem) throw new Error(`无法运行：${problem}。`);
    return this.serial(entry, async () => clone(await this.createJob(entry, request, { origin: "user", notify: input.notify === true })));
  }

  statusPath(entry, job) { return join(entry.root, "jobs", `${job.id}.status.json`); }

  async launchPendingJobs(entry) {
    for (const job of entry.jobs.values()) {
      if (entry.experiment.settings.approveJobs !== false || entry.experiment.pendingQuestion || entry.suppressWake || this.stopping || entry.closed) break;
      if (job.status === "pending") await this.launchJob(entry, job);
    }
  }

  async launchJob(entry, job) {
    const problem = await this.validateRequest(entry, job);
    if (problem) throw new Error(`无法运行后台任务：${problem}。`);
    const environmentLease = await this.environments?.acquire(entry.experiment.projectId, true);
    let spec;
    let child;
    try {
      const runner = join(entry.root, "job-runner.mjs");
      await writeFile(runner, await scriptSource("job-runner.mjs"), "utf8");
      spec = {
        command: job.command,
        cwd: resolve(entry.workspace, job.cwd),
        log: join(entry.workspace, ...job.log.split("/")),
        status: this.statusPath(entry, job),
      };
      await this.environments?.writeWorkspaceInfo(entry.workspace, environmentLease?.environment ?? null);
      await mkdir(dirname(spec.log), { recursive: true });
      await rm(spec.status, { force: true });
      const specPath = join(entry.root, "jobs", `${job.id}.spec.json`);
      await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
      job.status = "running";
      job.startedAt = now();
      job.exitCode = null;
      child = this.spawn(this.nodePath, [runner, specPath], {
        cwd: entry.workspace,
        env: { ...(environmentLease?.env ?? buildJobEnv(this.env)), ELECTRON_RUN_AS_NODE: "1" },
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      environmentLease?.release();
      Object.assign(job, { status: "failed", finishedAt: now(), exitCode: -1 });
      await this.saveJob(entry, job);
      await this.finishJob(entry, job, { state: "finished", exitCode: -1, error: safeError(error) });
      return;
    }
    if (environmentLease) {
      entry.environmentLeases ??= new Map();
      entry.environmentLeases.set(job.id, environmentLease);
    }
    child.on?.("error", (error) => {
      void this.serial(entry, () => this.finishJob(entry, job, { state: "finished", exitCode: -1, error: error.message })).catch(() => {});
    });
    child.unref?.();
    job.runnerPid = child.pid ?? null;
    await this.saveJob(entry, job);
    await this.append(entry, { type: "system", text: job.origin === "user" ? `你手动运行的命令开始执行（${job.id}）。` : `后台任务 ${job.name} 开始运行。`, jobId: job.id });
    this.ensurePolling();
  }

  async jobAction(projectId, id, jobId, action) {
    if (typeof jobId !== "string" || !jobPattern.test(jobId)) throw new Error("任务编号无效。");
    const entry = await this.entry(projectId, id);
    return this.serial(entry, async () => {
      const job = entry.jobs.get(jobId);
      if (!job) throw new Error("任务不存在。");
      if (action === "approve") {
        if (job.status !== "pending") throw new Error("这个任务不在等待确认。");
        await this.launchJob(entry, job);
      } else if (action === "reject") {
        if (job.status !== "pending") throw new Error("这个任务不在等待确认。");
        Object.assign(job, { status: "rejected", finishedAt: now() });
        await this.saveJob(entry, job);
        entry.experiment.notices.push({ text: `研究者决定不运行后台任务 ${job.name}（${job.id}）。`, wake: false });
        await this.append(entry, { type: "system", text: `没有运行后台任务 ${job.name}。agent 会在你下一条消息里看到这个决定。`, jobId: job.id });
        await this.saveExperiment(entry);
      } else if (action === "stop") {
        if (job.status !== "running") throw new Error("这个任务没有在运行。");
        const status = await readJson(this.statusPath(entry, job), null).catch(() => null);
        Object.assign(job, { status: "stopped", finishedAt: now() });
        await this.saveJob(entry, job);
        await this.killTree({ runnerPid: status?.runnerPid ?? job.runnerPid, childPid: status?.pid }, this.platform).catch(() => {});
        entry.environmentLeases?.get(job.id)?.release();
        entry.environmentLeases?.delete(job.id);
        entry.experiment.notices.push({ text: `研究者停止了后台任务 ${job.name}（${job.id}），它没有正常结束。日志：${job.log}。`, wake: false });
        await this.append(entry, { type: "system", text: `已停止后台任务 ${job.name}。`, jobId: job.id });
        await this.saveExperiment(entry);
      } else throw new Error("不支持的操作。");
      return clone(job);
    });
  }

  ensurePolling() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pollAll(); }, this.pollMs);
    this.timer.unref?.();
  }

  async pollAll() {
    if (this.stopping) return;
    if (this.polling) return this.polling;
    const polling = (async () => {
      let running = 0;
      for (const loading of [...this.entries.values()]) {
        if (this.stopping) break;
        const entry = await loading.catch(() => null);
        if (!entry) continue;
        for (const job of [...entry.jobs.values()]) {
          if (job.status !== "running") continue;
          running += 1;
          await this.serial(entry, () => this.checkJob(entry, job)).catch(() => {});
        }
      }
      if (!running && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    })();
    this.polling = polling;
    try { await polling; }
    finally { if (this.polling === polling) this.polling = null; }
  }

  async checkJob(entry, job) {
    if (job.status !== "running") return;
    const path = this.statusPath(entry, job);
    const status = await readJson(path, null).catch(() => null);
    if (status?.state === "finished") return this.finishJob(entry, job, status);
    await this.refreshLastLine(entry, job, true);
    const pid = status?.runnerPid ?? job.runnerPid;
    const age = Date.now() - Date.parse(job.startedAt ?? 0);
    if ((!pid || !alive(pid)) && age > 15_000) {
      const again = await readJson(path, null).catch(() => null);
      return this.finishJob(entry, job, again?.state === "finished" ? again : { state: "lost" });
    }
  }

  async finishJob(entry, job, status) {
    if (job.status !== "running") return;
    entry.environmentLeases?.get(job.id)?.release();
    entry.environmentLeases?.delete(job.id);
    const lost = status.state === "lost";
    job.exitCode = lost ? null : Number.isInteger(status.exitCode) ? status.exitCode : -1;
    job.status = lost ? "lost" : job.exitCode === 0 ? "done" : "failed";
    job.finishedAt = status.finishedAt ?? now();
    await this.refreshLastLine(entry, job, false);
    await this.saveJob(entry, job);
    const duration = job.startedAt ? formatDuration(Date.parse(job.finishedAt) - Date.parse(job.startedAt)) : "未知";
    const outcome = lost ? "的进程已经不在了（可能电脑重启过），没有拿到退出码" : `结束：退出码 ${job.exitCode}，用时 ${duration}`;
    const label = job.origin === "user" ? `你手动运行的命令（${job.id}）` : `后台任务 ${job.name}`;
    await this.append(entry, { type: "system", text: `${label}${outcome}。`, jobId: job.id });
    const log = await this.logTail(entry, job, 3000).catch(() => "");
    const who = job.origin === "user" ? `研究者手动运行的命令（${job.id}）` : `后台任务 ${job.name}（${job.id}）`;
    entry.experiment.notices.push({
      wake: job.origin !== "user" || job.notify === true,
      progress: job.status === "done",
      text: `${who}${outcome}。命令：${job.command}。完整日志：${job.log}。日志末尾：\n\`\`\`\n${log.trim() || "（日志为空）"}\n\`\`\``,
    });
    await this.saveExperiment(entry);
    setImmediate(() => this.maybeWake(entry));
  }

  async logTail(entry, job, maxBytes = 3000) {
    const path = join(entry.workspace, ...job.log.split("/"));
    let handle;
    try {
      handle = await open(path, "r");
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString("utf8").replace(/^\uFFFD+/, "");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    } finally {
      await handle?.close();
    }
  }

  /** 运行中的任务：把日志最后一行放进任务信息，供任务卡和终端面板的折叠栏显示。只在内存里更新，结束时随任务保存。 */
  async refreshLastLine(entry, job, publish) {
    const line = lastLogLine(await this.logTail(entry, job, 4096).catch(() => ""));
    if (line === (job.lastLine ?? "")) return;
    job.lastLine = line;
    if (publish) this.publish(entry, { jobs: [clone(job)] });
  }

  /**
   * 按字节偏移增量读日志。首次从最后 512KB 开始读；日志被截断时从头重读。
   * 返回原始字节，由界面按 UTF-8 流式解码，避免一个字被切在两次读取之间。
   */
  async readJobLogChunk(projectId, id, jobId, from) {
    if (typeof jobId !== "string" || !jobPattern.test(jobId)) throw new Error("任务编号无效。");
    const entry = await this.entry(projectId, id);
    const job = entry.jobs.get(jobId);
    if (!job) throw new Error("任务不存在。");
    const path = join(entry.workspace, ...job.log.split("/"));
    let handle;
    try {
      handle = await open(path, "r");
      const { size } = await handle.stat();
      const fresh = !Number.isSafeInteger(from) || from < 0 || from > size;
      const reset = Number.isSafeInteger(from) && from > size;
      const start = reset ? 0 : fresh ? Math.max(0, size - logFirstWindow) : from;
      const length = Math.min(size - start, logChunkLimit);
      const bytes = new Uint8Array(length);
      const bytesRead = length ? (await handle.read(bytes, 0, length, start)).bytesRead : 0;
      return { bytes: bytes.subarray(0, bytesRead), from: start, next: start + bytesRead, size, skipped: fresh ? start : 0, reset, status: job.status };
    } catch (error) {
      if (error.code === "ENOENT") return { bytes: new Uint8Array(0), from: 0, next: 0, size: 0, skipped: 0, reset: Number.isSafeInteger(from) && from > 0, status: job.status };
      throw error;
    } finally {
      await handle?.close();
    }
  }

  /** 在实验工作目录（或其中的子目录）打开一个系统终端窗口，研究者可以在里面随意敲命令，与平台互不影响。 */
  async openTerminal(projectId, id, path = ".") {
    const cwd = await this.resolvePath(projectId, id, path || ".");
    if (!(await stat(cwd)).isDirectory()) throw new Error("只能在文件夹里打开终端。");
    const environmentLease = await this.environments?.acquire(projectId, true);
    const [file, args] = this.platform === "win32" ? ["powershell.exe", ["-NoExit", "-NoLogo"]]
      : this.platform === "darwin" ? ["open", ["-a", "Terminal", cwd]]
      : ["x-terminal-emulator", []];
    try {
      await new Promise((done, fail) => {
        let child;
        try { child = this.spawn(file, args, { cwd, detached: true, stdio: "ignore", windowsHide: false, env: environmentLease?.env ?? this.env }); }
        catch (error) { fail(error); return; }
        child.once?.("spawn", () => done(child));
        child.once?.("error", (error) => fail(new Error(`打不开终端：${error.message}`)));
        child.unref?.();
        if (!child.once) done(child);
      }).then(async (child) => {
        await this.environments?.trackTerminal(projectId, child.pid);
      });
    } finally { environmentLease?.release(); }
    return true;
  }

  async readJobLog(projectId, id, jobId) {
    if (typeof jobId !== "string" || !jobPattern.test(jobId)) throw new Error("任务编号无效。");
    const entry = await this.entry(projectId, id);
    const job = entry.jobs.get(jobId);
    if (!job) throw new Error("任务不存在。");
    return this.logTail(entry, job, 20_000);
  }

  // ---------- 文件 ----------

  /** 只列两层，跳过虚拟环境、缓存等大目录，避免把几十万个文件送到界面。 */
  async listFiles(projectId, id) {
    const entry = await this.entry(projectId, id);
    let count = 0;
    const walk = async (directory, prefix, depth) => {
      const items = (await readdir(directory, { withFileTypes: true }).catch(() => []))
        .filter((item) => !item.isSymbolicLink())
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, "zh-CN", { numeric: true }) : a.isDirectory() ? -1 : 1));
      const nodes = [];
      for (const item of items) {
        if (count >= 400) break;
        count += 1;
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) {
          const open = depth < 1 && !heavyDirectories.has(item.name) && path !== ".ar/requests";
          nodes.push({ name: item.name, path, kind: "directory", size: 0, children: open ? await walk(join(directory, item.name), path, depth + 1) : [], collapsed: !open });
        } else if (item.isFile()) {
          const info = await stat(join(directory, item.name)).catch(() => null);
          nodes.push({ name: item.name, path, kind: "file", size: info?.size ?? 0 });
        }
      }
      return nodes;
    };
    return walk(entry.workspace, "", 0);
  }

  async resolvePath(projectId, id, path = "") {
    const entry = await this.entry(projectId, id);
    const value = typeof path === "string" ? path : "";
    if (value.includes("\0") || isAbsolute(value) || /^[a-z]:/i.test(value)) throw new Error("路径无效。");
    const target = resolve(entry.workspace, ...value.split(/[\\/]/).filter(Boolean));
    const info = await lstat(target).catch(() => null);
    if (!info) throw new Error("文件不存在。");
    const [root, real] = await Promise.all([realpath(entry.workspace), realpath(target)]);
    if (!inside(root, real)) throw new Error("只能打开实验工作目录里的文件。");
    return real;
  }

  // ---------- 生命周期 ----------

  async recover(projectIds) {
    for (const projectId of projectIds) {
      const names = await this.experimentNames(projectId);
      for (const name of names) {
        if (!experimentPattern.test(name)) continue;
        let entry;
        try { entry = await this.entry(projectId, name); } catch { continue; }
        await this.ensureEnvironmentHelper(entry.workspace).catch(async (error) => {
          await this.append(entry, { type: "error", text: `无法准备依赖申请入口：${safeError(error)}` }).catch(() => {});
        });
        await this.ensureQuestionHelper(entry.workspace).catch(async (error) => {
          await this.append(entry, { type: "error", text: `无法准备研究者提问入口：${safeError(error)}` }).catch(() => {});
        });
        await this.serial(entry, async () => {
          const experiment = entry.experiment;
          if (experiment.agent === "working" && !entry.turn) {
            experiment.agent = experiment.pendingQuestion ? "waiting" : "idle";
            experiment.activity = experiment.pendingQuestion ? "等待你作答" : "";
            experiment.notices.unshift(...(experiment.inFlightNotices ?? []));
            experiment.inFlightNotices = [];
            await this.append(entry, { type: "system", text: "应用关闭时 agent 这一轮被中断了。" });
            await this.saveExperiment(entry);
          }
          if (!entry.turn && experiment.pendingContinuation && !experiment.pendingQuestion) {
            const continuation = experiment.pendingContinuation;
            experiment.notices = (experiment.notices ?? []).filter((notice) => notice.text !== continuation);
            experiment.inFlightNotices = [];
            const notice = { text: continuation, wake: true };
            this.startTurn(entry, userTurnPrompt({
              text: continuation,
              notices: [],
              newThread: !experiment.threadId && experiment.turns > 0,
            }), [notice]);
          }
        });
        await this.pollQuestionRequests(entry).catch(() => {});
        await this.collectRequests(entry).catch(() => {});
        await this.environments?.collect(projectId, entry.experiment, entry.workspace).catch(() => {});
        if ([...entry.jobs.values()].some((job) => job.status === "running")) this.ensurePolling();
        this.maybeWake(entry);
      }
    }
    await this.pollAll();
  }

  /** 停止所有 agent 回合（切换数据目录或退出应用时）。后台任务是独立进程，不受影响。 */
  async stopAll() {
    this.stopping = true;
    try {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      await this.polling;
      const entries = await Promise.all([...this.entries.values()].map((loading) => loading.catch(() => null)));
      for (const entry of entries) if (entry) entry.closed = true;
      for (const entry of entries) if (entry) this.stopQuestionPolling(entry);
      for (const entry of entries) if (entry?.environmentLeases) {
        for (const lease of entry.environmentLeases.values()) lease.release();
        entry.environmentLeases.clear();
      }
      for (const entry of entries) entry?.controller?.abort(new Error("应用正在关闭"));
      await Promise.all(entries.map((entry) => entry?.turn));
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.entries.clear();
    } finally {
      this.stopping = false;
    }
  }
}
