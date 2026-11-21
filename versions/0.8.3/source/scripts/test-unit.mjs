import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unitTestFiles } from "../electron/iteration-runtime.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, ["--test", ...await unitTestFiles(cwd)], { cwd, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
