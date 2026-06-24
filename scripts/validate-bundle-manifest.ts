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
 * HEAD`. Sizes are rounded to whole KB before comparison (matching the PR delta
 * comment), so sub-KB gzip jitter does not cause spurious failures.
 *
 * It also compares each scene's `runtimeChunks` set. Chunk filenames carry a
 * content hash, so they change whenever a PR alters code that actually lands in
 * that scene's bundle (its own scene code or a shared module it imports). This
 * catches content-only changes that leave the rounded KB sizes unchanged.
 *
 * Exit code 1 (with a helpful message) when the committed manifest is stale.
 *
 * Usage: npx tsx scripts/validate-bundle-manifest.ts
 */
import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";

const MANIFEST_DIR_REL_PATH = "lab/public/bundle/manifest";
// Legacy single-file path, kept to validate against pre-migration HEAD commits.
const LEGACY_MANIFEST_REL_PATH = "lab/public/bundle/manifest.json";

interface ManifestEntry {
    rawKB?: number;
    gzipKB?: number;
    runtimeChunks?: string[];
}

type Manifest = Record<string, ManifestEntry>;

function roundToWholeKB(kb: number | undefined): number {
    return Math.round(kb ?? 0);
}

/** Compare two chunk lists as order-independent sets. Returns null when equal. */
function diffRuntimeChunks(committed: string[] | undefined, built: string[] | undefined): string | null {
    const committedSet = new Set(committed ?? []);
    const builtSet = new Set(built ?? []);

    const added = [...builtSet].filter((c) => !committedSet.has(c)).sort();
    const removed = [...committedSet].filter((c) => !builtSet.has(c)).sort();

    if (added.length === 0 && removed.length === 0) {
        return null;
    }

    const parts: string[] = [];
    if (removed.length > 0) {
        parts.push(`-${removed.join(", -")}`);
    }
    if (added.length > 0) {
        parts.push(`+${added.join(", +")}`);
    }
    return parts.join("  ");
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

        const builtRaw = roundToWholeKB(builtEntry.rawKB);
        const committedRaw = roundToWholeKB(committedEntry.rawKB);
        const builtGzip = roundToWholeKB(builtEntry.gzipKB);
        const committedGzip = roundToWholeKB(committedEntry.gzipKB);

        if (builtRaw !== committedRaw || builtGzip !== committedGzip) {
            mismatches.push(`  ${key}: committed raw=${committedRaw}KB gzip=${committedGzip}KB → rebuilt raw=${builtRaw}KB gzip=${builtGzip}KB`);
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
                `Run 'pnpm build:bundle-scenes' locally and commit the regenerated ${MANIFEST_DIR_REL_PATH}/<scene>.json files.\n\n` +
                `Differences (committed vs rebuilt; sizes rounded to whole KB):\n` +
                mismatches.join("\n")
        );
        process.exit(1);
    }

    console.log(`Bundle manifest is up to date (${Object.keys(built).length} scenes checked).`);
}

main();
