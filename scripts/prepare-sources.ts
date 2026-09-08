import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const sourceNames = ["remix", "reshade", "bridge", "fixes"];
const verifyOnly = Bun.argv.slice(2).includes("--verify-only");
const disabledFilters = new Set<string>();

interface IndexEntry {
  mode: string;
  hash: string;
}

interface SourceModule {
  path: string;
  hash: string;
}

interface PatchFile {
  path: string;
  before: string | null;
  after: string;
}

interface SourcePatch {
  path: string;
  files: PatchFile[];
}

type SourceState = "missing" | "pristine" | "patched";

function git(cwd: string, args: string[], allowedExitCodes = [0]): string {
  const filterOptions = [...disabledFilters].flatMap((name) => [
    "-c", `${name}.clean=`, "-c", `${name}.process=`, "-c", `${name}.required=false`,
  ]);
  const result = Bun.spawnSync(["git", "-c", "core.fsmonitor=false", ...filterOptions, "-C", cwd, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!allowedExitCodes.includes(result.exitCode)) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function disableExternalFilters(cwd: string): void {
  // External clean/process filters may write files or use the network. Git's
  // built-in line-ending normalization remains enabled for blob verification.
  for (const key of git(cwd, ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"], [0, 1]).split("\n").filter(Boolean)) {
    disabledFilters.add(key.trim().replace(/\.(clean|process)$/, ""));
  }
}

function readIndex(cwd: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const record of git(cwd, ["ls-files", "--stage", "-v", "-z"]).split("\0").filter(Boolean)) {
    const match = /^H (\d{6}) ([a-f0-9]{40}) (\d)\t(.+)$/.exec(record);
    if (!match || match[3] !== "0") {
      throw new Error(`Unmerged or hidden index entry (assume-unchanged/skip-worktree) in ${cwd}: ${record}`);
    }
    entries.set(match[4], { mode: match[1], hash: match[2] });
  }
  return entries;
}

function checkPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes(":") ||
      path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) {
    throw new Error(`Unsupported repository-relative path: ${path}`);
  }
}

function readModules(cwd: string, index: Map<string, IndexEntry>): SourceModule[] {
  const links = new Map([...index].filter(([, entry]) => entry.mode === "160000"));
  if (links.size === 0) return [];
  const declarations = git(cwd, [
    "config", "--file", ".gitmodules", "--null", "--get-regexp", "^submodule\\..*\\.path$",
  ]).split("\0").filter(Boolean);
  const modules: SourceModule[] = [];
  for (const declaration of declarations) {
    const newline = declaration.indexOf("\n");
    const key = declaration.slice(0, newline).replace(/\.path$/, "");
    const path = declaration.slice(newline + 1);
    checkPath(path);
    const link = links.get(path);
    if (!link) throw new Error(`No unique pinned gitlink for ${cwd}/${path}`);
    const url = git(cwd, ["config", "--file", ".gitmodules", "--get", `${key}.url`]).trim();
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(url)) {
      throw new Error(`Expected a public GitHub HTTPS submodule URL for ${cwd}/${path}: ${url}`);
    }
    const override = git(cwd, ["config", "--local", "--get", `${key}.url`], [0, 1]).trim();
    if (override && override !== url) {
      throw new Error(`Submodule URL override differs from .gitmodules for ${cwd}/${path}: ${override}`);
    }
    modules.push({ path, hash: link.hash });
    links.delete(path);
  }
  if (links.size) throw new Error(`Gitlinks missing from ${cwd}/.gitmodules: ${[...links.keys()].join(", ")}`);
  return modules;
}

function readPatch(name: string): SourcePatch | undefined {
  if (name === "fixes") return undefined;
  const path = resolve(root, "patches", `${name}.patch`);
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const sections = text.split(/^diff --git /m);
  if (sections.shift() !== "" || sections.length === 0) throw new Error(`Invalid patch: ${path}`);
  const files = sections.map((section): PatchFile => {
    const nameMatch = /^a\/(\S+) b\/\1\n/.exec(section);
    const hashes = /^index ([a-f0-9]{40})\.\.([a-f0-9]{40})(?: 100644)?$/m.exec(section);
    if (!nameMatch || !hashes || /^(?:old mode|new mode|deleted file mode|rename |copy |GIT binary patch|Binary files)/m.test(section)) {
      throw new Error(`Unsupported patch record in ${path}; expected full-index text additions or modifications.`);
    }
    checkPath(nameMatch[1]);
    const before = /^0+$/.test(hashes[1]) ? null : hashes[1];
    if (/^0+$/.test(hashes[2]) || hashes[1] === hashes[2] ||
        (before === null) !== /^new file mode 100644$/m.test(section)) {
      throw new Error(`Invalid patch hashes or file mode for ${nameMatch[1]} in ${path}`);
    }
    return { path: nameMatch[1], before, after: hashes[2] };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error(`Duplicate file records in ${path}`);
  }
  return { path, files };
}

function inspect(cwd: string, expectedHash: string, patch: SourcePatch | undefined, allowMissing: boolean): {
  state: SourceState;
  missing: boolean;
  nestedCount: number;
} {
  if (!existsSync(resolve(cwd, ".git"))) {
    if (existsSync(cwd) && readdirSync(cwd).length) throw new Error(`Uninitialized source directory is not empty: ${cwd}`);
    if (!allowMissing) throw new Error(`Submodule is not initialized: ${cwd}`);
    return { state: "missing", missing: true, nestedCount: 0 };
  }
  disableExternalFilters(cwd);
  // Refuse partial clones before reading objects, even on older Git versions that
  // do not honor GIT_NO_LAZY_FETCH. Verification must never download missing blobs.
  if (git(cwd, ["config", "--local", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor)$"], [0, 1]).trim()) {
    throw new Error(`Partial/promisor clones are unsupported for offline verification: ${cwd}`);
  }
  if (resolve(git(cwd, ["rev-parse", "--show-toplevel"]).trim()) !== resolve(cwd)) {
    throw new Error(`Submodule resolves to a different working tree: ${cwd}`);
  }
  const head = git(cwd, ["rev-parse", "HEAD"]).trim();
  if (head !== expectedHash) throw new Error(`Unexpected HEAD in ${cwd}: ${head}; pinned ${expectedHash}. No checkout was changed.`);
  if (git(cwd, ["diff", "--cached", "--name-only", "-z", "--ignore-submodules=none", "HEAD"])) {
    throw new Error(`Staged source changes are not supported: ${cwd}`);
  }
  const index = readIndex(cwd);
  const expectedFiles = new Set(patch?.files.map((file) => file.path));
  for (const record of git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]).split("\0").filter(Boolean)) {
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!expectedFiles.has(path) || (status !== " M" && status !== "??")) {
      throw new Error(`Unexpected source change in ${cwd}: ${record}`);
    }
  }

  let state: SourceState = "pristine";
  if (patch) {
    const fileStates = patch.files.map((file): SourceState => {
      const entry = index.get(file.path);
      if ((file.before === null && entry) || (file.before !== null &&
          (!entry || entry.hash !== file.before || entry.mode !== "100644"))) {
        throw new Error(`Patch base does not match pinned source: ${cwd}/${file.path}`);
      }
      const path = resolve(cwd, file.path);
      if (!existsSync(path)) {
        if (file.before === null) return "pristine";
        throw new Error(`Patched source file is missing: ${path}`);
      }
      if (!lstatSync(path).isFile()) throw new Error(`Expected a regular source file: ${path}`);
      const hash = git(cwd, ["hash-object", `--path=${file.path}`, "--", file.path]).trim();
      if (hash === file.after) return "patched";
      if (hash === file.before) return "pristine";
      throw new Error(`Source content differs from both pinned source and expected patch: ${path}`);
    });
    if (new Set(fileStates).size !== 1) throw new Error(`Patch is only partially applied: ${cwd}`);
    state = fileStates[0];
    git(cwd, ["apply", ...(state === "patched" ? ["--reverse"] : []), "--check", patch.path]);
  }

  let missing = false;
  let nestedCount = 0;
  for (const child of readModules(cwd, index)) {
    const result = inspect(resolve(cwd, child.path), child.hash, undefined, allowMissing);
    missing ||= result.missing;
    nestedCount += result.nestedCount + 1;
  }
  return { state, missing, nestedCount };
}

function main(): void {
  if (Bun.argv.slice(2).some((arg) => arg !== "--verify-only")) {
    throw new Error("Usage: bun scripts/prepare-sources.ts [--verify-only]");
  }
  // The index is authoritative, including before the project has its first commit.
  disableExternalFilters(root);
  const modules = readModules(root, readIndex(root));
  const expectedPaths = new Set(sourceNames.map((name) => `sources/${name}`));
  if (modules.length !== expectedPaths.size || modules.some((module) => !expectedPaths.has(module.path))) {
    throw new Error("Expected exactly four pinned root submodules: remix, reshade, bridge, fixes.");
  }
  const sources = modules.map((module) => ({
    ...module,
    cwd: resolve(root, module.path),
    patch: readPatch(module.path.slice("sources/".length)),
  }));

  // Inspect every existing checkout before any network or working-tree mutation.
  let verified = sources.map((source) => inspect(source.cwd, source.hash, source.patch, !verifyOnly));
  if (!verifyOnly) {
    if (verified.some((result) => result.missing)) {
      console.log("Initializing pinned public source submodules...");
      git(root, ["submodule", "update", "--init", "--recursive", "--checkout", "--jobs", "4", "--", ...sources.map((source) => source.path)]);
      // Recheck after cloning before applying any patch.
      verified = sources.map((source) => inspect(source.cwd, source.hash, source.patch, false));
    }
    let applied = false;
    sources.forEach((source, i) => {
      if (source.patch && verified[i].state === "pristine") {
        git(source.cwd, ["apply", source.patch.path]);
        console.log(`Applied ${source.path} patch.`);
        applied = true;
      }
    });
    if (applied) verified = sources.map((source) => inspect(source.cwd, source.hash, source.patch, false));
  }

  sources.forEach((source, i) => {
    const result = verified[i];
    if (source.patch && result.state !== "patched") throw new Error(`Expected patch is not applied: ${source.path}`);
    console.log(`${source.path}: ${source.hash}, ${source.patch ? `${source.patch.files.length} exact patched files` : "clean"}, ${result.nestedCount} nested submodules verified.`);
  });
  console.log(verifyOnly ? "Source verification passed (read-only, offline)." : "Pinned sources are ready.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
