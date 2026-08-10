/**
 * Validate that the committed per-scene bundle-size manifest is up to date.
 *
 * A PR that changes runtime code (or scenes) such that per-scene bundle sizes
 * move MUST also commit the regenerated per-scene manifest files under
 * `lab/public/bundle/manifest/<scene>.json`. GUIDANCE.md makes this mandatory so
 * reviewers can see size deltas in the diff and the tracked baseline stays in
 * sync with the code. The manifest is distributed (one file per scene) so PRs
 * touching different scenes do not collide on a single shared manifest file.
 *
 * This script is meant to run in CI AFTER `pnpm build:bundle-scenes`, which
 * overwrites the working-tree per-scene files with freshly measured sizes. It
 * compares those freshly built files against the versions committed at `git
 * HEAD`. Raw size is compared exactly, in bytes (`rawBytes`), because `rawKB` is
 * rounded to 0.1 KB and hides sub-50-byte drift. gzip stays rounded to whole KB:
 * its output varies with the zlib build, so an exact check would fail spuriously
 * across environments.
 *
 * It also compares each scene's logical `runtimeChunks` set after removing
 * Vite's content hashes. Added or removed runtime features remain visible, while
 * content-hash-only churn does not force unrelated manifest rewrites. Exact
 * `rawBytes` still catches every runtime-size movement.
 *
 * Exit code 1 (with a helpful message) when the committed manifest is stale.
 *
 * Usage: npx tsx scripts/validate-bundle-manifest.ts
 */
import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { diffRuntimeChunks } from "./bundle-manifest-chunks.js";

const MANIFEST_DIR_REL_PATH = "lab/public/bundle/manifest";
// Legacy single-file path, kept to validate against pre-migration HEAD commits.
const LEGACY_MANIFEST_REL_PATH = "lab/public/bundle/manifest.json";

interface ManifestEntry {
    rawKB?: number;
    rawBytes?: number;
    gzipKB?: number;
    runtimeChunks?: string[];
}

type Manifest = Record<string, ManifestEntry>;

function roundToWholeKB(kb: number | undefined): number {
    return Math.round(kb ?? 0);
}

/** Compare raw size as exactly as both sides allow.
 *
 *  `rawBytes` is exact and deterministic (a sum of fetched file lengths), so when both
 *  sides carry it they are compared byte-for-byte: `rawKB` alone is rounded to 0.1 KB and
 *  hides sub-50-byte drift, which is precisely how a stale manifest slipped through on a
 *  zero-headroom scene. Entries committed before `rawBytes` existed fall back to the old
 *  whole-KB comparison rather than failing spuriously.
 *
 *  gzip is deliberately NOT compared exactly: its output varies with the zlib build, so an
 *  exact check would fail across environments. It stays rounded to whole KB. */
function diffRawSize(committed: ManifestEntry, built: ManifestEntry): string | null {
    if (committed.rawBytes != null && built.rawBytes != null) {
        if (committed.rawBytes !== built.rawBytes) {
            const delta = built.rawBytes - committed.rawBytes;
            return `committed raw=${committed.rawBytes}B → rebuilt raw=${built.rawBytes}B (${delta > 0 ? "+" : ""}${delta} bytes)`;
        }
        return null;
    }
    const committedRaw = roundToWholeKB(committed.rawKB);
    const builtRaw = roundToWholeKB(built.rawKB);
    return committedRaw === builtRaw ? null : `committed raw=${committedRaw}KB → rebuilt raw=${builtRaw}KB`;
}

function parseJson<T>(text: string, source: string): T {
    try {
        return JSON.parse(text) as T;
    } catch (err) {
        throw new Error(`Failed to parse ${source} as JSON: ${(err as Error).message}`);
    }
}

function sceneFromFile(file: string): string {
    const base = file.slice(file.lastIndexOf("/") + 1);
    return base.slice(0, -".json".length);
}

/** Read the freshly built per-scene manifest files from the working tree. */
function readBuiltManifest(rootDir: string): Manifest {
    const dir = resolve(rootDir, MANIFEST_DIR_REL_PATH);
    if (!existsSync(dir)) {
        throw new Error(`Freshly built manifest dir not found at ${dir}. Did 'pnpm build:bundle-scenes' run first?`);
    }
    const manifest: Manifest = {};
    for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        manifest[sceneFromFile(file)] = parseJson<ManifestEntry>(readFileSync(resolve(dir, file), "utf-8"), `built ${file}`);
    }
    return manifest;
}

/**
 * Read the committed per-scene manifest from `git HEAD`. Returns null only when
 * neither the distributed dir nor the legacy single file exists at HEAD.
 */
function readCommittedManifest(rootDir: string): Manifest | null {
    // Preferred: distributed per-scene files under manifest/.
    let listing = "";
    try {
        listing = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", MANIFEST_DIR_REL_PATH], {
            cwd: rootDir,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch {
        listing = "";
    }
    const files = listing
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.endsWith(".json"));
    if (files.length > 0) {
        const manifest: Manifest = {};
        for (const file of files) {
            const text = execFileSync("git", ["show", `HEAD:${file}`], { cwd: rootDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
            manifest[sceneFromFile(file)] = parseJson<ManifestEntry>(text, `committed ${file}`);
        }
        return manifest;
    }

    // Legacy single-file fallback (pre-migration HEAD): the legacy
    // manifest.json is an aggregate map (scene -> entry), so parse it as a
    // whole Manifest rather than a single entry.
    let text: string;
    try {
        text = execFileSync("git", ["show", `HEAD:${LEGACY_MANIFEST_REL_PATH}`], {
            cwd: rootDir,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch {
        return null;
    }
    return parseJson<Manifest>(text, "committed legacy manifest");
}

function main(): void {
    const rootDir = resolve(__dirname, "..");

    const built = readBuiltManifest(rootDir);
    const committed = readCommittedManifest(rootDir);

    if (committed === null) {
        console.error(
            `Bundle manifest validation FAILED: no committed manifest found under ${MANIFEST_DIR_REL_PATH}/ at HEAD.\n` +
                `Run 'pnpm build:bundle-scenes' and commit the generated per-scene manifest files.`
        );
        process.exit(1);
    }

    const keys = new Set([...Object.keys(built), ...Object.keys(committed)]);
    const mismatches: string[] = [];

    for (const key of [...keys].sort()) {
        const builtEntry = built[key];
        const committedEntry = committed[key];

        if (!builtEntry) {
            mismatches.push(`  ${key}: present in committed manifest but missing after rebuild`);
            continue;
        }
        if (!committedEntry) {
            mismatches.push(`  ${key}: produced by rebuild but missing from committed manifest`);
            continue;
        }

        const rawDiff = diffRawSize(committedEntry, builtEntry);
        if (rawDiff !== null) {
            mismatches.push(`  ${key}: ${rawDiff}`);
        }

        const builtGzip = roundToWholeKB(builtEntry.gzipKB);
        const committedGzip = roundToWholeKB(committedEntry.gzipKB);
        if (builtGzip !== committedGzip) {
            mismatches.push(`  ${key}: committed gzip=${committedGzip}KB → rebuilt gzip=${builtGzip}KB`);
        }

        const chunkDiff = diffRuntimeChunks(committedEntry.runtimeChunks, builtEntry.runtimeChunks);
        if (chunkDiff !== null) {
            mismatches.push(`  ${key}: runtime chunks changed (${chunkDiff})`);
        }
    }

    if (mismatches.length > 0) {
        console.error(
            `Bundle manifest validation FAILED: per-scene manifest under ${MANIFEST_DIR_REL_PATH}/ is stale.\n` +
                `This PR changes per-scene bundle output but did not commit the updated manifest files.\n` +
                `Run 'pnpm build:bundle-scenes' locally and commit the regenerated ${MANIFEST_DIR_REL_PATH}/<scene>.json files.\n` +
                `\n` +
                `If the differing scenes are flagged 'deviceDependentChunks' in scene-config.json (113/114/115), a\n` +
                `plain local build deliberately leaves them alone: their chunk set depends on the GPU, so only a\n` +
                `software-renderer measurement matches CI. Regenerate those with:\n` +
                `    pnpm build:bundle-manifest:device\n` +
                `(that needs a working SwiftShader WebGPU stack — fine on Linux/CI, unreliable on Windows. If it\n` +
                `cannot run, restore those files to their committed values: they are CI-authored.)\n` +
                `\n` +
                `Differences (committed vs rebuilt; raw compared exactly in bytes, gzip rounded to whole KB):\n` +
                mismatches.join("\n")
        );
        process.exit(1);
    }

    console.log(`Bundle manifest is up to date (${Object.keys(built).length} scenes checked).`);
}

main();
