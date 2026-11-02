import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ProjectEnvironmentService, validatePackages } from "./environments/service.mjs";
import { environmentVariables } from "./environments/runtime.mjs";

async function updateFixture() {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-env-update-"));
  const projectId = randomUUID(), requestId = randomUUID();
  const directory = join(root, "Environments", projectId);
  const prefix = join(directory, "conda");
  const condaRoot = join(root, "miniconda3"), condaExecutable = join(condaRoot, "Scripts", "conda.exe");
  await mkdir(dirname(condaExecutable), { recursive: true });
  await writeFile(condaExecutable, "test stub");
  await mkdir(join(prefix, "conda-meta"), { recursive: true });
  await writeFile(join(prefix, "conda-meta", "history"), "test environment");
  const ctx = { root, projectId, requestId, directory, prefix, installs: 0, checks: 0, version: "0.2.0", resolverError: false, installError: false, checkError: false, onCheck: null, notices: [],
    packages: [{ name: "python", version: "3.11.18", channel: "defaults" }, { name: "pip", version: "26.2.2", channel: "defaults" }] };
  ctx.run = async (file, args) => {
    if (args[0] === "info") return JSON.stringify({ root_prefix: condaRoot });
    if (args[0] === "env") return JSON.stringify({ envs: [condaRoot, prefix] });
    if (args[0] === "list") return JSON.stringify(ctx.packages);
    if (args[0] === "-I" && args[1] === "-c") return JSON.stringify({ prefix: dirname(file), version: "3.11.18", architecture: "64bit" });
    if (args.slice(0, 4).join(" ") === "-I -m pip install") {
      if (args.includes("--dry-run")) {
        if (ctx.resolverError) throw new Error("test resolver unavailable");
        const installed = ctx.packages.find((item) => item.name === "skillopt");
        await writeFile(args[args.indexOf("--report") + 1], JSON.stringify({ install: installed?.version === ctx.version ? [] : [{ metadata: { name: "skillopt", version: ctx.version } }] }));
        return "dry-run only";
      }
      const snapshots = await readdir(join(directory, "snapshots"));
      const contents = await Promise.all(snapshots.map(async (name) => JSON.parse(await readFile(join(directory, "snapshots", name), "utf8"))));
      assert.ok(contents.some((snapshot) => !snapshot.packages.some((item) => item.name === "skillopt")), "the pre-install snapshot exists before running pip");
      ctx.installs++;
      ctx.packages.push({ name: "skillopt", version: ctx.version, channel: "pypi" });
      if (ctx.installError) throw new Error("test install failed after writing packages");
      return "installed";
    }
    if (args.slice(0, 4).join(" ") === "-I -m pip check") {
      ctx.checks++;
      await ctx.onCheck?.();
      if (ctx.checkError) throw new Error("test dependency conflict");
      return "No broken requirements found.";
    }
    throw new Error(`Unexpected environment command: ${args.join(" ")}`);
  };
  ctx.options = { dataRoot: () => root, project: async () => ({ title: "RSI" }), env: { PATH: "" }, platform: "win32", run: ctx.run, notify: async (...args) => ctx.notices.push(args) };
  ctx.service = new ProjectEnvironmentService(ctx.options);
  await ctx.service.bind(projectId, { name: "ar-RSI", prefix, condaExecutable });
  const workspace = join(root, "workspace"), requests = join(workspace, ".ar", "environment-requests");
  await mkdir(requests, { recursive: true });
  await writeFile(join(requests, `${requestId}.json`), JSON.stringify({ manager: "pip", packages: ["skillopt==0.2.0"] }));
  await ctx.service.collect(projectId, { id: "exp_002", title: "SkillOpt" }, workspace);
  ctx.cleanup = () => rm(root, { recursive: true, force: true });
  return ctx;
}

test("重新解析同步中断安装后的实际清单，已满足依赖不重复安装", async () => {
  const ctx = await updateFixture();
  try {
    const old = await ctx.service.prepare(ctx.projectId, ctx.requestId);
    ctx.packages.push({ name: "skillopt", version: "0.2.0", channel: "pypi" });
    const plan = await ctx.service.prepare(ctx.projectId, ctx.requestId);
    assert.equal(plan.environment.revision, 2);
    assert.equal(plan.packages.length, 3);
    assert.equal(plan.request.plan.revision, 2);
    assert.deepEqual(plan.request.changes, []);
    assert.notEqual(plan.request.plan.fingerprint, old.request.plan.fingerprint);
    assert.equal(ctx.installs, 0);
    assert.ok(plan.history.some((item) => item.title === "同步实际依赖清单"));
    const result = await ctx.service.approve(ctx.projectId, ctx.requestId, plan.request.plan.fingerprint);
    assert.equal(result.request, null);
    assert.equal(result.error, "");
    assert.equal(result.environment.revision, 2);
    assert.equal(ctx.installs, 0);
    assert.equal(ctx.checks, 1);
    assert.equal(result.history[0].title, "确认依赖已满足");
    assert.match(ctx.notices[0][2], /无需重复安装/);
  } finally { await ctx.cleanup(); }
});

test("安装前快照保存成功，安装结果在兼容性检查前持久化", async () => {
  const ctx = await updateFixture();
  try {
    const plan = await ctx.service.prepare(ctx.projectId, ctx.requestId);
    ctx.onCheck = async () => {
      const saved = JSON.parse(await readFile(join(ctx.directory, "environment.json"), "utf8"));
      assert.equal(saved.packages.find((item) => item.name === "skillopt").version, "0.2.0");
      assert.equal(saved.environment.revision, 2);
      assert.equal(saved.requests[0].status, "installing");
    };
    const result = await ctx.service.approve(ctx.projectId, ctx.requestId, plan.request.plan.fingerprint);
    assert.equal(result.request, null);
    assert.equal(result.environment.revision, 2);
    assert.equal(ctx.installs, 1);
    assert.equal(ctx.checks, 1);
    assert.equal(ctx.notices.length, 1);
    assert.match(ctx.notices[0][2], /已安装并完成兼容性检查/);
    const restored = await new ProjectEnvironmentService(ctx.options).get(ctx.projectId);
    assert.equal(restored.packages.length, 3);
    assert.equal(restored.error, "");
  } finally { await ctx.cleanup(); }
});

test("确认时环境真实变化会同步并作废旧计划，不能直接安装", async () => {
  const ctx = await updateFixture();
  try {
    const plan = await ctx.service.prepare(ctx.projectId, ctx.requestId);
    ctx.packages.push({ name: "numpy", version: "2.4.6", channel: "pypi" });
    await assert.rejects(ctx.service.approve(ctx.projectId, ctx.requestId, plan.request.plan.fingerprint), /重新解析安装计划并确认/);
    const result = await ctx.service.get(ctx.projectId);
    assert.equal(result.request.plan, undefined);
    assert.equal(result.environment.revision, 2);
    assert.equal(result.packages.length, 3);
    assert.equal(ctx.installs, 0);
  } finally { await ctx.cleanup(); }
});

test("清单顺序、包名分隔符及用途备注变化不误报依赖变化", async () => {
  const ctx = await updateFixture();
  try {
    ctx.packages.push({ name: "PyYAML", version: "6.0.3", channel: "pypi" }, { name: "typing_extensions", version: "4.16.0", channel: "pypi" });
    await ctx.service.check(ctx.projectId);
    const entry = await ctx.service.entry(ctx.projectId);
    entry.packages.reverse();
    entry.packages.find((item) => item.name === "typing_extensions").purpose = "实验备注";
    ctx.packages.find((item) => item.name === "typing_extensions").name = "typing-extensions";
    ctx.packages.find((item) => item.name === "PyYAML").name = "pyyaml";
    const plan = await ctx.service.prepare(ctx.projectId, ctx.requestId);
    assert.equal(plan.environment.revision, 2);
    assert.ok(plan.request.plan);
    await ctx.service.approve(ctx.projectId, ctx.requestId, plan.request.plan.fingerprint);
    assert.equal(ctx.installs, 1);
  } finally { await ctx.cleanup(); }
});

test("解析失败必须清除上次的确认计划", async () => {
  const ctx = await updateFixture();
  try {
    await ctx.service.prepare(ctx.projectId, ctx.requestId);
    ctx.resolverError = true;
    await assert.rejects(ctx.service.prepare(ctx.projectId, ctx.requestId), /resolver unavailable/);
    const result = await ctx.service.get(ctx.projectId);
    assert.equal(result.request.plan, undefined);
    assert.equal(result.request.changes[0].after, "待解析");
    assert.equal(ctx.installs, 0);
  } finally { await ctx.cleanup(); }
});

test("解析出的版本变化需要再次确认", async () => {
  const ctx = await updateFixture();
  try {
    const plan = await ctx.service.prepare(ctx.projectId, ctx.requestId);
    ctx.version = "0.2.1";
    await assert.rejects(ctx.service.approve(ctx.projectId, ctx.requestId, plan.request.plan.fingerprint), /依赖版本发生变化/);
    assert.equal((await ctx.service.get(ctx.projectId)).request.plan, undefined);
    assert.equal(ctx.installs, 0);
  } finally { await ctx.cleanup(); }
});

test("安装中途失败保留已安装清单，重试不会重复安装", async () => {
  const ctx = await updateFixture();
  try {
    const plan = await ctx.service.prepare(ctx.projectId, ctx.requestId);
    ctx.installError = true;
    await assert.rejects(ctx.service.approve(ctx.projectId, ctx.requestId, plan.request.plan.fingerprint), /install failed/);
    const failed = await ctx.service.get(ctx.projectId);
    assert.equal(failed.request.status, "failed");
    assert.equal(failed.request.plan, undefined);
    assert.equal(failed.packages.length, 3);
    assert.equal(failed.environment.revision, 2);
    ctx.installError = false;
    const retry = await ctx.service.prepare(ctx.projectId, ctx.requestId);
    assert.equal(retry.request.status, "pending");
    assert.deepEqual(retry.request.changes, []);
    await ctx.service.approve(ctx.projectId, ctx.requestId, retry.request.plan.fingerprint);
    assert.equal(ctx.installs, 1);
  } finally { await ctx.cleanup(); }
});

test("兼容性检查失败保留实际修订，重试通过检查而非重复安装", async () => {
  const ctx = await updateFixture();
  try {
    const plan = await ctx.service.prepare(ctx.projectId, ctx.requestId);
    ctx.checkError = true;
    await assert.rejects(ctx.service.approve(ctx.projectId, ctx.requestId, plan.request.plan.fingerprint), /dependency conflict/);
    const failed = await ctx.service.get(ctx.projectId);
    assert.equal(failed.environment.revision, 2);
    assert.equal(failed.request.status, "failed");
    assert.equal(failed.request.plan, undefined);
    ctx.checkError = false;
    const retry = await ctx.service.prepare(ctx.projectId, ctx.requestId);
    await ctx.service.approve(ctx.projectId, ctx.requestId, retry.request.plan.fingerprint);
    assert.equal(ctx.installs, 1);
    assert.equal(ctx.checks, 2);
    assert.equal((await ctx.service.get(ctx.projectId)).environment.revision, 2);
  } finally { await ctx.cleanup(); }
});

test("重启恢复中断的安装时作废旧计划并允许同步重新解析", async () => {
  const ctx = await updateFixture();
  try {
    await ctx.service.prepare(ctx.projectId, ctx.requestId);
    const entry = await ctx.service.entry(ctx.projectId);
    entry.operation = "update"; entry.requests[0].status = "installing";
    await ctx.service.persist(entry);
    ctx.packages.push({ name: "skillopt", version: "0.2.0", channel: "pypi" });
    const resumed = new ProjectEnvironmentService(ctx.options);
    const recovered = await resumed.get(ctx.projectId);
    assert.equal(recovered.request.status, "failed");
    assert.equal(recovered.request.plan, undefined);
    assert.match(recovered.error, /部分依赖可能已安装/);
    const retry = await resumed.prepare(ctx.projectId, ctx.requestId);
    assert.equal(retry.environment.revision, 2);
    assert.equal(retry.error, "");
    assert.deepEqual(retry.request.changes, []);
    assert.equal(ctx.installs, 0);
  } finally { await ctx.cleanup(); }
});

test("validates dependency requests as package specifications, not shell input", () => {
  assert.deepEqual(validatePackages(["numpy>=1.25,<2", "anthropic", "numpy>=1.25,<2"], "pip"), ["numpy>=1.25,<2", "anthropic"]);
  assert.deepEqual(validatePackages(["pytorch=2.5"], "conda"), ["pytorch=2.5"]);
  assert.throws(() => validatePackages(["https://example.com/package.whl"], "pip"), /依赖只接受包名/);
  assert.throws(() => validatePackages(["numpy; Remove-Item *"], "pip"), /依赖只接受包名/);
  assert.throws(() => validatePackages(["python=3.11"], "conda"), /依赖只接受包名/);
});

test("collects a dependency request from the supplied experiment workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-env-request-"));
  const projectId = randomUUID();
  const workspace = join(root, "experiment", "workspace");
  const requestId = randomUUID();
  const service = new ProjectEnvironmentService({
    dataRoot: () => root,
    project: async () => ({ title: "RSI" }),
    experiments: async () => [],
    env: { PATH: "" },
    platform: "win32",
    run: async () => { throw new Error("Conda must not run in this test"); },
  });
  try {
    const directory = join(workspace, ".ar", "environment-requests");
    await mkdir(directory, { recursive: true });
    const requestPath = join(directory, `${requestId}.json`);
    await writeFile(requestPath, JSON.stringify({ id: requestId, manager: "pip", packages: ["skillopt==0.2.0"], note: "" }));
    await service.collect(projectId, { id: "exp_002", title: "SkillOpt 复现" }, workspace);
    const snapshot = await service.get(projectId);
    assert.equal(snapshot.request.id, requestId);
    assert.equal(snapshot.request.experimentId, "exp_002");
    assert.equal(snapshot.request.packages[0], "skillopt==0.2.0");
    assert.equal(JSON.parse(await readFile(`${requestPath}.received`, "utf8")).id, requestId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency approval and rejection notices return to the requesting conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-env-conversation-"));
  const projectId = randomUUID();
  const conversationId = "conv_secondary123";
  const workspace = join(root, "experiment", "workspace");
  const requestDirectory = join(workspace, ".ar", "environment-requests");
  const helper = join(workspace, ".ar", "environment.mjs");
  const notices = [];
  const service = new ProjectEnvironmentService({
    dataRoot: () => root,
    project: async () => ({ title: "RSI" }),
    env: { PATH: "" },
    notify: async (...args) => notices.push(args),
    run: async () => { throw new Error("Conda must not run in this test"); },
  });
  try {
    await mkdir(requestDirectory, { recursive: true });
    await writeFile(helper, await readFile(new URL("./environments/request-helper.mjs", import.meta.url), "utf8"));
    execFileSync(process.execPath, [helper, "--manager", "pip", "--", "numpy>=1.25"], {
      env: { ...process.env, AUTORESEARCH_CONVERSATION_ID: conversationId },
    });
    await service.collect(projectId, { id: "exp_002", title: "SkillOpt" }, workspace);
    const snapshot = await service.get(projectId);
    assert.equal(snapshot.request.conversationId, conversationId);
    await service.reject(projectId, snapshot.request.id);
    assert.equal(notices[0][1], "exp_002");
    assert.equal(notices[0][3], false);
    assert.equal(notices[0][4], conversationId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routes Python commands through the project prefix and removes inherited environment overrides", () => {
  const prefix = "C:\\research\\Environments\\rsi-id\\conda";
  const result = environmentVariables({ Path: "C:\\Windows\\System32", PYTHONPATH: "C:\\other", CONDA_PREFIX: "C:\\base", CONDA_SHLVL: "3" }, { prefix }, "win32");
  assert.equal(result.PATH.split(";")[0], prefix);
  assert.equal(result.CONDA_PREFIX, prefix);
  assert.equal(result.CONDA_SHLVL, "1");
  assert.equal(result.PYTHONPATH, undefined);
  assert.equal(result.Path, undefined);
  assert.equal(result.PYTHONUTF8, "1");
  assert.equal(result.PYTHONIOENCODING, "utf-8");
});

test("UTF-8 defaults apply without a Conda binding and normalize case without mutating the source", () => {
  const source = { Path: "original-path", PythonUtf8: "0", pythonioencoding: "gbk", EXTRA: "keep" };
  const result = environmentVariables(source, null, "win32");
  assert.deepEqual(result, { Path: "original-path", EXTRA: "keep", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
  assert.equal(source.PythonUtf8, "0");
  assert.equal(source.pythonioencoding, "gbk");
});

test("creates one mocked Conda prefix per project and rejects cross-project sharing", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-project-env-"));
  const projectId = randomUUID();
  const secondProjectId = randomUUID();
  const condaRoot = join(root, "miniconda3");
  const condaExecutable = join(condaRoot, "Scripts", "conda.exe");
  const calls = [];
  await mkdir(dirname(condaExecutable), { recursive: true });
  await writeFile(condaExecutable, "test stub");
  await mkdir(condaRoot, { recursive: true });
  const run = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === "info") return JSON.stringify({ root_prefix: condaRoot });
    if (args[0] === "env") return JSON.stringify({ envs: [condaRoot] });
    if (args[0] === "create") {
      const prefix = args[args.indexOf("--prefix") + 1];
      await mkdir(join(prefix, "conda-meta"), { recursive: true });
      await writeFile(join(prefix, "conda-meta", "history"), "mock environment");
      return "{}";
    }
    if (args[0] === "-I" && args[1] === "-c") return JSON.stringify({ prefix: dirname(file), version: "3.11.9", architecture: "64bit" });
    if (args[0] === "list" && args.includes("--json")) return JSON.stringify([
      { name: "python", version: "3.11.9", channel: "defaults", build_string: "h123" },
      { name: "pip", version: "24.3.1", channel: "pypi", build_string: "pypi_0" },
    ]);
    throw new Error(`Unexpected mocked Conda call: ${args.join(" ")}`);
  };
  const service = new ProjectEnvironmentService({
    dataRoot: () => root,
    project: async (id) => ({ title: id === projectId ? "RSI" : "Another project" }),
    experiments: async () => [],
    env: { USERPROFILE: root, PATH: "" },
    platform: "win32",
    run,
  });

  try {
    const result = await service.create(projectId, { name: "ar-rsi", pythonVersion: "3.11", condaExecutable });
    const prefix = await realpath(join(root, "Environments", projectId, "conda"));
    assert.equal(result.environment.prefix, prefix);
    assert.equal(result.environment.pythonVersion, "3.11.9");
    assert.deepEqual(result.packages.map((item) => item.name), ["pip", "python"]);
    assert.equal(calls.filter((call) => call.args[0] === "create").length, 1);
    assert.equal(JSON.parse(await readFile(join(root, "Environments", projectId, "environment.json"), "utf8")).environment.prefix, prefix);
    await assert.rejects(service.create(projectId, { name: "second", pythonVersion: "3.11", condaExecutable }), /课题已绑定环境/);
    await assert.rejects(service.bind(secondProjectId, { name: "shared", prefix, condaExecutable }), /已绑定另一个课题/);
    assert.equal(calls.filter((call) => call.args[0] === "create").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires a configured project environment for execution and locks mutations while leased", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoresearch-env-lock-"));
  const projectId = randomUUID();
  const service = new ProjectEnvironmentService({
    dataRoot: () => root,
    project: async () => ({ title: "RSI" }),
    experiments: async () => [],
    env: { PATH: "" },
    platform: "win32",
    run: async () => { throw new Error("Conda must not run in this test"); },
  });
  try {
    await assert.rejects(service.acquire(projectId, true), /请先在“运行环境”/);
    const lease = await service.acquire(projectId, false);
    try {
      await assert.rejects(service.create(projectId, { name: "ar-rsi", pythonVersion: "3.11", condaExecutable: "" }), /正在使用这个环境/);
    } finally {
      lease.release();
    }
    await assert.rejects(service.acquire(projectId, true), /请先在“运行环境”/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
