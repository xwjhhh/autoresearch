import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isProjectId } from "../project-directories.mjs";
import { buildJobEnv } from "../experiments/service.mjs";
import { environmentVariables } from "./runtime.mjs";

const execute = promisify(execFile);
const now = () => new Date().toISOString();
const copy = (value) => structuredClone(value);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const packageName = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
// 清单中的显示顺序、名称写法和用途备注不代表环境发生变化。
const inventoryHash = (packages) => hash(packages.map(({ name, version, source }) => [packageName(name), version, source]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
const clearPlan = (request) => {
  delete request.plan;
  request.changes = request.packages.map((name) => ({ name, before: null, after: "待解析" }));
};
const normal = (path) => resolve(path).replace(/\\/g, "/").toLowerCase();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const json = async (path, fallback) => { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } };
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, path);
}

export function validatePackages(packages, manager) {
  if (!["pip", "conda"].includes(manager) || !Array.isArray(packages) || !packages.length || packages.length > 50) throw new Error("请选择 pip 或 Conda，并提交 1–50 个依赖。");
  // 不把 agent 的请求当成 shell 命令：只接受包名和简单版本约束。
  const pattern = manager === "pip"
    ? /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:(?:==|>=|<=|~=|!=|>|<)[A-Za-z0-9.*+!_-]+(?:,(?:==|>=|<=|~=|!=|>|<)[A-Za-z0-9.*+!_-]+)*)?$/
    : /^[A-Za-z0-9][A-Za-z0-9._-]*(?:(?:=|==|>=|<=|!=|>|<)[A-Za-z0-9.*+!_-]+(?:,(?:==|>=|<=|!=|>|<)[A-Za-z0-9.*+!_-]+)*)?$/;
  if (packages.some((value) => typeof value !== "string" || value.length > 200 || !pattern.test(value) || /^(?:python|pip|conda)(?:[<>=!~\[]|$)/i.test(value))) throw new Error("依赖只接受包名及版本约束；不能包含 URL、文件、命令参数，或变更 Python/pip/Conda 自身。更换 Python 请绑定另一个环境。");
  return [...new Set(packages)];
}

export class ProjectEnvironmentService {
  constructor({ dataRoot, project, experiments = async () => [], notify = async () => {}, emit = () => {}, env = process.env, platform = process.platform, run } = {}) {
    Object.assign(this, { dataRoot, project, experiments, notify, emit, env, platform });
    this.entries = new Map();
    this.leases = new Map();
    this.discovery = null;
    this.run = run || (async (file, args, options = {}) => {
      try {
        const { stdout } = await execute(file, args, { env: buildJobEnv(env), windowsHide: true, timeout: 120_000, maxBuffer: 12 * 1024 * 1024, ...options });
        return stdout;
      } catch (error) {
        const message = String(error.stderr || error.stdout || error.message).slice(-6000);
        throw new Error(`环境命令失败：${message}`, { cause: error });
      }
    });
  }

  directory(projectId) {
    if (!isProjectId(projectId)) throw new Error("课题编号无效。");
    return join(this.dataRoot(), "Environments", projectId);
  }
  async entry(projectId) {
    const directory = this.directory(projectId);
    if (!this.entries.has(directory)) {
      this.entries.set(directory, (async () => {
        const saved = await json(join(directory, "environment.json"), null);
        const entry = { directory, projectId, environment: null, packages: [], history: [], requests: [], error: "", terminals: [], ...saved, operation: null, progress: 0 };
        if (saved?.operation) {
          entry.error = "上次环境操作被中断。请检查环境后重试；平台没有自动删除、重建或回滚环境。";
          for (const request of entry.requests) {
            if (request.status === "installing") request.status = "failed";
            clearPlan(request);
          }
          if (saved.operation === "update") entry.error = "上次依赖更新被中断，部分依赖可能已安装。请重新解析安装计划，平台会同步实际清单后再交给你确认。";
          await this.persist(entry);
        }
        return entry;
      })());
    }
    return this.entries.get(directory);
  }
  async persist(entry) { await save(join(entry.directory, "environment.json"), { ...entry, directory: undefined }); }
  publish(entry) { this.emit({ projectId: entry.projectId }); }
  reset() {
    this.entries.clear();
    this.leases.clear();
    this.discovery = null;
  }
  isBusy() { return [...this.leases.values()].some((entry) => entry.count > 0); }
  async hasOperations() { for (const pending of this.entries.values()) if ((await pending).operation) return true; return false; }
  async locked(entry) {
    entry.terminals = entry.terminals.filter((item) => alive(item.pid));
    return entry.terminals.length > 0
      || (this.leases.get(entry.directory)?.count || 0) > 0
      || (await this.experiments(entry.projectId)).some((item) => item.status === "running" || item.status === "needs_input" || item.agent === "working" || item.agent === "waiting" || item.runningJobs > 0);
  }
  async discover(explicit = "") {
    if (!explicit && this.discovery) return this.discovery;
    const discover = async () => {
      const home = this.env.USERPROFILE || this.env.HOME || "";
      const candidates = explicit ? [explicit] : [this.env.CONDA_EXE, this.env._CONDA_EXE,
        ...String(this.env.PATH || this.env.Path || "").split(this.platform === "win32" ? ";" : ":").map((path) => join(path.replace(/^"|"$/g, ""), this.platform === "win32" ? "conda.exe" : "conda")),
        ...[home, this.env.ProgramData, this.env.PROGRAMDATA, this.env.LOCALAPPDATA].filter(Boolean).flatMap((root) => ["miniconda3", "anaconda3", "Miniforge3", "miniforge3"].map((name) => join(root, name, this.platform === "win32" ? "Scripts/conda.exe" : "bin/conda")))];
      for (const candidate of [...new Set(candidates.filter(Boolean))]) {
        if (!isAbsolute(candidate) || (this.platform === "win32" && !/\.exe$/i.test(candidate))) continue;
        try {
          if (!(await stat(candidate)).isFile()) continue;
          const info = JSON.parse(await this.run(candidate, ["info", "--json"]));
          if (!info.root_prefix) continue;
          let envs = info.envs || [];
          try { envs = JSON.parse(await this.run(candidate, ["env", "list", "--json"])).envs || envs; } catch { /* 仍可手动绑定。 */ }
          return { executable: candidate, base: await realpath(info.root_prefix), envs };
        } catch { /* 无效候选继续查找，不安装 Conda。 */ }
      }
      if (explicit) throw new Error("指定的 Conda 程序不可用，请选择安装目录下的 Scripts/conda.exe。");
      return null;
    };
    if (explicit) return discover();
    this.discovery = discover();
    return this.discovery;
  }
  python(prefix) { return join(prefix, this.platform === "win32" ? "python.exe" : "bin/python"); }
  async inspect(prefix, conda) {
    if (!isAbsolute(prefix)) throw new Error("环境目录必须是绝对路径。");
    const canonical = await realpath(prefix);
    if (normal(canonical) === normal(conda.base)) throw new Error("不能绑定 base 基础环境，请选择独立 Conda 环境。");
    await stat(join(canonical, "conda-meta", "history"));
    const data = JSON.parse(await this.run(this.python(canonical), ["-I", "-c", "import json,sys,platform;print(json.dumps({'prefix':sys.prefix,'version':platform.python_version(),'architecture':platform.architecture()[0]}))"], { env: environmentVariables(buildJobEnv(this.env), { prefix: canonical }, this.platform) }));
    if (normal(await realpath(data.prefix)) !== normal(canonical)) throw new Error("Python 解释器实际属于其他环境，不能绑定。");
    const packages = JSON.parse(await this.run(conda.executable, ["list", "--prefix", canonical, "--json"])).map((item) => ({ name: item.name, version: item.version, source: item.channel === "pypi" || item.build_string === "pypi_0" ? "pip" : "conda", purpose: "" })).sort((a, b) => a.name.localeCompare(b.name));
    return { prefix: canonical, pythonVersion: data.version, architecture: data.architecture, packages };
  }
  async uniqueBinding(entry, prefix) {
    const root = dirname(entry.directory);
    for (const item of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!item.isDirectory() || item.name === entry.projectId) continue;
      const other = await json(join(root, item.name, "environment.json"), null);
      if (other?.environment && normal(other.environment.prefix) === normal(prefix)) throw new Error("这个环境已绑定另一个课题，请为当前课题选择独立环境。");
    }
  }
  async get(projectId) {
    const entry = await this.entry(projectId);
    const conda = await this.discover(entry.environment?.condaExecutable || "").catch(() => null);
    const project = await this.project(projectId);
    const experiments = await this.experiments(projectId);
    return copy({ projectId, projectTitle: project.title, suggestedName: `ar-${project.title}`.slice(0, 50), prefix: join(entry.directory, "conda"), condaExecutable: conda?.executable || "", condaDetected: !!conda,
      environment: entry.environment, packages: entry.packages, experiments, history: entry.history, error: entry.error, operation: entry.operation, progress: entry.progress,
      locked: await this.locked(entry), request: entry.requests.find((item) => ["pending", "installing", "failed"].includes(item.status)) || null,
      availableEnvironments: (conda?.envs || []).map((prefix) => ({ prefix, name: basename(prefix), base: normal(prefix) === normal(conda.base) })) });
  }
  async mutate(projectId, operation, action, { readOnly = false } = {}) {
    const entry = await this.entry(projectId);
    if (entry.operation) throw new Error("环境操作正在进行，请稍后再试。");
    entry.operation = operation; entry.progress = 5;
    try {
      if (!readOnly && await this.locked(entry)) throw new Error("有实验或平台终端正在使用这个环境，请先停止任务并关闭终端。");
      await this.persist(entry); this.publish(entry);
      const progress = async (value) => { entry.progress = value; this.publish(entry); };
      await action(entry, progress);
      entry.error = "";
    } catch (error) {
      const message = String(error.message || error);
      if (!message.startsWith("有实验或平台终端正在使用这个环境")) entry.error = message.slice(0, 6000);
      throw error;
    } finally {
      entry.operation = null; entry.progress = 0;
      await this.persist(entry); this.publish(entry);
    }
    return this.get(projectId);
  }
  async record(entry, title, detail) {
    entry.history.unshift({ id: randomUUID(), title, detail, time: now(), revision: entry.environment?.revision || 0 });
    entry.history = entry.history.slice(0, 100);
    await save(join(entry.directory, "snapshots", `${Date.now()}-${randomUUID()}.json`), { at: now(), environment: entry.environment, packages: entry.packages });
  }
  async syncInspection(entry, inspected) {
    const changed = inventoryHash(inspected.packages) !== inventoryHash(entry.packages);
    if (changed) {
      entry.packages = inspected.packages;
      entry.environment.revision++;
      for (const request of entry.requests) clearPlan(request);
    }
    Object.assign(entry.environment, { pythonVersion: inspected.pythonVersion, architecture: inspected.architecture, checkedAt: now() });
    return changed;
  }
  async bind(projectId, input) {
    return this.mutate(projectId, "bind", async (entry, progress) => {
      const name = String(input.name || "").trim();
      if (!name || name.length > 50) throw new Error("请填写 1–50 字的环境显示名称。");
      const conda = await this.discover(input.condaExecutable || entry.environment?.condaExecutable || "");
      if (!conda) throw new Error("尚未找到 Conda，请填写 Conda 程序位置。");
      await progress(30);
      const inspected = await this.inspect(String(input.prefix || ""), conda);
      await this.uniqueBinding(entry, inspected.prefix);
      await progress(80);
      entry.environment = { name, prefix: inspected.prefix, condaExecutable: conda.executable, pythonVersion: inspected.pythonVersion, architecture: inspected.architecture, revision: (entry.environment?.revision || 0) + 1, checkedAt: now(), diskUsage: "未统计" };
      entry.packages = inspected.packages;
      for (const request of entry.requests) clearPlan(request);
      await this.record(entry, "绑定课题 Conda 环境", `绑定 ${name}；所有课题实验复用此环境。`);
    });
  }
  async create(projectId, input) {
    return this.mutate(projectId, "create", async (entry, progress) => {
      if (entry.environment) throw new Error("课题已绑定环境，不会重复创建；需要更换时请绑定已有环境。");
      const name = String(input.name || "").trim();
      if (!name || name.length > 50 || !/^3\.(?:9|10|11|12|13|14)$/.test(input.pythonVersion)) throw new Error("环境名称或 Python 版本无效。");
      const conda = await this.discover(input.condaExecutable);
      if (!conda) throw new Error("未找到 Conda。");
      const prefix = join(entry.directory, "conda");
      try { await stat(prefix); throw new Error("目标目录已经存在。请检查之前创建的环境并使用“绑定已有环境”，不会覆盖或删除该目录。"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await progress(25);
      await this.run(conda.executable, ["create", "--prefix", prefix, `python=${input.pythonVersion}`, "pip", "--yes", "--json"], { timeout: 30 * 60_000 });
      await progress(80);
      const inspected = await this.inspect(prefix, conda);
      entry.environment = { name, prefix: inspected.prefix, condaExecutable: conda.executable, pythonVersion: inspected.pythonVersion, architecture: inspected.architecture, revision: 1, checkedAt: now(), diskUsage: "未统计" };
      entry.packages = inspected.packages;
      await this.record(entry, "创建课题 Conda 环境", `Python ${input.pythonVersion}，使用固定课题 ID 保存；不为单个实验创建环境。`);
    });
  }
  async check(projectId) {
    return this.mutate(projectId, "check", async (entry, progress) => {
      if (!entry.environment) throw new Error("请先创建或绑定环境。");
      const conda = await this.discover(entry.environment.condaExecutable);
      await progress(35);
      const inspected = await this.inspect(entry.environment.prefix, conda);
      if (await this.syncInspection(entry, inspected)) {
        await this.record(entry, "检测到依赖变化", "本机依赖清单发生变化，已重新记录快照。旧的待确认安装计划需要重新解析。");
      }
      await progress(90);
    }, { readOnly: true });
  }
  async acquire(projectId, required = true) {
    const entry = await this.entry(projectId);
    if (entry.operation) throw new Error("课题环境正在检查或变更，请稍后再运行。");
    if ((required || entry.environment) && (!entry.environment || entry.error)) throw new Error(entry.error || "请先在“运行环境”为课题创建或绑定 Conda 环境。");
    const lease = this.leases.get(entry.directory) || { count: 0 };
    lease.count++; this.leases.set(entry.directory, lease); this.publish(entry);
    let released = false;
    return { environment: copy(entry.environment), env: environmentVariables(this.env, entry.environment, this.platform), release: () => { if (!released) { released = true; lease.count--; this.publish(entry); } } };
  }
  async trackTerminal(projectId, pid) {
    const entry = await this.entry(projectId);
    if (!Number.isInteger(pid) || pid <= 0) return;
    entry.terminals = entry.terminals.filter((item) => alive(item.pid));
    entry.terminals.push({ pid, startedAt: now() });
    await this.persist(entry); this.publish(entry);
  }
  async writeWorkspaceInfo(workspace, environment) {
    const directory = join(workspace, ".ar");
    await mkdir(directory, { recursive: true });
    await save(join(directory, "environment.json"), {
      environment: environment ? {
        name: environment.name,
        prefix: environment.prefix,
        pythonVersion: environment.pythonVersion,
        revision: environment.revision,
      } : null,
      updatedAt: now(),
    });
  }
  async collect(projectId, experiment, workspace) {
    if (typeof workspace !== "string" || !workspace) throw new Error("实验工作目录无效，不能读取依赖申请。");
    const directory = join(workspace, ".ar", "environment-requests");
    const entry = await this.entry(projectId);
    for (const file of (await readdir(directory).catch(() => [])).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).slice(0, 50)) {
      const path = join(directory, file);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32_000) throw new Error("依赖申请文件无效。");
        const input = await json(path, null);
        const packages = validatePackages(input?.packages, input?.manager);
        const id = file.slice(0, -5);
        if (!entry.requests.some((item) => item.id === id)) {
          entry.requests.push({ id, experimentId: experiment.id, experiment: experiment.title, manager: input.manager, packages, note: String(input.note || "").slice(0, 1000), status: "pending", changes: packages.map((name) => ({ name, before: null, after: "待解析" })) });
          await this.persist(entry); this.publish(entry);
        }
        await rename(path, `${path}.received`);
      } catch (error) { await rename(path, `${path}.invalid`).catch(() => {}); await this.notify(projectId, experiment.id, `依赖申请未接收：${error.message}`, false); }
    }
  }
  async resolvePlan(entry, request) {
    const environment = entry.environment;
    if (!environment) throw new Error("请先绑定环境。");
    const packages = validatePackages(request.packages, request.manager);
    const options = { env: environmentVariables(buildJobEnv(this.env), environment, this.platform), timeout: 10 * 60_000 };
    let targets;
    if (request.manager === "conda") {
      const result = JSON.parse(await this.run(environment.condaExecutable, ["install", "--prefix", environment.prefix, "--dry-run", "--json", ...packages], options));
      if (result.success === false) throw new Error(result.message || result.error || "Conda 无法解析安装计划。");
      const before = new Map((result.actions?.UNLINK || []).map((item) => [item.name, item.version]));
      targets = (result.actions?.LINK || []).map((item) => ({ name: item.name, before: before.get(item.name) || null, after: item.version, build: item.build_string || item.build || "" }));
      for (const item of result.actions?.UNLINK || []) if (!targets.some((target) => target.name === item.name)) targets.push({ name: item.name, before: item.version, after: "移除", build: "" });
    } else {
      const report = join(entry.directory, `pip-plan-${request.id}.json`);
      await this.run(this.python(environment.prefix), ["-I", "-m", "pip", "install", "--dry-run", "--report", report, "--disable-pip-version-check", ...packages], options);
      const result = await json(report, null);
      if (!Array.isArray(result?.install)) throw new Error("pip 没有返回有效安装计划，请检查环境中的 pip 是否支持 --dry-run。");
      targets = result.install.map((item) => ({ name: item.metadata.name, before: entry.packages.find((pkg) => pkg.name.toLowerCase().replace(/[-_.]+/g, "-") === item.metadata.name.toLowerCase().replace(/[-_.]+/g, "-"))?.version || null, after: item.metadata.version, build: "" }));
    }
    if (targets.some((item) => /^(?:python|pip|conda)$/i.test(item.name))) throw new Error("安装计划会修改 Python/pip/Conda，请调整依赖约束或人工处理环境后重新检查。");
    targets.sort((a, b) => a.name.localeCompare(b.name));
    return { revision: environment.revision, prefix: environment.prefix, changes: targets, fingerprint: hash(targets) };
  }
  request(entry, id) {
    const request = entry.requests.find((item) => item.id === id && ["pending", "failed"].includes(item.status));
    if (!request) throw new Error("申请已处理或不存在，请刷新。");
    return request;
  }
  async prepare(projectId, id) {
    return this.mutate(projectId, "plan", async (entry, progress) => {
      const request = this.request(entry, id);
      clearPlan(request);
      const conda = await this.discover(entry.environment?.condaExecutable || "");
      if (!conda || !entry.environment) throw new Error("请先绑定可用环境。");
      const inspected = await this.inspect(entry.environment.prefix, conda);
      if (await this.syncInspection(entry, inspected)) {
        await this.record(entry, "同步实际依赖清单", "环境依赖与上次记录不同（可能来自中断的安装或外部变更），已保存实际清单并作废旧计划；将按当前环境重新解析，不会自动安装。");
      }
      await progress(35);
      request.plan = await this.resolvePlan(entry, request); request.changes = request.plan.changes;
      request.status = "pending";
      await progress(90);
    });
  }
  async approve(projectId, id, fingerprint) {
    let completed;
    const result = await this.mutate(projectId, "update", async (entry, progress) => {
      const request = this.request(entry, id);
      if (!entry.environment || !request.plan || request.plan.fingerprint !== fingerprint || request.plan.revision !== entry.environment.revision || request.plan.prefix !== entry.environment.prefix) throw new Error("环境或安装计划已经变化，请重新查看并确认。");
      const conda = await this.discover(entry.environment.condaExecutable);
      const inspected = await this.inspect(entry.environment.prefix, conda);
      if (await this.syncInspection(entry, inspected)) {
        await this.record(entry, "确认前检测到依赖变化", "已同步实际依赖并作废旧计划；需要重新解析和确认，尚未执行本次安装。");
        throw new Error("依赖清单已变化，已同步实际环境。请重新解析安装计划并确认。");
      }
      await progress(15);
      const fresh = await this.resolvePlan(entry, request);
      if (fresh.fingerprint !== fingerprint) { clearPlan(request); throw new Error("解析出的依赖版本发生变化，请重新查看安装计划后确认。"); }
      if (fresh.changes.length) await this.record(entry, "安装前依赖快照", `申请 ${id}，${request.manager}：${request.packages.join("、")}`);
      request.status = "installing"; await this.persist(entry); await progress(35);
      try {
        if (fresh.changes.length) {
          const args = request.manager === "conda" ? ["install", "--prefix", entry.environment.prefix, "--yes", "--json", ...request.packages]
            : ["-I", "-m", "pip", "install", "--disable-pip-version-check", ...request.packages];
          await this.run(request.manager === "conda" ? entry.environment.condaExecutable : this.python(entry.environment.prefix), args, { env: environmentVariables(buildJobEnv(this.env), entry.environment, this.platform), timeout: 30 * 60_000 });
        }
        await progress(80);
        const after = await this.inspect(entry.environment.prefix, conda);
        await this.syncInspection(entry, after);
        // 校验前先持久化已经发生的安装结果，避免关闭应用后仍显示安装前清单。
        await this.persist(entry); this.publish(entry);
        await this.run(this.python(entry.environment.prefix), ["-I", "-m", "pip", "check"], { env: environmentVariables(buildJobEnv(this.env), entry.environment, this.platform) });
        request.status = "approved"; completed = { request, changes: fresh.changes.length };
        clearPlan(request);
        await this.record(entry, fresh.changes.length ? "更新共享依赖" : "确认依赖已满足", `${request.manager}：${request.packages.join("、")}；${fresh.changes.length ? "安装完成" : "已满足要求，无需重复安装"}，兼容性检查通过。`);
      } catch (error) {
        request.status = "failed"; clearPlan(request);
        const after = await this.inspect(entry.environment.prefix, conda).catch(() => null);
        if (after) await this.syncInspection(entry, after);
        await this.record(entry, "依赖更新失败", "保留实际环境与已安装包，请检查错误；没有自动重建或回滚环境。");
        throw error;
      }
    });
    if (completed) {
      const outcome = completed.changes ? "已安装并完成兼容性检查" : "已满足要求，无需重复安装";
      await this.notify(projectId, completed.request.experimentId, `课题共享依赖申请已确认：${completed.request.packages.join("、")}；${outcome}。环境修订 v${result.environment.revision}，可以继续实验。`, true);
    }
    return result;
  }
  async reject(projectId, id) {
    const entry = await this.entry(projectId);
    if (entry.operation) throw new Error("请等待当前环境操作结束。");
    const request = this.request(entry, id); request.status = "rejected";
    await this.persist(entry); this.publish(entry);
    await this.notify(projectId, request.experimentId, "研究者暂不安装本次依赖，请等待后续指示。", false);
    return this.get(projectId);
  }
}
