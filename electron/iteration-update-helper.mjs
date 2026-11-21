import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runCommand } from "./iteration-github.mjs";
import { applyLocalUpdate, restoreLocalUpdate } from "./iteration-update.mjs";

const folder = fileURLToPath(new URL(".", import.meta.url));
const request = JSON.parse(await readFile(join(folder, "request.json"), "utf8"));
const git = (cwd, ...args) => runCommand("git", ["-c", "core.longpaths=true", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args], { cwd }).then((result) => result.trimEnd());

async function waitForAppExit(pid) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(250);
  }
  throw new Error("等待 AutoResearch 退出超时，没有修改源码。 ");
}

async function result(value) {
  const file = join(folder, "result.tmp");
  await writeFile(file, JSON.stringify(value));
  await rename(file, join(folder, "result.json"));
}

let exited = false;
try {
  await waitForAppExit(request.pid);
  exited = true;
  await delay(1000);
  if (await git(request.binding.path, "rev-parse", "HEAD") !== request.current) throw new Error("退出前主线已变化，没有执行延迟更新。 ");
  const localUpdate = request.update
    ? (await restoreLocalUpdate({ ...request, git }), null)
    : await applyLocalUpdate({ ...request, git });
  await result({ ok: true, localUpdate });
} catch (error) {
  console.error(error);
  await result({ ok: false, error: error.message });
}

if (exited) {
  const child = spawn(request.restart.executable, request.restart.args, { cwd: request.binding.path, detached: true, stdio: "ignore" });
  try { await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); }
  catch (error) { console.error(error); }
  finally { child.unref(); }
}
