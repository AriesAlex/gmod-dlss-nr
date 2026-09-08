import { link, mkdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import manifest from "../config/artifacts.json";

type Artifact = (typeof manifest.artifacts)[number];

const cliArgs = Bun.argv.slice(2);
if (cliArgs.length > 1 || (cliArgs.length === 1 && cliArgs[0] !== "--verify-only")) {
  console.error("Usage: bun scripts/fetch-artifacts.ts [--verify-only]");
  process.exit(1);
}
const verifyOnly = cliArgs.includes("--verify-only");
const archives = resolve(import.meta.dir, "../payload/archives");

async function verify(path: string, artifact: Artifact): Promise<void> {
  const file = Bun.file(path);
  if (file.size !== artifact.sizeBytes) {
    throw new Error(`${artifact.file}: expected ${artifact.sizeBytes} bytes, found ${file.size}.`);
  }
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) hasher.update(chunk);
  const actual = hasher.digest("hex").toUpperCase();
  if (actual !== artifact.sha256) {
    throw new Error(`${artifact.file}: SHA-256 mismatch; expected ${artifact.sha256}, found ${actual}.`);
  }
}

async function ensureArtifact(artifact: Artifact) {
  if (basename(artifact.file) !== artifact.file) {
    throw new Error(`Archive filename must stay directly inside payload/archives: ${artifact.file}`);
  }
  const path = resolve(archives, artifact.file);
  if (await Bun.file(path).exists()) {
    await verify(path, artifact);
    return { id: artifact.id, file: artifact.file, status: "verified" };
  }
  if (verifyOnly) throw new Error(`Missing archive: ${artifact.file}`);

  const temporary = resolve(archives, `${artifact.file}.${crypto.randomUUID()}.tmp`);
  try {
    console.error(`Downloading ${artifact.file} from ${artifact.url}`);
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`${artifact.file}: download returned HTTP ${response.status}.`);
    await Bun.write(temporary, response);
    await verify(temporary, artifact);
    // A same-directory hard link publishes the complete file atomically and
    // fails if another invocation has created the destination in the meantime.
    await link(temporary, path);
    return { id: artifact.id, file: artifact.file, status: "downloaded" };
  } finally {
    await rm(temporary, { force: true });
  }
}

try {
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported artifact manifest schema.");
  if (!verifyOnly) await mkdir(archives, { recursive: true });
  const results = await Promise.allSettled(manifest.artifacts.map(ensureArtifact));
  const verified = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  const errors = results.flatMap((result, index) => result.status === "rejected"
    ? [{ id: manifest.artifacts[index]!.id, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }]
    : []);
  if (errors.length !== 0) {
    console.error(JSON.stringify({ status: "error", artifacts: verified, errors }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ status: "verified", artifacts: verified }));
  }
} catch (error) {
  console.error(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
