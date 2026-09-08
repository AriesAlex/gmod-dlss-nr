import { cp, lstat, mkdir, readdir, realpath, rename, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { applyEnginePatches, planEnginePatches } from "./lib/engine-patches";
import artifacts from "../config/artifacts.json";

const root = resolve(import.meta.dir, "..");
const markerName = ".gmod-dlss-nr.json";
const baseConfigs: Record<string, string> = { "rtx.conf": "rtx.conf", "dxvk.conf": "dxvk.conf", "user.conf": "user.conf", "garrysmod/cfg/autoexec.cfg": "autoexec.cfg" };
const editableFiles = new Set([...Object.keys(baseConfigs), "bin/win64/ReShade.ini", "bin/win64/dlss5-bridge.cfg"]);
type Profile = "native" | "bridge";
interface Installation { schemaVersion: 1; source: string; hl2rtx: string; profile: Profile }

function within(path: string, parent: string) {
  const difference = relative(parent.toLowerCase(), path.toLowerCase());
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}

async function run(command: string[], env: Record<string, string> = {}) {
  const process = Bun.spawn(command, { cwd: root, env: { ...Bun.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} failed (${code}): ${errors.trim() || output.trim()}`);
  return output.trim();
}

async function powershell(script: string, env: Record<string, string> = {}) {
  return run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], env);
}

async function assertStopped(target: string) {
  const output = await powershell("$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='gmod.exe' OR Name='hl2.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress");
  const processes = output ? JSON.parse(output) : [];
  for (const process of Array.isArray(processes) ? processes : [processes]) {
    if (!process.ExecutablePath) throw new Error(`Cannot inspect game process ${process.ProcessId}. Close it before setup.`);
    if (within(await realpath(process.ExecutablePath), target)) throw new Error(`Target game is running (PID ${process.ProcessId}). Close it yourself before setup.`);
  }
}

async function hash(path: string) {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex").toUpperCase();
}

async function verifyPayload() {
  const manifest = await Bun.file(join(root, "config/payload-files.json")).json();
  for (const file of manifest.files) {
    const path = join(root, file.file);
    if ((await hash(path)) !== file.sha256.toUpperCase()) throw new Error(`Payload hash mismatch: ${file.file}`);
  }
}

// Refuse redirected destinations; only the intentionally shared Steam content uses links.
async function assertPhysicalDestination(path: string, target: string) {
  if (!within(path, target)) throw new Error(`Destination escapes target: ${path}`);
  for (let current = path; within(current, target); current = dirname(current)) {
    if (await exists(current) && (await lstat(current)).isSymbolicLink()) throw new Error(`Refusing to overwrite through a link: ${current}`);
    if (current === target) break;
  }
}

async function writeFile(path: string, data: Uint8Array | string, target: string) {
  await assertPhysicalDestination(path, target);
  const bytes = Buffer.from(data);
  if (await exists(path) && Buffer.from(await Bun.file(path).bytes()).equals(bytes)) return;
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, bytes);
}

async function overlay(source: string, destination: string, target: string) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".complete") continue;
    const input = join(source, entry.name), output = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected link in payload: ${input}`);
    if (entry.isDirectory()) await overlay(input, output, target);
    else {
      const targetPath = relative(target, output).replaceAll("\\", "/");
      if (targetPath in baseConfigs || editableFiles.has(targetPath) && await exists(output)) continue;
      await writeFile(output, await Bun.file(input).bytes(), target);
    }
  }
}

async function extract(id: string) {
  const artifact = artifacts.artifacts.find(item => item.id === id)!;
  const destination = join(root, ".cache", `${id}-${artifact.sha256.slice(0, 12)}`);
  if (!await exists(join(destination, ".complete"))) {
    if (await exists(destination)) throw new Error(`Incomplete extraction: ${destination}. Inspect and remove that cache directory, then retry.`);
    await mkdir(destination, { recursive: true });
    await powershell("$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:GMNR_ARCHIVE -DestinationPath $env:GMNR_EXTRACT", {
      GMNR_ARCHIVE: join(root, "payload/archives", artifact.file), GMNR_EXTRACT: destination,
    });
    await Bun.write(join(destination, ".complete"), artifact.sha256);
  }
  return join(destination, artifact.extract.stripPrefix);
}

async function prepareBase(source: string, target: string) {
  await cp(join(source, "bin"), join(target, "bin"), { recursive: true, dereference: true });
  for (const name of ["gmod.exe", "steam_appid.txt"]) {
    if (await exists(join(source, name))) await cp(join(source, name), join(target, name));
  }
  for (const name of ["platform", "sourceengine"]) await symlink(join(source, name), join(target, name), "junction");
  const game = join(target, "garrysmod"), original = join(source, "garrysmod");
  await mkdir(game, { recursive: true });
  for (const name of ["backgrounds", "fallbacks", "gamemodes", "html", "lua", "maps", "materials", "media", "particles", "resource", "scenes", "settings", "shaders", "videos"]) {
    if (await exists(join(original, name))) await cp(join(original, name), join(game, name), { recursive: true, dereference: true });
  }
  for (const entry of await readdir(original, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".vpk")) await symlink(join(original, entry.name), join(game, entry.name), "file");
    else if (["gameinfo.txt", "garrysmod.ver", "steam.inf", "detail.vbsp", "lights.rad"].includes(entry.name)) await cp(join(original, entry.name), join(game, entry.name));
  }
  for (const name of ["addons", "cfg", "data", "download", "cache"]) await mkdir(join(game, name), { recursive: true });
  await Bun.write(join(game, "cfg/mount.cfg"), '"mountcfg"\n{\n}\n');
}

function mergeSettings(base: string, settings: string) {
  const values = new Map<string, string>();
  for (const text of [base, settings]) for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match) values.set(match[1], match[2]);
  }
  return [...values].map(([key, value]) => `${key} = ${value}`).join("\n") + "\n";
}

async function mountTool(game: string, hl2rtx: string, fixes: string, mode: "--apply" | "--validate") {
  const project = join(root, "tools/hl2rtx-mount/Hl2RtxMount.csproj");
  await run(["dotnet", "build", project, "-c", "Release", "--nologo", "-v", "quiet"]);
  return run(["dotnet", join(dirname(project), "bin/Release/net10.0/Hl2RtxMount.dll"), "--game", game, "--hl2rtx", hl2rtx, "--usda-fixes", fixes, mode]);
}

async function main() {
  const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: {
    source: { type: "string" }, target: { type: "string" }, hl2rtx: { type: "string" },
    profile: { type: "string" }, apply: { type: "boolean" }, help: { type: "boolean" },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log("bun run setup --source <Steam GMod> --target <separate directory> --hl2rtx <Steam HL2 RTX> [--profile native|bridge] [--apply]\nbun run verify --target <managed directory>\nbun run doctor --target <game directory>");
    return;
  }
  if (!["setup", "verify", "doctor"].includes(command) || positionals.length !== 1) throw new Error("Expected setup, verify or doctor.");
  if (process.platform !== "win32") throw new Error("Deployment requires Windows x64.");
  if (!values.target) throw new Error("--target is required.");
  const target = resolve(values.target);
  if (command === "doctor") {
    const log = join(target, "rtx-remix/logs/remix-dxvk.log");
    const text = await Bun.file(log).text();
    const lines = text.split(/\r?\n/).filter(line => /DLSS-NR|NVIDIA DLSS-RR|Failed to create DLSS-RR|(?:Compiling|Finished) Remix pipeline|RenderPass .*Raytrace Mode|rtx\.enableRayReconstruction|rtx\.neuralRendering\.enable/.test(line));
    const nrEvaluated = /NVIDIA DLSS-NR evaluated/.test(text);
    const rrEvaluated = /NVIDIA DLSS-RR evaluated successfully/.test(text);
    console.log(JSON.stringify({ target, log, lastWriteTime: (await Bun.file(log).stat()).mtime, nrEvaluated, rrEvaluated, rrNrEvaluatedInLog: rrEvaluated && /NVIDIA DLSS-NR evaluated[^\n]*RR guides selected/.test(text), evidence: lines.slice(-40) }, null, 2));
    return;
  }
  const markerPath = join(target, markerName);
  const previous: Installation | undefined = await exists(markerPath) ? await Bun.file(markerPath).json() : undefined;
  if (previous && previous.schemaVersion !== 1) throw new Error("Unsupported installation marker version.");
  if (!(values.source ?? previous?.source) || !(values.hl2rtx ?? previous?.hl2rtx)) throw new Error("New installations require --source and --hl2rtx.");
  const source = await realpath(resolve(values.source ?? previous!.source));
  const hl2rtx = await realpath(resolve(values.hl2rtx ?? previous!.hl2rtx));
  if (previous && (source.toLowerCase() !== previous.source.toLowerCase() || hl2rtx.toLowerCase() !== previous.hl2rtx.toLowerCase())) throw new Error("The managed installation already uses different source paths. Choose a new target to remount another source.");
  const profile = values.profile ?? previous?.profile ?? "native";
  if (profile !== "native" && profile !== "bridge") throw new Error("--profile must be native or bridge.");
  if (within(source, target) || within(target, source) || within(root, target) || within(target, root) || within(target, hl2rtx) || within(hl2rtx, target)) throw new Error("Source games, project and target must be separate directories.");
  let ancestor = target;
  while (!await exists(ancestor)) ancestor = dirname(ancestor);
  if ((await realpath(ancestor)).toLowerCase() !== ancestor.toLowerCase()) throw new Error("Target must not use a redirected directory.");
  if (!await exists(join(source, "bin/win64/gmod.exe"))) throw new Error("Source must contain the x86-64 GMod branch (bin/win64/gmod.exe).");
  if (!await exists(join(hl2rtx, "rtx-remix/mods/hl2rtx/mod.usda"))) throw new Error("Install Half-Life 2 RTX content before setup.");
  if (!previous && await exists(target) && (await readdir(target)).length) throw new Error("Target is not empty and has no gmod-dlss-nr marker. Choose a new empty directory.");
  await run([process.execPath, join(root, "scripts/fetch-artifacts.ts"), "--verify-only"]);
  await verifyPayload();
  const patches = await planEnginePatches(previous ? target : source);
  const installation: Installation = { schemaVersion: 1, source, hl2rtx, profile };
  if (command === "setup" && !values.apply) {
    console.log(JSON.stringify({ mode: "plan", target, ...installation, enginePatches: patches, actions: [previous ? "Update managed runtime and profile" : "Create isolated GMod installation", "Mount installed HL2 RTX assets", "Write portable launcher"], next: "Repeat with --apply after reviewing these paths." }, null, 2));
    return;
  }
  if (command === "verify" && !previous) throw new Error("No managed installation marker.");
  await assertPhysicalDestination(markerPath, target);
  const usda = join(await extract("usda-fixes"), "hl2rtxdemo");
  let mounted = previous ? await mountTool(target, hl2rtx, usda, "--validate") : "";
  if (command === "setup") {
    await assertStopped(target);
    await mkdir(target, { recursive: true });
    await assertPhysicalDestination(target, target);
    if (!previous) {
      await prepareBase(source, target);
      await writeFile(markerPath, JSON.stringify(installation, null, 2) + "\n", target);
    }
    await overlay(await extract("gmod-rtx"), target, target);
    await overlay(await extract("remix"), join(target, "bin/win64"), target);
    await applyEnginePatches(target);
    await overlay(join(root, "payload/common"), target, target);
    await overlay(join(root, "payload/native"), target, target);
    if (profile === "bridge") await overlay(join(root, "payload/bridge"), target, target);
    else for (const name of ["dlss5-bridge.addon64", "renodx-dlss5.addon64"]) {
      const path = join(target, "bin/win64", name);
      await assertPhysicalDestination(path, target);
      if (await exists(path)) await rename(path, path + ".disabled");
    }
    for (const [path, name] of Object.entries(baseConfigs)) {
      if (path !== "user.conf" && (!previous || !await exists(join(target, path)))) await writeFile(join(target, path), await Bun.file(join(root, "config/base", name)).bytes(), target);
    }
    const userPath = join(target, "user.conf");
    const hasUserConfig = await exists(userPath);
    if (!previous || !hasUserConfig || profile !== previous.profile) {
      const user = await Bun.file(hasUserConfig ? userPath : join(root, "config/base/user.conf")).text();
      await writeFile(userPath, mergeSettings(user, await Bun.file(join(root, `config/profiles/${profile}.conf`)).text()), target);
    }
    const layer = profile === "bridge" ? 'set "VK_LAYER_PATH=%~dp0bin\\win64"\r\nset "VK_INSTANCE_LAYERS=VK_LAYER_reshade"\r\n' : 'set "DISABLE_VK_LAYER_reshade_1=1"\r\n';
    await writeFile(join(target, "launch-gmod-rtx.cmd"), '@echo off\r\nsetlocal\r\n' + layer + 'start "" /D "%~dp0" "%~dp0bin\\win64\\gmod.exe" -game garrysmod -dxlevel 90 -nod3d9ex -windowed -noborder -insecure -novid -console -condebug +mat_disable_d3d9ex 1 %*\r\n', target);
    if (!previous) mounted = await mountTool(target, hl2rtx, usda, "--apply");
  }
  const finalPatches = await planEnginePatches(target);
  if (finalPatches.some(patch => patch.status !== "applied")) throw new Error("Engine patches are not fully applied.");
  const expectedFiles = new Map<string, string>();
  async function collect(input: string, destination: string): Promise<void> {
    for (const entry of await readdir(input, { withFileTypes: true })) {
      if (entry.name === ".complete") continue;
      const path = join(destination, entry.name);
      if (entry.isDirectory()) await collect(join(input, entry.name), path);
      else expectedFiles.set(path, join(input, entry.name));
    }
  }
  await collect(await extract("gmod-rtx"), "");
  await collect(await extract("remix"), "bin/win64");
  for (const directory of ["common", "native", ...(profile === "bridge" ? ["bridge"] : [])]) await collect(join(root, "payload", directory), "");
  for (const [path, input] of expectedFiles) {
    if (editableFiles.has(path.replaceAll("\\", "/")) || finalPatches.some(patch => resolve(target, path) === patch.path)) continue;
    if (await hash(input) !== await hash(join(target, path))) throw new Error(`Installed runtime differs: ${join(target, path)}`);
  }
  const launcher = await Bun.file(join(target, "launch-gmod-rtx.cmd")).text();
  if (!launcher.includes(profile === "native" ? 'set "DISABLE_VK_LAYER_reshade_1=1"' : 'set "VK_INSTANCE_LAYERS=VK_LAYER_reshade"')) throw new Error("Launcher does not match the selected profile.");
  if (profile === "native") for (const name of ["dlss5-bridge.addon64", "renodx-dlss5.addon64"]) {
    if (await exists(join(target, "bin/win64", name))) throw new Error(`Legacy addon is still active in native profile: ${name}`);
  }
  for (const name of Object.keys(baseConfigs)) {
    if (!await exists(join(target, name))) throw new Error(`Missing game configuration: ${name}`);
  }
  if (command === "setup") await writeFile(markerPath, JSON.stringify(installation, null, 2) + "\n", target);
  console.log(JSON.stringify({ status: "verified", target, profile, mount: JSON.parse(mounted), enginePatches: finalPatches, runtime: "Launch the game yourself, load a map, then run doctor. File verification does not prove rendered RR+NR frames." }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
