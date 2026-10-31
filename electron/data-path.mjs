import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function resolveDefaultDataRoot({ isDev, sourceDirectory, executablePath, documentsPath, envPath }) {
  if (envPath) return resolve(envPath);
  if (isDev) return join(resolve(sourceDirectory, ".."), "data");

  let current = dirname(resolve(executablePath));
  while (true) {
    if (existsSync(join(current, ".autoresearch-root"))) return join(current, "data");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return join(documentsPath, "AutoResearch");
}
