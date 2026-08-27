/**
 * Stage the master bundle-size baseline for publication.
 *
 * Runs on master only, from `azure-pipelines-bundle-manifest.yml`, after every
 * scene has been measured. It takes the aggregate `manifest.json` the build
 * produced and prepares the exact bytes that get uploaded, adding two things the
 * raw manifest cannot carry:
 *
 *  1. **Ceilings.** Each entry is stamped with the scene's `maxRawKB` as it stood
 *     on the commit being measured. A consumer that wants to know whether master
 *     was already over its ceiling otherwise has to read `scene-config.json` from
 *     its own working tree, which is the *branch's* copy — so a PR that tightens a
 *     ceiling makes master retroactively appear to have been in breach. A
 *     measurement and the limit it was taken against have to travel together.
 *
 *  2. **Provenance**, in a `meta.json` sidecar: which commit produced these bytes,
 *     which build, and when.
 *
 * Provenance is a sidecar rather than an envelope inside `manifest.json` because
 * `isBundleManifest` (scripts/bundle-scenes-core.ts) requires *every* top-level
 * value to have a numeric `rawKB`. A `_meta` key would fail that check, and the
 * check runs in every consumer that is already deployed — every open PR branch and
 * every developer clone. Adding a top-level key would therefore not degrade those
 * consumers, it would blank the baseline for all of them at once, which is exactly
 * the repo-wide breakage that publishing the baseline was introduced to end.
 * Per-entry fields are additive and unknown ones are ignored, so `ceilingKB` is
 * safe by the same reasoning.
 *
 * Output is written to a staging directory; uploading is the pipeline's job.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface SceneConfigEntry {
    id: number;
    maxRawKB?: number;
    skipBundleSize?: boolean;
}

interface BundleManifestEntry {
    rawKB: number;
    gzipKB: number;
    rawBytes?: number;
    ceilingKB?: number;
    [key: string]: unknown;
}

type BundleManifest = Record<string, BundleManifestEntry>;

export interface BaselineMeta {
    /** Commit the measurements were taken from. */
    commit: string;
    /** Azure DevOps build that produced them, when running in CI. */
    buildId?: string;
    buildNumber?: string;
    /** ISO-8601 completion time. */
    generatedAt: string;
    /** Number of scenes in the manifest, so a truncated upload is detectable. */
    scenes: number;
    /** How many of those scenes carry a ceiling. */
    ceilings: number;
}

/**
 * Stamp each measured scene with the ceiling it was measured against.
 *
 * A scene with no `maxRawKB`, or one that opts out via `skipBundleSize`, gets no
 * `ceilingKB` — matching the opt-out that `bundle-size.spec.ts` honours. Consumers
 * are required to read an absent value as "unknown", not as "unlimited", so the two
 * cases collapsing here is intentional: neither is enforceable.
 */
export function stampCeilings(manifest: BundleManifest, sceneConfig: SceneConfigEntry[]): BundleManifest {
    const ceilingByScene = new Map<string, number>();
    for (const entry of sceneConfig) {
        if (entry.skipBundleSize || entry.maxRawKB == null) continue;
        ceilingByScene.set(`scene${entry.id}`, entry.maxRawKB);
    }

    const stamped: BundleManifest = {};
    for (const [scene, entry] of Object.entries(manifest)) {
        const ceilingKB = ceilingByScene.get(scene);
        stamped[scene] = ceilingKB == null ? entry : { ...entry, ceilingKB };
    }
    return stamped;
}

function gitHead(): string {
    // Build.SourceVersion is the commit ADO checked out; prefer it over `git
    // rev-parse HEAD` so the recorded provenance is the pipeline's own notion of
    // what it built rather than something a later step could have moved.
    const fromPipeline = process.env.BUILD_SOURCEVERSION?.trim();
    if (fromPipeline) return fromPipeline;
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
}

function main(): void {
    const manifestPath = process.env.BUNDLE_BASELINE_MANIFEST ?? resolve(ROOT, "lab/public/bundle/manifest.json");
    const outDir = process.env.BUNDLE_BASELINE_STAGING ?? resolve(ROOT, "lab/public/bundle-baseline-staging");

    if (!existsSync(manifestPath)) {
        console.error(`No aggregate manifest at ${manifestPath} — refusing to publish an empty baseline.`);
        process.exit(1);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as BundleManifest;
    const scenes = Object.keys(manifest).length;
    if (scenes === 0) {
        console.error(`The manifest at ${manifestPath} has no scenes — refusing to publish an empty baseline.`);
        process.exit(1);
    }

    const sceneConfig = JSON.parse(readFileSync(resolve(ROOT, "scene-config.json"), "utf-8")) as SceneConfigEntry[];
    const stamped = stampCeilings(manifest, sceneConfig);
    const ceilings = Object.values(stamped).filter((entry) => entry.ceilingKB != null).length;

    const commit = gitHead();
    const meta: BaselineMeta = {
        commit,
        buildId: process.env.BUILD_BUILDID?.trim() || undefined,
        buildNumber: process.env.BUILD_BUILDNUMBER?.trim() || undefined,
        generatedAt: new Date().toISOString(),
        scenes,
        ceilings,
    };

    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "manifest.json"), `${JSON.stringify(stamped, null, 2)}\n`);
    writeFileSync(resolve(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

    console.log(`✓ Staged bundle-size baseline for ${commit.slice(0, 8)}: ${scenes} scene(s), ${ceilings} with a ceiling.`);
    console.log(`  ${outDir}`);

    // Consumed by the pipeline to address the immutable per-commit copy.
    console.log(`##vso[task.setvariable variable=BASELINE_COMMIT]${commit}`);
}

// ESM entrypoint check: `require.main` and `__dirname` are CJS-only and happen to
// work under tsx today purely because it transpiles to CJS. The rest of scripts/
// uses this form, and it keeps `stampCeilings` importable from tests without
// running the staging side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
