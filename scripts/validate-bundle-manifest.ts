/**
 * Validate that the committed bundle-size manifest is up to date.
 *
 * A PR that changes runtime code (or scenes) such that per-scene bundle sizes
 * move MUST also commit the regenerated `lab/public/bundle/manifest.json`.
 * GUIDANCE.md makes this mandatory so reviewers can see size deltas in the diff
 * and the tracked baseline stays in sync with the code.
 *
 * This script is meant to run in CI AFTER `pnpm build:bundle-scenes`, which
 * overwrites the working-tree manifest with freshly measured sizes. It compares
 * that freshly built manifest against the version committed at `git HEAD`. Sizes
 * are rounded to whole KB before comparison (matching the PR delta comment), so
 * sub-KB gzip jitter does not cause spurious failures.
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
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const MANIFEST_REL_PATH = "lab/public/bundle/manifest.json";

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

function parseManifest(text: string, source: string): Manifest {
    try {
        return JSON.parse(text) as Manifest;
    } catch (err) {
        throw new Error(`Failed to parse ${source} as JSON: ${(err as Error).message}`);
    }
}

function readBuiltManifest(absPath: string): Manifest {
    if (!existsSync(absPath)) {
        throw new Error(`Freshly built manifest not found at ${absPath}. Did 'pnpm build:bundle-scenes' run first?`);
    }
    return parseManifest(readFileSync(absPath, "utf-8"), "built manifest");
}

function readCommittedManifest(rootDir: string): Manifest | null {
    try {
        const text = execFileSync("git", ["show", `HEAD:${MANIFEST_REL_PATH}`], {
            cwd: rootDir,
            encoding: "utf-8",
        });
        return parseManifest(text, "committed manifest");
    } catch {
        // Manifest does not exist at HEAD (e.g. brand-new file not yet committed).
        return null;
    }
}

function main(): void {
    const rootDir = resolve(__dirname, "..");
    const builtPath = resolve(rootDir, MANIFEST_REL_PATH);

    const built = readBuiltManifest(builtPath);
    const committed = readCommittedManifest(rootDir);

    if (committed === null) {
        console.error(`Bundle manifest validation FAILED: ${MANIFEST_REL_PATH} is not committed at HEAD.\n` + `Run 'pnpm build:bundle-scenes' and commit the generated manifest.`);
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
            `Bundle manifest validation FAILED: ${MANIFEST_REL_PATH} is stale.\n` +
                `This PR changes per-scene bundle output but did not commit an updated manifest.\n` +
                `Run 'pnpm build:bundle-scenes' locally and commit the regenerated ${MANIFEST_REL_PATH}.\n\n` +
                `Differences (committed vs rebuilt; sizes rounded to whole KB):\n` +
                mismatches.join("\n")
        );
        process.exit(1);
    }

    console.log(`Bundle manifest is up to date (${Object.keys(built).length} scenes checked).`);
}

main();
