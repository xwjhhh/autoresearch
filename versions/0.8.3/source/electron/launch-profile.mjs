import { isAbsolute, resolve } from "node:path";

export function parseLaunchProfile(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    if (index < 0) return null;
    const value = argv[index + 1];
    if (!value || !isAbsolute(value)) throw new Error(`${name} 需要绝对目录路径。`);
    return resolve(value);
  };
  const profile = option("--profile");
  const data = option("--data-dir");
  if (data && !profile) throw new Error("--data-dir 需要同时指定 --profile。");
  return { profile, data, preview: argv.includes("--iteration-preview") };
}
