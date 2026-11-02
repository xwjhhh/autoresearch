import { delimiter, join } from "node:path";

export function environmentVariables(source, environment, platform = process.platform) {
  const env = { ...source };
  // Python on Windows otherwise inherits the legacy console encoding (e.g. GBK).
  // Use the same encoding for SDK tools and background jobs, including paper text.
  for (const key of Object.keys(env)) {
    if (/^(?:pythonutf8|pythonioencoding)$/i.test(key)) delete env[key];
  }
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  if (!environment) return env;
  for (const key of Object.keys(env)) {
    if (/^(?:path|pythonhome|pythonpath|virtual_env|conda_prefix(?:_\d+)?|conda_default_env|conda_shlvl)$/i.test(key)) delete env[key];
  }
  const path = Object.entries(source).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  const prefix = environment.prefix;
  const paths = platform === "win32"
    ? [prefix, join(prefix, "Scripts"), join(prefix, "Library", "bin"), join(prefix, "Library", "usr", "bin")]
    : [join(prefix, "bin")];
  env.PATH = [...paths, path].join(platform === "win32" ? ";" : delimiter);
  env.CONDA_PREFIX = prefix;
  env.CONDA_DEFAULT_ENV = prefix;
  env.CONDA_SHLVL = "1";
  env.PYTHONNOUSERSITE = "1";
  return env;
}

export function environmentPrompt(environment) {
  return [
    "[平台课题环境约束：优先于旧版 AGENTS.md 中关于新建 .venv 的建议]",
    environment ? `本课题唯一共享 Conda 环境：${environment.name}。prefix=${JSON.stringify(environment.prefix)}；Python ${environment.pythonVersion}。`
      : "本课题尚未绑定 Conda 环境。可以阅读代码和论文；运行 Python 前请研究者到“运行环境”创建或绑定。",
    environment ? `Python 已加入 PATH；可直接使用 python。需要 Conda 激活脚本时用 ${JSON.stringify(environment.condaExecutable)} run --no-capture-output --prefix ${JSON.stringify(environment.prefix)} <命令>。` : "",
    "不要创建 .venv、venv、新 Conda 环境，不要使用 base、其他实验环境或 python -m venv。不要直接 pip/conda/uv 安装、升级、卸载共享依赖。",
    "缺包时使用 node .ar/environment.mjs --manager pip -- anthropic psutil（或 --manager conda -- 包名）提交依赖申请，然后结束本轮等待研究者确认。可附 --note \"原因\"。支持包名与版本约束；不接受 URL、本地文件、安装参数或 requirements 文件。复杂依赖先向研究者说明。",
    "环境变更申请独立于后台任务审批开关，始终需要研究者批准。不要用 .ar/run.mjs 绕过依赖审批。依赖版本冲突时报告冲突，不另建环境。",
    "最新环境说明在平台数据目录 Environments/<project-id>/environment.json；它由平台维护。代码、数据、缓存和输出仍保存在本实验工作目录。",
  ].filter(Boolean).join("\n");
}
