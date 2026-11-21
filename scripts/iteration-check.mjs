import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptanceFiles, npmCommand, unitTestFiles } from "../electron/iteration-runtime.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const target = args.find((value) => !value.startsWith("--"))?.replaceAll("\\", "/").replace(/\/$/, "");
if (!/^tests\/acceptance\/iter-\d+$/.test(target ?? "")) {
  console.error("用法：node scripts/iteration-check.mjs tests/acceptance/iter-N [--expect-fail] [--skip-build] [--all]");
  process.exit(2);
}

const files = (await acceptanceFiles(join(cwd, target))).map((name) => `${target}/${name}`);
const unit = files.filter((name) => name.endsWith(".test.mjs"));
const specs = files.filter((name) => !name.endsWith(".test.mjs"));
if (!files.length) {
  console.error(`${target} 下没有测试文件（需要 .test.mjs、.spec.mjs 或 .spec.ts）。`);
  process.exit(2);
}

const output = join(tmpdir(), `autoresearch-check-${createHash("sha256").update(cwd).digest("hex").slice(0, 10)}`);
const env = { ...process.env, AUTORESEARCH_E2E_HIDDEN: "1", AUTORESEARCH_E2E_OUTPUT: output };
delete env.ELECTRON_RUN_AS_NODE;

function run(name, file, list, capture = false) {
  console.log(`\n=== ${name} ===\n$ ${file} ${list.join(" ")}`);
  const started = Date.now();
  const result = spawnSync(file, list, { cwd, env, stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (capture && result.stdout) process.stdout.write(result.stdout);
  const ok = result.status === 0;
  console.log(`--- ${name}：${ok ? "通过" : `失败（${result.error?.message ?? result.status}）`}，${((Date.now() - started) / 1000).toFixed(1)}s`);
  return capture ? result : ok;
}

function unitAssertionFailures(output) {
  const failures = [...output.matchAll(/^\s*failureType: .+$/gm)];
  const assertions = [...output.matchAll(/^\s*code: ['"]ERR_ASSERTION['"]\s*$/gm)];
  return failures.length > 0 && failures.length === assertions.length;
}

function sceneAssertionFailures(output) {
  let report;
  try { report = JSON.parse(output); } catch { return false; }
  const errors = [];
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        if (test.status === "unexpected") errors.push(...test.results.flatMap((result) => result.errors ?? []));
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return !report.errors?.length && report.stats?.unexpected > 0 && errors.length > 0
    && errors.every(({ message }) => /expect\(/.test(message ?? ""));
}

async function screenshots() {
  const names = await readdir(output, { recursive: true }).catch(() => []);
  return names.filter((name) => name.endsWith(".png")).map((name) => join(output, name));
}

const playwright = ["node_modules/playwright/cli.js", "test", "--config", "playwright.config.mjs"];
const results = [];
const needsTooling = !flag("--expect-fail") || specs.length > 0;
if (needsTooling && !await lstat(join(cwd, "node_modules", "electron", "dist", "version")).catch(() => null)) {
  if (!run("安装依赖", ...npmCommand(["ci", "--prefer-offline"]))) process.exit(1);
}

if (flag("--expect-fail")) {
  if (specs.length && !flag("--skip-build")) results.push(["构建", run("构建", ...npmCommand(["run", "build"]))]);
  if (results.some(([, ok]) => !ok)) {
    console.log("\n构建失败，无法判断验收测试。先修好构建（验收阶段不能改代码时，说明基线本身有问题，请在总结里说明）。");
    process.exit(1);
  }
  const checks = [];
  if (unit.length) checks.push(["验收单元测试", ["--test", "--test-reporter=tap", ...unit], unitAssertionFailures]);
  if (specs.length) checks.push(["验收场景测试", [...playwright, "--reporter=json", `${target}/`], sceneAssertionFailures]);
  let failedAssertions = false;
  for (const [name, args, isAssertionFailure] of checks) {
    const { error, status, stdout } = run(name, process.execPath, args, true);
    if (status === 0) continue;
    if (error || status !== 1 || !isAssertionFailure(stdout ?? "")) {
      console.error(`\n${name}存在非断言失败，无法确认基线。请检查上方输出。`);
      process.exit(1);
    }
    failedAssertions = true;
  }
  console.log("\n=== 结论 ===");
  if (!failedAssertions) {
    console.log("✗ 新测试在实现前就全部通过了。请检查测试是否覆盖了新需求。");
    process.exit(1);
  }
  console.log("✓ 新测试在实现前会失败。请再看一遍上面的失败原因：应是断言不成立（功能还没做），而不是语法错误、导入失败或选择器写错。");
  for (const file of await screenshots()) console.log(`截图：${file}`);
  process.exit(0);
}

const steps = [
  ["全部单元测试（含历次验收）", process.execPath, ["--test", ...await unitTestFiles(cwd)]],
  ...(flag("--skip-build") ? [] : [["构建", ...npmCommand(["run", "build"])]]),
  ...(flag("--all") ? [["全部场景测试（含历次验收）", process.execPath, playwright]] : specs.length ? [["本任务验收场景", process.execPath, [...playwright, `${target}/`]]] : []),
];
for (const [name, file, list] of steps) {
  const ok = run(name, file, list);
  results.push([name, ok]);
  if (!ok) break;
}
console.log("\n=== 结论 ===");
for (const [name, ok] of results) console.log(`${ok ? "✓" : "✗"} ${name}`);
const failed = results.some(([, ok]) => !ok) || results.length < steps.length;
const shots = await screenshots();
if (shots.length) console.log(`\n场景截图（改了界面就打开看看）：\n${shots.join("\n")}`);
console.log(failed ? "\n未通过，修复后重跑。" : `\n快速自检通过。${flag("--all") ? "" : "平台还会跑全部场景测试（含历次验收）；如改动可能影响其他页面，可加 --all 先自己跑一遍。"}`);
process.exit(failed ? 1 : 0);
