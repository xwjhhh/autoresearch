// 由 AutoResearch 主进程以 Node 方式在后台启动（ELECTRON_RUN_AS_NODE=1）。
// 运行一个后台任务：输出写进日志，开始和结束时写状态文件。它独立于应用进程，应用关闭后任务照常运行。
// 参数：任务说明文件路径（JSON：command、cwd、log、status）。
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const windows = process.platform === "win32";
const startedAt = new Date().toISOString();
const log = openSync(spec.log, "a");
let finished = false;

function status(value) {
  const temporary = `${spec.status}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), "utf8");
  renameSync(temporary, spec.status);
}

function finish(exitCode, signal = null, error = "") {
  if (finished) return;
  finished = true;
  const finishedAt = new Date().toISOString();
  try {
    writeSync(log, `\n[AutoResearch ${finishedAt}] 结束：退出码 ${exitCode}${signal ? `（信号 ${signal}）` : ""}${error ? `；${error}` : ""}\n`);
    closeSync(log);
  } catch { /* 日志写不进去不影响状态文件。 */ }
  status({ state: "finished", exitCode, signal, error, runnerPid: process.pid, startedAt, finishedAt });
  process.exit(0);
}

writeSync(log, `[AutoResearch ${startedAt}] 开始：${spec.command}\n[AutoResearch] 工作目录：${spec.cwd}\n\n`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const childEnv = env;

// Windows 上与 Codex 一致，用 PowerShell 执行；并把最后一个外部命令的退出码作为任务退出码。
const windowsScript = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "$OutputEncoding = [Console]::OutputEncoding",
  "$global:LASTEXITCODE = 0",
  "try {",
  spec.command,
  "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  "if (-not $?) { exit 1 }",
  "} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }",
].join("\n");
const [file, args] = windows
  ? ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(windowsScript, "utf16le").toString("base64")]]
  : ["/bin/sh", ["-c", spec.command]];

let child;
try {
  // 非 Windows 平台让任务自成进程组，停止时可以连同它启动的子进程一起结束。
  child = spawn(file, args, { cwd: spec.cwd, env: childEnv, stdio: ["ignore", log, log], windowsHide: true, detached: !windows });
} catch (error) {
  finish(-1, null, error instanceof Error ? error.message : String(error));
}

if (child) {
  status({ state: "running", pid: child.pid, runnerPid: process.pid, startedAt });
  child.on("error", (error) => finish(-1, null, error.message));
  child.on("exit", (code, signal) => finish(code ?? -1, signal));
}
