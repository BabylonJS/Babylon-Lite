/**
 * Generates the rolled-up `@babylonjs/lite` type declaration the playground feeds
 * into Monaco for IntelliSense, and copies it next to the served engine bundle at
 * `public/engine/dev/index.d.ts`.
 *
 * The engine's `build:dist` step (api-extractor) takes ~10s, which is far too slow
 * to run on every `predev`. So this script is incremental: it regenerates only when
 * the output is missing or older than the newest file under the engine `src/` tree.
 * Run automatically via the playground `predev`/`prebuild` scripts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const playgroundRoot = resolve(here, "..");
const repoRoot = resolve(playgroundRoot, "..");
const enginePkgDir = join(repoRoot, "packages", "babylon-lite");
const engineSrcDir = join(enginePkgDir, "src");
const generatedDts = join(enginePkgDir, "build", "index.d.ts");
const outDir = join(playgroundRoot, "public", "engine", "dev");
const outDts = join(outDir, "index.d.ts");

/** Most-recent mtime (ms) across all files under a directory tree. */
function newestMtime(dir: string): number {
    let newest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            newest = Math.max(newest, newestMtime(full));
        } else {
            newest = Math.max(newest, statSync(full).mtimeMs);
        }
    }
    return newest;
}

function isUpToDate(): boolean {
    if (!existsSync(outDts)) {
        return false;
    }
    const outMtime = statSync(outDts).mtimeMs;
    return outMtime >= newestMtime(engineSrcDir);
}

if (isUpToDate()) {
    console.log("[engine-types] up to date — skipping regeneration");
    process.exit(0);
}

if (!existsSync(generatedDts) || statSync(generatedDts).mtimeMs < newestMtime(engineSrcDir)) {
    console.log("[engine-types] generating rolled-up d.ts via babylon-lite build:dist (~10s)…");
    execFileSync("pnpm", ["--filter", "babylon-lite", "build:dist"], { cwd: repoRoot, stdio: "inherit", shell: true });
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outDts, normalizeForMonaco(readFileSync(generatedDts, "utf8")));
console.log(`[engine-types] wrote ${outDts}`);

/**
 * Adapt the engine declaration to Monaco's bundled TypeScript lib. The engine is
 * built with a newer TypeScript whose typed arrays are generic
 * (`Float32Array<ArrayBuffer>`); Monaco's older lib reports "Type 'Float32Array'
 * is not generic". Drop the type argument from typed-array references so the
 * declaration type-checks cleanly inside Monaco.
 */
function normalizeForMonaco(dts: string): string {
    const typedArrays =
        "Float32Array|Float64Array|Int8Array|Int16Array|Int32Array|Uint8Array|Uint8ClampedArray|Uint16Array|Uint32Array|BigInt64Array|BigUint64Array";
    return dts.replace(new RegExp(`\\b(${typedArrays})<[^<>]*>`, "g"), "$1");
}
