import { rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import manifest from "../../config/engine-patches.json";

export interface EnginePatchPlan {
  file: string;
  path: string;
  status: "pending" | "applied";
  changedBytes: number;
}

export interface EnginePatchResult extends Omit<EnginePatchPlan, "status"> {
  status: "patched" | "already-applied";
}

function hash(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

async function prepareEnginePatches(gameRoot: string) {
  return Promise.all(manifest.files.map(async (patch) => {
    const path = resolve(gameRoot, "bin", "win64", patch.file);
    const input = Buffer.from(await Bun.file(path).arrayBuffer());
    const actualHash = hash(input);
    const plan: EnginePatchPlan = {
      file: patch.file,
      path,
      status: actualHash === patch.patchedSha256 ? "applied" : "pending",
      changedBytes: patch.spans.reduce((sum, span) => sum + span.after.length / 2, 0),
    };

    if (plan.status === "applied") {
      return { patch, plan, output: null };
    }

    if (actualHash !== patch.originalSha256) {
      throw new Error(`Unsupported revision of ${path}: SHA-256 ${actualHash}; expected ${patch.originalSha256} (original) or ${patch.patchedSha256} (patched).`);
    }

    const output = Buffer.from(input);
    let previousEnd = 0;
    for (const span of patch.spans) {
      if (!Number.isSafeInteger(span.offset) || span.offset < previousEnd ||
          !/^(?:[0-9a-f]{2})+$/.test(span.before) ||
          !/^(?:[0-9a-f]{2})+$/.test(span.after) || span.before.length !== span.after.length) {
        throw new Error(`Invalid patch span for ${patch.file} at offset ${span.offset}.`);
      }

      const before = Buffer.from(span.before, "hex");
      const after = Buffer.from(span.after, "hex");
      previousEnd = span.offset + before.length;
      if (previousEnd > input.length || !input.subarray(span.offset, previousEnd).equals(before)) {
        throw new Error(`Patch bytes do not match ${patch.file} at offset ${span.offset}.`);
      }
      after.copy(output, span.offset);
    }

    if (hash(output) !== patch.patchedSha256) {
      throw new Error(`Patched SHA-256 does not match the manifest for ${patch.file}.`);
    }
    return { patch, plan, output };
  }));
}

/** Read-only preflight of every bin/win64 DLL; unknown revisions fail before any write. */
export async function planEnginePatches(gameRoot: string): Promise<EnginePatchPlan[]> {
  return (await prepareEnginePatches(gameRoot)).map(({ plan }) => plan);
}

/** Preflight all DLLs, then atomically replace each pending file. Safe to run again. */
export async function applyEnginePatches(gameRoot: string): Promise<EnginePatchResult[]> {
  const prepared = await prepareEnginePatches(gameRoot);
  const results: EnginePatchResult[] = [];

  for (const { patch, plan, output } of prepared) {
    if (output === null) {
      results.push({ ...plan, status: "already-applied" });
      continue;
    }

    const temporaryPath = `${plan.path}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporaryPath, output);
      const currentHash = hash(await Bun.file(plan.path).bytes());
      if (currentHash === patch.patchedSha256) {
        results.push({ ...plan, status: "already-applied" });
        continue;
      }
      if (currentHash !== patch.originalSha256) {
        throw new Error(`${plan.path} changed after preflight (SHA-256 ${currentHash}); refusing to overwrite it.`);
      }

      await rename(temporaryPath, plan.path);
      results.push({ ...plan, status: "patched" });
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  return results;
}
