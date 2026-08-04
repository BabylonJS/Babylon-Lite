/**
 * Report (and optionally enforce) whether the committed per-scene bundle-size
 * manifest matches a fresh measurement.
 *
 * ## Why this is a report, not a gate
 *
 * The manifest under `lab/public/bundle/manifest/<scene>.json` records each
 * scene's runtime-fetched bundle size. Almost every change to a shared module
 * moves bytes in *most* of the ~230 scenes, so an exact-equality gate against
 * `git HEAD` had a fatal property: whenever any shared-code PR merged first,
 * every other open PR's committed manifest became stale and its CI turned red
 * for reasons unrelated to that PR. The only cure was a rebase plus a very slow
 * full local rebuild — repeated on every subsequent merge to master.
 *
 * The baseline is therefore CI-owned: `scripts/commit-bundle-manifest.ts` pushes
 * the freshly measured files back to the PR branch, so reviewers still see the
 * size deltas in the diff without any author busywork. This script's job is to
 * describe the drift (for the build log and for that auto-commit step), not to
 * fail the build.
 *
 * **Bundle-size regressions are still gated** — by the absolute per-scene
 * ceilings in `scene-config.json` (`maxRawKB`), which `pnpm build:bundle-scenes`
 * enforces byte-exactly and which no automation may raise. That check is
 * deterministic and independent of what any other PR merged, so it never goes
 * stale.
 *
 * ## What is compared
 *
 * - `rawBytes` exactly when both sides carry it (`rawKB` is rounded to 0.1 KB and
 *   hides sub-50-byte drift); otherwise the legacy whole-KB `rawKB` comparison.
 * - `gzipKB` rounded to whole KB — zlib output varies with the build, so an exact
 *   check would differ across environments.
 * - `runtimeChunks` as a set **with content hashes stripped**. Chunk filenames are
 *   `<scene>-<name>-<hash>.js`, and the hash changes whenever any module in the
 *   chunk changes — including edits made by an unrelated PR that merged first, or
 *   a Rollup/Vite upgrade. Comparing hashes therefore reported "chunk churn" that
 *   carried no size information. Comparing the hash-stripped names still catches
 *   the signal that matters: a scene starting or stopping to pull in a module.
 *
 * ## Usage
 *
 *   npx tsx scripts/validate-bundle-manifest.ts            # report, always exits 0
 *   npx tsx scripts/validate-bundle-manifest.ts --strict   # exit 1 on any drift
 *
 * `--strict` (or `BUNDLE_MANIFEST_STRICT=true`) restores the old hard-failing
 * behaviour; it is useful locally to confirm a manifest is fully up to date.
 * `BUNDLE_MANIFEST_ROOT` overrides the repo root (used by the unit tests).
 *
 * Meant to run AFTER `pnpm build:bundle-scenes`, which overwrites the working-tree
 * per-scene files with freshly measured sizes.
 */
import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";

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

/**
 * Strip the Rollup content hash from a chunk filename.
 *
 * Non-entry chunks are emitted as `<scene>-<name>-<hash>.js` (see `chunkFileNames`
 * in `scripts/bundle-scenes-core.ts`) with Rollup's default 8-character
 * base64url-ish hash. Entry chunks are plain `<scene>.js` and are returned
 * unchanged, as is anything that does not end in a hash-shaped segment.
 */
export function stripChunkHash(file: string): string {
    return file.replace(/-[A-Za-z0-9_-]{8}\.js$/, ".js");
}

/** Compare raw size as exactly as both sides allow.
 *
 *  `rawBytes` is exact and deterministic (a sum of fetched file lengths), so when both
 *  sides carry it they are compared byte-for-byte: `rawKB` alone is rounded to 0.1 KB and
 *  hides sub-50-byte drift. Entries recorded before `rawBytes` existed fall back to the
 *  old whole-KB comparison rather than reporting spurious drift.
 *
 *  gzip is deliberately NOT compared exactly: its output varies with the zlib build, so an
 *  exact check would differ across environments. It stays rounded to whole KB. */
export function diffRawSize(committed: ManifestEntry, built: ManifestEntry): string | null {
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

/**
 * Compare two chunk lists as order-independent sets of hash-stripped names.
 * Returns null when the two describe the same set of modules.
 */
export function diffRuntimeChunks(committed: string[] | undefined, built: string[] | undefined): string | null {
    const committedSet = new Set((committed ?? []).map(stripChunkHash));
    const builtSet = new Set((built ?? []).map(stripChunkHash));

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

/** Collect every difference between the committed and the freshly built manifest. */
export function collectDrift(committed: Manifest, built: Manifest): string[] {
    const keys = new Set([...Object.keys(built), ...Object.keys(committed)]);
    const drift: string[] = [];

    for (const key of [...keys].sort()) {
        const builtEntry = built[key];
        const committedEntry = committed[key];

        if (!builtEntry) {
            drift.push(`  ${key}: present in committed manifest but missing after rebuild`);
            continue;
        }
        if (!committedEntry) {
            drift.push(`  ${key}: produced by rebuild but missing from committed manifest`);
            continue;
        }

        const rawDiff = diffRawSize(committedEntry, builtEntry);
        if (rawDiff !== null) {
            drift.push(`  ${key}: ${rawDiff}`);
        }

        const builtGzip = roundToWholeKB(builtEntry.gzipKB);
        const committedGzip = roundToWholeKB(committedEntry.gzipKB);
        if (builtGzip !== committedGzip) {
            drift.push(`  ${key}: committed gzip=${committedGzip}KB → rebuilt gzip=${builtGzip}KB`);
        }

        const chunkDiff = diffRuntimeChunks(committedEntry.runtimeChunks, builtEntry.runtimeChunks);
        if (chunkDiff !== null) {
            drift.push(`  ${key}: runtime chunks changed (${chunkDiff})`);
        }
    }

    return drift;
}

/** How many drifted scenes to spell out before summarising the rest. */
const DRIFT_LIST_LIMIT = 40;

function summarizeDrift(drift: string[]): string {
    if (drift.length <= DRIFT_LIST_LIMIT) {
        return drift.join("\n");
    }
    return `${drift.slice(0, DRIFT_LIST_LIMIT).join("\n")}\n  … and ${drift.length - DRIFT_LIST_LIMIT} more`;
}

function strictModeRequested(argv: readonly string[]): boolean {
    return argv.includes("--strict") || process.env.BUNDLE_MANIFEST_STRICT === "true";
}

function main(): void {
    const rootDir = process.env.BUNDLE_MANIFEST_ROOT ? resolve(process.env.BUNDLE_MANIFEST_ROOT) : resolve(__dirname, "..");
    const strict = strictModeRequested(process.argv.slice(2));

    const built = readBuiltManifest(rootDir);
    const committed = readCommittedManifest(rootDir);

    if (committed === null) {
        console.error(`No committed manifest found under ${MANIFEST_DIR_REL_PATH}/ at HEAD.\nRun 'pnpm build:bundle-scenes' and commit the generated per-scene manifest files.`);
        process.exit(1);
    }

    const drift = collectDrift(committed, built);

    if (drift.length === 0) {
        console.log(`Bundle manifest is up to date (${Object.keys(built).length} scenes checked).`);
        console.log("##vso[task.setvariable variable=BUNDLE_MANIFEST_STALE]false");
        return;
    }

    const detail =
        `${drift.length} difference(s) between the committed manifest and this build ` +
        `(raw compared exactly in bytes, gzip rounded to whole KB, chunk names compared without content hashes):\n` +
        summarizeDrift(drift);

    if (strict) {
        console.error(
            `Bundle manifest validation FAILED (--strict): ${MANIFEST_DIR_REL_PATH}/ is stale.\n` +
                `Run 'pnpm build:bundle-scenes' locally and commit the regenerated files.\n` +
                `\n` +
                `If the differing scenes are flagged 'deviceDependentChunks' in scene-config.json (113/114/115), a\n` +
                `plain local build deliberately leaves them alone: their chunk set depends on the GPU, so only a\n` +
                `software-renderer measurement matches CI. Regenerate those with:\n` +
                `    pnpm build:bundle-manifest:device\n` +
                `\n${detail}`
        );
        process.exit(1);
    }

    // Informational only. Per-scene ceilings (enforced byte-exactly by
    // `pnpm build:bundle-scenes`) are what gate a size regression; the manifest
    // itself is refreshed by scripts/commit-bundle-manifest.ts.
    console.log(`Bundle manifest drift detected — the CI auto-commit step will refresh it.\n${detail}`);
    console.log("##vso[task.setvariable variable=BUNDLE_MANIFEST_STALE]true");
}

if (require.main === module) {
    main();
}
