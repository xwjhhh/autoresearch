import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sdkPackageUrl = new URL("../node_modules/@openai/codex-sdk/", import.meta.url);
const sdkPackage = JSON.parse(readFileSync(new URL("package.json", sdkPackageUrl), "utf8"));
const entry = sdkPackage.exports?.["."]?.import ?? sdkPackage.module ?? sdkPackage.main;
if (typeof entry !== "string") throw new Error("Could not locate the Codex SDK JavaScript entry point.");
const sdkEntry = fileURLToPath(new URL(entry, sdkPackageUrl));
const source = readFileSync(sdkEntry, "utf8");
const patchedSpawnCall = /const child = spawn\(this\.executablePath, commandArgs, \{\s*env,\s*signal: args\.signal,\s*windowsHide: process\.platform === "win32"\s*\}\);/;
const spawnCall = /const child = spawn\(this\.executablePath, commandArgs, \{\s*env,\s*signal: args\.signal\s*\}\);/;

if (patchedSpawnCall.test(source)) {
  process.stdout.write("Codex SDK child window is already hidden.\n");
} else if (spawnCall.test(source)) {
  const patched = source.replace(spawnCall, `const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal,
      windowsHide: process.platform === "win32"
    });`);
  writeFileSync(sdkEntry, patched, "utf8");
  process.stdout.write("Patched Codex SDK to hide its Windows CLI window.\n");
} else {
  throw new Error("Could not safely patch the Codex SDK spawn call; inspect the installed SDK before continuing.");
}
