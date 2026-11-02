import { access, cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceItems = [
  "src", "electron", "assets", "dist", "scripts", ".autoresearch-root", ".gitignore", "AGENTS.md",
  "index.html", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "README.md", "交付报告.md", "versions/README.md",
];
const exists = async (path) => {
  try { await access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};

async function filesUnder(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Source symlinks are not allowed: ${join(directory, relative, entry.name)}`);
    const path = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(directory, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function verifyBuild(root, stagingDirectory, version) {
  const installerName = `AutoResearch-${version}-Windows-Setup.exe`;
  const bytes = await readFile(join(stagingDirectory, installerName));
  if (!bytes.length) throw new Error("Windows installer is empty.");
  const asar = createRequire(import.meta.url)("@electron/asar");
  const archive = join(stagingDirectory, "win-unpacked", "resources", "app.asar");
  const application = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  if (application.version !== version) throw new Error(`Packaged version ${application.version} does not match ${version}.`);
  const roots = new Set(asar.listPackage(archive).map((path) => path.replaceAll("\\", "/").replace(/^\//, "").split("/")[0]));
  if ([...roots].some((name) => !["node_modules", "assets", "dist", "electron", "package.json"].includes(name))) {
    throw new Error("Unexpected files in application archive; refusing to publish possible research data.");
  }
  const verified = [];
  for (const directory of ["electron", "dist", "assets"]) {
    if (!(await exists(join(root, directory)))) continue;
    for (const file of await filesUnder(join(root, directory))) {
      const relative = join(directory, file);
      if (!asar.extractFile(archive, relative).equals(await readFile(join(root, relative)))) throw new Error(`Packaged file differs from current source: ${relative}`);
      verified.push(relative.replaceAll("\\", "/"));
    }
  }
  return { filename: installerName, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), verified };
}

export async function archiveVersion({ root = projectRoot, replaceExisting = false, checkOnly = false } = {}) {
  root = resolve(root);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const version = packageJson.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid application version: ${version}`);
  if (packageLock.version !== version || packageLock.packages?.[""]?.version !== version) throw new Error("package.json and package-lock.json must use the same application version.");
  const versionsDirectory = join(root, "versions");
  const archiveDirectory = join(versionsDirectory, version);
  const buildDirectory = join(versionsDirectory, ".build");
  const stagingDirectory = join(buildDirectory, "windows");
  if (packageJson.build?.directories?.output !== "versions/.build/windows") throw new Error("Windows output must be versions/.build/windows; refusing a scattered release.");
  if (await exists(archiveDirectory) && !replaceExisting) throw new Error(`Version ${version} already exists. For an authorized same-version rebuild, use npm run dist:win:replace; history will be preserved.`);
  if (checkOnly) return { version, stagingDirectory, archiveDirectory };
  await mkdir(buildDirectory, { recursive: true });
  const lockPath = join(buildDirectory, "archive.lock");
  const lock = await open(lockPath, "wx").catch((error) => {
    if (error.code === "EEXIST") throw new Error(`Another archive operation may be active: ${lockPath}`);
    throw error;
  });
  let temporaryDirectory;
  let committed = false;
  const moved = [];
  const move = async (from, to) => { await rename(from, to); moved.push({ from, to }); };
  try {
    const verification = await verifyBuild(root, stagingDirectory, version);
    temporaryDirectory = await mkdtemp(join(buildDirectory, `archive-${version}-`));
    const sourceDirectory = join(temporaryDirectory, "source");
    await mkdir(sourceDirectory);
    for (const item of sourceItems) if (await exists(join(root, item))) await cp(join(root, item), join(sourceDirectory, item), { recursive: true, dereference: false });
    if (await exists(join(archiveDirectory, "docs"))) await cp(join(archiveDirectory, "docs"), join(temporaryDirectory, "docs"), { recursive: true });
    await move(stagingDirectory, join(temporaryDirectory, "windows"));
    const archivedAt = new Date().toISOString();
    let previousBuild;
    let previousArchiveDirectory;
    if (await exists(archiveDirectory)) {
      // Carry shared packages and flat history forward without copying old builds.
      for (const folder of ["history", "packages"]) {
        if (await exists(join(archiveDirectory, folder))) await move(join(archiveDirectory, folder), join(temporaryDirectory, folder));
      }
      await mkdir(join(temporaryDirectory, "history"), { recursive: true });
      previousBuild = `history/${archivedAt.replace(/[:.]/g, "-")}-previous`;
      previousArchiveDirectory = join(buildDirectory, `previous-${version}-${archivedAt.replace(/[:.]/g, "-")}`);
      await move(archiveDirectory, previousArchiveDirectory);
    }
    const metadata = { version, archivedAt, sourceAvailable: true, source: "source/", windowsApplication: "windows/", installer: { ...verification, path: `windows/${verification.filename}` }, ...(previousBuild ? { previousBuild } : {}) };
    await writeFile(join(temporaryDirectory, "version.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await writeFile(join(temporaryDirectory, "windows", "verification.json"), `${JSON.stringify({ version, installer: join(archiveDirectory, "windows", verification.filename), ...verification }, null, 2)}\n`, "utf8");
    await move(temporaryDirectory, archiveDirectory);
    if (previousArchiveDirectory) await move(previousArchiveDirectory, join(archiveDirectory, previousBuild));
    committed = true;
    const latest = { version, archivedAt, directory: `${version}/`, installer: `${version}/windows/${verification.filename}`, sha256: verification.sha256 };
    const latestTemporary = join(buildDirectory, "latest.json.tmp");
    await writeFile(latestTemporary, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
    await rename(latestTemporary, join(versionsDirectory, "latest.json"));
    return { ...metadata, archiveDirectory };
  } catch (error) {
    if (!committed) {
      const rollbackErrors = [];
      for (const { from, to } of moved.reverse()) {
        try { await rename(to, from); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], `Archive rollback incomplete; preserve ${temporaryDirectory} for recovery.`);
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checkOnly = process.argv.includes("--check");
  const result = await archiveVersion({ replaceExisting: process.argv.includes("--replace-existing"), checkOnly });
  process.stdout.write(`${checkOnly ? "Release layout checked" : "Archived"} AutoResearch ${result.version}: ${result.archiveDirectory}\n`);
}
