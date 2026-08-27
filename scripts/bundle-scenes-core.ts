/**
 * Shared core for building tree-shaken, minified per-scene bundles.
 *
 * Each scene is built independently (separate Rollup pass) so:
 *  - Bundle sizes reflect true standalone cost (no shared-chunk inflation)
 *
 * After building, a headless browser loads each bundle-sceneN.html page and
 * measures only the JS bytes actually fetched at runtime.  Dynamic-import
 * chunks that are never loaded (e.g. animation for a static model) are
 * correctly excluded from the manifest numbers.
 */
import { build, type Plugin, type Rollup } from "vite";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { resolve, dirname, join, extname } from "path";
import { rmSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from "fs";
import { minify as terserMinify, type ECMA, type SourceMapOptions } from "terser";
import { bytesToRoundedKB, IGNORED_BUNDLE_MODULE_PATTERN, isVendorRuntimeChunkFile, summarizeRuntimeBundle, type RuntimeJsPayload } from "./bundle-size-accounting";
import { wgslMinifyPlugin } from "./wgsl-minify-plugin";

/**
 * Vite plugin: mangle underscore-prefixed properties via Terser.
 * Runs in generateBundle (after esbuild minification) with a shared nameCache
 * so cross-chunk property names stay consistent.
 */
export function terserPropertyManglePlugin(): Plugin {
    return {
        name: "terser-property-mangle",
        async generateBundle(_options, bundle) {
            const nameCache: Record<string, unknown> = {};

            for (const [, chunk] of Object.entries(bundle)) {
                if (chunk.type !== "chunk") continue;

                // Skip bundled third-party WASM/shaping runtimes (text-shaper, manifold,
                // recast-navigation). Their pre-built emscripten glue uses many `_`-prefixed
                // internal names that this first-party mangler would rewrite, corrupting the
                // runtime (e.g. recast's WASM init throws "… is not a function"). A real
                // consumer of `build/lib` never runs this mangler, so excluding these chunks
                // here keeps the measurement build aligned with what consumers actually ship.
                if (isVendorRuntimeChunkFile(chunk.fileName)) continue;

                // Dynamically extract WASM import binding names from emscripten
                // glue code.  These are property keys in the env object that the
                // WASM binary imports by name at instantiation time — they must
                // survive property mangling.  The variable holding the object may
                // have been renamed by esbuild, so we anchor on `_abort_js:` which
                // is always the first alphabetical key emscripten emits.
                const wasmReserved: string[] = [];
                const wasmObjMatch = chunk.code.match(/\{(_abort_js:[^}]+)\}/);
                if (wasmObjMatch) {
                    const keys = wasmObjMatch[1]!.match(/\b(_\w+)\s*:/g);
                    if (keys) wasmReserved.push(...keys.map((k) => k.replace(/\s*:/, "")));
                }

                const result = await terserMinify(chunk.code, {
                    // terser's published ECMA union stops at 2020 but accepts 2022 at runtime
                    ecma: 2022 as unknown as ECMA,
                    module: true,
                    compress: {
                        passes: 2,
                        unsafe: true,
                        unsafe_arrows: true,
                        unsafe_methods: true,
                        pure_getters: true,
                        toplevel: true,
                        // NOTE: booleans_as_integers is intentionally NOT enabled.
                        // It folds boolean literals `true`/`false` to `1`/`0`, which
                        // silently breaks runtime `typeof x === "boolean"` checks — e.g.
                        // ShaderMaterial defines (boolean vs number) emit `const X: bool`
                        // vs `f32`, producing invalid WGSL. The byte savings are tiny and
                        // not worth the silent correctness hazard.
                    },
                    mangle: {
                        toplevel: true,
                        properties: {
                            regex: /^_[a-z]/,
                            // `_malloc`/`_free` are emscripten exports accessed on
                            // externally-loaded modules (e.g. draco_decoder.js) whose
                            // glue isn't in the bundle, so wasmReserved can't detect them.
                            // Shader slots are intentionally read through dynamic keys.
                            // Terser cannot rewrite f[key], so keep the backing property names stable.
                            reserved: [
                                "_pad",
                                "_pad0",
                                "_pad1",
                                "_pad2",
                                "_pad3",
                                "_pad4",
                                "_imgPad0",
                                "_imgPad1",
                                "_malloc",
                                "_free",
                                "_vertexSlots",
                                "_fragmentSlots",
                                ...wasmReserved,
                            ],
                        },
                    },
                    nameCache,
                    sourceMap: chunk.map ? ({ content: chunk.map as object, asObject: true } as SourceMapOptions) : false,
                });

                if (result.code) {
                    chunk.code = result.code;
                }
                if (result.map) {
                    chunk.map = result.map as typeof chunk.map;
                }
            }
        },
    };
}

import { createServer, type Server } from "http";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export const labDir = resolve(ROOT, "lab");
export const liteLabDir = resolve(labDir, "lite");
export const outDir = resolve(labDir, "public/bundle");
export const bundleInfoDir = resolve(outDir, "bundle-info");
export const srcDir = resolve(ROOT, "packages/babylon-lite/src");
// The bundle harness measures the bundle size a REAL consumer of the published
// `@babylonjs/lite` package gets, so scenes are bundled against the built `build/lib`
// tree (module-granular output that bundlers resolve) rather than the TS source. The
// package build must run first; `assertLibBuilt()` enforces that with a clear error.
// (The lab dev app and master-comparison build still resolve to `srcDir` — see notes
// at their call sites.)
export const libDir = resolve(ROOT, "packages/babylon-lite/build/lib");
const LIB_FALLBACK_ENV = "LITE_BUNDLE_ALLOW_SRC_FALLBACK";
const BUNDLE_SCENES_ENV = "BUNDLE_SCENES";

function parseSceneSelectionArg(): string | null {
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === "--scene" || arg === "--scenes") {
            return argv[i + 1] ?? null;
        }
        if (arg.startsWith("--scene=")) {
            return arg.slice("--scene=".length);
        }
        if (arg.startsWith("--scenes=")) {
            return arg.slice("--scenes=".length);
        }
    }
    return process.env[BUNDLE_SCENES_ENV] ?? null;
}

function normalizeSceneSelection(raw: string | null): Set<string> | null {
    if (!raw) {
        return null;
    }

    const names = raw
        .split(/[,\s]+/)
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => (/^\d+$/.test(name) ? `scene${name}` : name));

    return names.length > 0 ? new Set(names) : null;
}

function selectRequestedScenes(allScenes: readonly string[], requested: Set<string> | null): string[] {
    if (!requested) {
        return [...allScenes];
    }
    return allScenes.filter((scene) => requested.has(scene));
}

/** Fail fast with an actionable message if the package's `build/lib` output (which the
 *  scene bundles are measured against) hasn't been built yet. */
function resolveLiteAliasDir(): string {
    const libIndex = resolve(libDir, "index.js");
    if (existsSync(libIndex)) {
        return libDir;
    }

    if (process.env[LIB_FALLBACK_ENV] === "true") {
        console.warn(`Missing ${libIndex}. Falling back to source alias (${srcDir}) because ${LIB_FALLBACK_ENV}=true.`);
        return srcDir;
    }

    throw new Error(`Missing ${libIndex}.\n` + "Build the package first: `pnpm --filter babylon-lite build:lib` (or `pnpm build`).");
}
// Per-scene manifest files under `lab/public/bundle/manifest/` are build output,
// not tracked source: a single aggregate `manifest.json` is generated from them
// for runtime consumers (lab UI, bundle-size test, report script, static lab
// site). Nothing here is committed — see `DEFAULT_MASTER_MANIFEST_URL` for where
// the master baseline actually comes from. `MANIFEST_GIT_PATH` /
// `MANIFEST_DIR_GIT_PATH` are the legacy tracked paths, read only as a fallback
// for refs that predate the move to a published baseline.
const MANIFEST_GIT_PATH = "lab/public/bundle/manifest.json";
const MANIFEST_DIR_GIT_PATH = "lab/public/bundle/manifest";
const MANIFEST_DIR = "manifest";
const MANIFEST_FILE = "manifest.json";
const MASTER_MANIFEST_FILE = "master-manifest.json";

/**
 * Where the master bundle-size baseline is published.
 *
 * The baseline used to be ~227 JSON files tracked in git and refreshed by PR
 * authors. That made it the repo's dominant source of both merge conflicts (two
 * branches rewriting the same generated files) and red CI (any merge left every
 * other branch's copy stale). It is now measured once per master build and
 * published as a single file to the same public storage that serves the
 * per-build Playwright reports and lab sites, so no branch — and no bot — ever
 * writes it.
 *
 * Hardcoded rather than configured because the primary readers are fork PR
 * builds and local `pnpm build:bundle-scenes` runs, neither of which has
 * pipeline variables. Must stay in sync with `baselineDeployPath` in
 * `azure-pipelines-bundle-manifest.yml`.
 */
const DEFAULT_MASTER_MANIFEST_URL = "https://snapshots-cvgtc2eugrd3cgfd.z01.azurefd.net/lite/bundle-baseline/manifest.json";
export const NAME_POLYFILL = 'var __name=(fn,name)=>(Object.defineProperty(fn,"name",{value:name,configurable:true}),fn);';
export const LITE_BUNDLE_TARGET = "esnext";

interface SceneConfigEntry {
    id: number;
    tags?: string[];
    /** Raw bundle-size ceiling in KB. Absent for scenes that opt out of the check. */
    maxRawKB?: number;
    /** Scene opts out of bundle-size ceiling enforcement (mirrors bundle-size.spec.ts). */
    skipBundleSize?: boolean;
    /** This scene's runtime dynamic-imports branch on device capability, so its measured
     *  chunk set differs between a developer's GPU and CI's software renderer. Only CI's
     *  measurement is comparable to the published baseline. See `DEVICE_DEPENDENT_NOTE`. */
    deviceDependentChunks?: boolean;
}

interface BundleManifestEntry {
    rawKB: number;
    gzipKB: number;
    /** Exact runtime-fetched byte count. `rawKB` is this rounded to 0.1 KB for display, which
     *  hides sub-50-byte drift — including a ceiling overflow on a zero-headroom scene. Tools
     *  comparing sizes (the build's ceiling check, the delta report) use this. */
    rawBytes?: number;
    /**
     * The scene's `maxRawKB` ceiling **as it stood on the commit this baseline was measured
     * from**, stamped in at publish time by `scripts/publish-bundle-baseline.ts`.
     *
     * Without it, a consumer asking "was master already over its ceiling?" has only the
     * baseline's bytes and the *branch's* `scene-config.json`, so a PR that tightens a
     * ceiling makes master retroactively look like it was in breach. The measurement and
     * the limit it was measured against have to travel together to answer that.
     *
     * Optional because baselines published before this field existed do not carry it, and
     * because a scene may legitimately have no ceiling (`skipBundleSize`, or no `maxRawKB`).
     * Consumers must treat "absent" as "unknown", never as "no ceiling".
     */
    ceilingKB?: number;
    ignoredRawKB?: number;
    bjsRawKB?: number;
    bjsGzipKB?: number;
    runtimeChunks?: string[];
}

type BundleManifest = Record<string, BundleManifestEntry>;

const sceneConfig: SceneConfigEntry[] = JSON.parse(readFileSync(resolve(ROOT, "scene-config.json"), "utf-8"));
const sceneConfigByName = new Map(sceneConfig.map((s) => [`scene${s.id}`, s]));
const ALL_SCENES = sceneConfig.map((s) => `scene${s.id}`);

function firstExistingPath(paths: string[]): string {
    return paths.find((p) => existsSync(p)) ?? paths[0]!;
}

function liteSceneEntry(scene: string, sourceLabDir = labDir): string {
    return firstExistingPath([resolve(sourceLabDir, `lite/src/lite/${scene}.ts`), resolve(sourceLabDir, `src/lite/${scene}.ts`)]);
}

function bjsSceneEntry(scene: string, sourceLabDir = labDir): string {
    const liteScene = scene.startsWith("bjs-") ? scene.slice(4) : scene;
    return firstExistingPath([resolve(sourceLabDir, `lite/src/bjs/${liteScene}.ts`), resolve(sourceLabDir, `src/bjs/${liteScene}.ts`)]);
}

function liteHtmlPath(file: string): string {
    return firstExistingPath([resolve(liteLabDir, file), resolve(labDir, file)]);
}

function orderBundleManifest(manifest: BundleManifest): BundleManifest {
    const ordered: BundleManifest = {};
    for (const scene of ALL_SCENES) {
        const entry = manifest[scene];
        if (entry) ordered[scene] = entry;
    }
    for (const [scene, entry] of Object.entries(manifest)) {
        if (!ordered[scene]) ordered[scene] = entry;
    }
    return ordered;
}

/** Absolute path to a scene's per-scene manifest file. */
function perSceneManifestPath(scene: string): string {
    return resolve(outDir, MANIFEST_DIR, `${scene}.json`);
}

/**
 * Read the per-scene manifest files (`manifest/<scene>.json`) into a
 * single aggregate map. This is the source of truth seed for incremental builds.
 */
export function readCurrentBundleManifest(): BundleManifest {
    const dir = resolve(outDir, MANIFEST_DIR);
    const manifest: BundleManifest = {};
    if (!existsSync(dir)) return manifest;
    for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const scene = file.slice(0, -".json".length);
        try {
            manifest[scene] = JSON.parse(readFileSync(resolve(dir, file), "utf-8")) as BundleManifestEntry;
        } catch {
            /* skip malformed per-scene file */
        }
    }
    return manifest;
}

/**
 * Atomically write JSON to `path` (sibling temp file + rename). The lab UI and
 * concurrent readers may hold the destination open; rename never truncates it
 * and survives transient Windows file locks (errno -4094 / EBUSY).
 */
function atomicWriteJson(path: string, json: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    for (let attempt = 0; ; attempt++) {
        try {
            writeFileSync(tmpPath, json);
            renameSync(tmpPath, path);
            return;
        } catch (err) {
            if (attempt >= 5) throw err;
            const wait = Date.now() + 50 * (attempt + 1);
            while (Date.now() < wait) {
                /* brief synchronous backoff before retrying the atomic write */
            }
        }
    }
}

/** Write a single scene's per-scene manifest file. */
function writePerSceneManifest(scene: string, entry: BundleManifestEntry): void {
    atomicWriteJson(perSceneManifestPath(scene), `${JSON.stringify(entry, null, 2)}\n`);
}

/** Write the generated (gitignored) aggregate `manifest.json` for runtime consumers. */
function writeAggregateBundleManifest(manifest: BundleManifest): void {
    atomicWriteJson(resolve(outDir, MANIFEST_FILE), JSON.stringify(orderBundleManifest(manifest), null, 2));
}

/**
 * Read many git blobs in one `git cat-file --batch` call, keyed by the revision
 * spec that produced them.
 *
 * The legacy tracked layout is ~230 files per ref, and spawning `git show` once
 * per file costs ~15s per resolve — long enough to time out callers and to make
 * every `build:bundle-scenes` run that misses the published baseline feel hung.
 * One batched process makes the same read effectively free.
 *
 * `--batch` emits `<oid> SP <type> SP <size> LF <contents> LF` per request, or
 * `<spec> SP missing LF` for one it cannot resolve, so the output is parsed as a
 * buffer and sliced by the declared byte length rather than split on newlines.
 */
function readGitBlobs(specs: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (specs.length === 0) {
        return out;
    }

    const stdout = execFileSync("git", ["cat-file", "--batch"], {
        cwd: ROOT,
        input: specs.join("\n") + "\n",
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
    });

    let offset = 0;
    for (const spec of specs) {
        const newline = stdout.indexOf("\n", offset);
        if (newline === -1) {
            break;
        }
        const header = stdout.toString("utf-8", offset, newline);
        offset = newline + 1;
        const [, type, rawSize] = header.split(" ");
        const size = Number(rawSize);
        if (type === undefined || !Number.isFinite(size)) {
            // "missing" / "ambiguous" responses carry no body to skip past.
            continue;
        }
        if (type === "blob") {
            out.set(spec, stdout.toString("utf-8", offset, offset + size));
        }
        offset += size + 1; // trailing LF after the contents
    }
    return out;
}

function readMasterBundleManifestFromRef(ref: string): BundleManifest | null {
    // Preferred: distributed per-scene tracked files under `manifest/`.
    try {
        const list = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", MANIFEST_DIR_GIT_PATH], {
            cwd: ROOT,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const files = list
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.endsWith(".json"));
        if (files.length > 0) {
            const blobs = readGitBlobs(files.map((file) => `${ref}:${file}`));
            const manifest: BundleManifest = {};
            for (const file of files) {
                const json = blobs.get(`${ref}:${file}`);
                if (json === undefined) {
                    continue;
                }
                const scene = file.slice(file.lastIndexOf("/") + 1, -".json".length);
                manifest[scene] = JSON.parse(json) as BundleManifestEntry;
            }
            if (Object.keys(manifest).length > 0) {
                return manifest;
            }
        }
    } catch {
        /* fall through to the legacy single-file layout */
    }
    // Legacy single-file fallback for pre-migration master refs.
    try {
        const json = execFileSync("git", ["show", `${ref}:${MANIFEST_GIT_PATH}`], { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
        return JSON.parse(json) as BundleManifest;
    } catch {
        return null;
    }
}

function readMasterBundleManifestFromGit(refs = ["upstream/master", "origin/master", "master"]): { source: string; manifest: BundleManifest } | null {
    for (const ref of refs) {
        const manifest = readMasterBundleManifestFromRef(ref);
        if (manifest) return { source: ref, manifest };
    }
    return null;
}

/** A full 40-character git object name, the only form the published layout uses. */
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

function gitOutput(args: string[]): string | null {
    try {
        return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
        return null;
    }
}

/**
 * Commits whose published baseline would be a like-for-like comparison for this
 * build, most specific first.
 *
 * The problem being solved: the mutable `manifest.json` is whatever master
 * published most recently, which is not necessarily the commit this build was
 * merged with. Comparing against it silently attributes bytes from every master
 * commit in between to the PR under test.
 *
 * Candidates, at most one of which normally applies:
 *  - `BUNDLE_BASELINE_COMMIT` — an explicit override. Set but empty means "do not
 *    look up a per-commit baseline at all", mirroring `BUNDLE_MASTER_MANIFEST_URL`.
 *  - HEAD's **first parent, only when HEAD is a merge commit**. Azure DevOps checks
 *    PRs out at `refs/pull/N/merge`, whose first parent is exactly the master commit
 *    the PR was merged with. Read from the raw commit object rather than via
 *    `rev-parse HEAD^1`, because CI checks out at `--depth=1`, where the shallow
 *    graft makes `rev-parse HEAD^1` fail outright ("unknown revision") even though
 *    the commit object still records both parents. Using `cat-file` therefore needs
 *    no `fetchDepth` change in the pipeline. The merge-commit requirement matters:
 *    on an ordinary commit the first parent is just the previous commit, which
 *    carries no "this is what I was merged with" meaning.
 *  - The merge base with master, for local `pnpm build:bundle-scenes` runs — the
 *    commit the branch actually diverged from. Needs real history, so it simply
 *    yields nothing in CI's shallow checkout.
 *
 * Deliberately *not* a candidate: the current `origin/master` SHA. That is the
 * mutable baseline by another name, so probing it would reintroduce the exact
 * mis-attribution this lookup exists to remove, while costing an extra request.
 *
 * A candidate with no published baseline is a plain 404 — one round trip, then the
 * mutable baseline. Nothing waits and nothing fails.
 */
/**
 * The outcome of working out which commit's baseline to ask for.
 *
 * `disabled` is kept separate from an empty `commits` list because the two lead a
 * reader to different places: an explicit opt-out is this build's own
 * configuration doing what it was told, while an empty list is a checkout that
 * could not say what it was merged with. Collapsing them would report a
 * deliberate setting as a fault.
 */
interface BaselineCommitLookup {
    /** True when the caller explicitly switched per-commit lookup off. */
    disabled: boolean;
    /** Full SHAs to try, in order. Empty when none could be determined. */
    commits: string[];
}

function readBaselineCommitCandidates(): BaselineCommitLookup {
    const explicit = process.env.BUNDLE_BASELINE_COMMIT;
    if (explicit !== undefined) {
        const trimmed = explicit.trim();
        // Set-but-empty is the documented off switch. A non-empty value that is not
        // a full SHA is a failed attempt at naming a commit, not an opt-out, so it
        // reports as undetermined rather than as disabled.
        if (trimmed === "") return { disabled: true, commits: [] };
        return { disabled: false, commits: FULL_SHA_PATTERN.test(trimmed) ? [trimmed] : [] };
    }

    const candidates: string[] = [];

    const head = gitOutput(["cat-file", "-p", "HEAD"]);
    if (head) {
        // Header lines are ordered: tree, then parent(s), then author.
        const parents: string[] = [];
        for (const line of head.split("\n")) {
            if (line.startsWith("tree ")) continue;
            if (!line.startsWith("parent ")) break;
            parents.push(line.slice("parent ".length).trim());
        }
        if (parents.length > 1 && parents[0]) candidates.push(parents[0]);
    }

    for (const ref of ["upstream/master", "origin/master"]) {
        const base = gitOutput(["merge-base", "HEAD", ref]);
        if (base) {
            candidates.push(base);
            break;
        }
    }

    return { disabled: false, commits: [...new Set(candidates.filter((sha) => FULL_SHA_PATTERN.test(sha)))] };
}

/**
 * Rewrite a baseline manifest URL to the immutable per-commit copy beside it:
 * `.../bundle-baseline/manifest.json` -> `.../bundle-baseline/<sha>/manifest.json`.
 *
 * Derived from the URL actually in effect rather than from the hardcoded default,
 * so `BUNDLE_MASTER_MANIFEST_URL` overrides (tests, mirrors) keep working.
 *
 * Exported for tests/lite/unit/pipeline-fail-fast-ordering.test.ts, which binds
 * this derivation to the path the publish step actually uploads to. Nothing else
 * keeps the two in agreement, and a drift between them is a silent 404 on every
 * per-commit lookup — which degrades to the mutable baseline and so looks exactly
 * like the pre-existing behaviour this change was made to replace.
 */
export function perCommitBaselineUrl(manifestUrl: string, commit: string): string {
    const slash = manifestUrl.lastIndexOf("/");
    if (slash < 0) return manifestUrl;
    return `${manifestUrl.slice(0, slash)}/${commit}${manifestUrl.slice(slash)}`;
}

/** Guard against a CDN or proxy serving something that parses as JSON but isn't a manifest. */
function isBundleManifest(value: unknown): value is BundleManifest {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const entries = Object.values(value);
    return entries.length > 0 && entries.every((entry) => typeof entry === "object" && entry !== null && typeof (entry as BundleManifestEntry).rawKB === "number");
}

/** Read a baseline that CI (or a developer) already placed on disk. */
function readMasterBundleManifestFromFile(path: string): BundleManifest | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
        return isBundleManifest(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Fetch the published baseline. A 404 means master has not published one yet
 * (first run after this change, or a fork with no deployment) and is not an
 * error — the caller degrades to "no baseline", which only costs the advisory
 * delta report.
 *
 * `quiet404` suppresses the miss message for per-commit probes, where a 404 is
 * the ordinary case (the base commit's baseline build may still be running, may
 * have failed, or may predate per-commit publishing) and the caller reports the
 * outcome once it knows which candidate, if any, hit.
 */
async function fetchMasterBundleManifest(url: string, { quiet404 = false }: { quiet404?: boolean } = {}): Promise<BundleManifest | null> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (response.status === 404) {
            if (!quiet404) console.warn(`No published bundle-size baseline at ${url} yet; skipping the master delta.`);
            return null;
        }
        if (!response.ok) {
            console.warn(`Could not fetch the bundle-size baseline from ${url}: HTTP ${response.status}.`);
            return null;
        }
        const parsed: unknown = await response.json();
        if (!isBundleManifest(parsed)) {
            console.warn(`The response from ${url} is not a bundle-size manifest; skipping the master delta.`);
            return null;
        }
        return parsed;
    } catch (error) {
        console.warn(`Could not fetch the bundle-size baseline from ${url}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

/**
 * Resolve the master baseline, in order of preference:
 *   1. `BUNDLE_MASTER_MANIFEST_FILE` — a baseline CI already downloaded.
 *   2. The baseline published for *this build's own base commit*, then the
 *      mutable latest baseline (both skipped when `refs` is given, i.e. when the
 *      caller explicitly asked to compare against a specific git ref, or when
 *      `BUNDLE_MASTER_MANIFEST_URL` is set to an empty value).
 *   3. Git refs — the legacy tracked layout, still readable on old refs.
 */
export async function resolveMasterBundleManifest(refs?: string[]): Promise<{ source: string; manifest: BundleManifest } | null> {
    const filePath = process.env.BUNDLE_MASTER_MANIFEST_FILE;
    if (filePath) {
        const manifest = readMasterBundleManifestFromFile(filePath);
        if (manifest) return { source: filePath, manifest };
        console.warn(`BUNDLE_MASTER_MANIFEST_FILE=${filePath} could not be read as a manifest; falling back to the published baseline.`);
    }

    if (!refs) {
        // An explicitly empty BUNDLE_MASTER_MANIFEST_URL means "do not fetch" — for
        // offline runs, and for the master build that is about to overwrite the
        // baseline anyway. Trimmed because a YAML-supplied blank can arrive as " ".
        const url = (process.env.BUNDLE_MASTER_MANIFEST_URL ?? DEFAULT_MASTER_MANIFEST_URL).trim();
        if (url) {
            const lookup = readBaselineCommitCandidates();
            for (const commit of lookup.commits) {
                const commitUrl = perCommitBaselineUrl(url, commit);
                const manifest = await fetchMasterBundleManifest(commitUrl, { quiet404: true });
                if (manifest) {
                    console.log(`✓ Bundle-size baseline matched this build's base commit ${commit.slice(0, 8)}.`);
                    return { source: commitUrl, manifest };
                }
            }

            const manifest = await fetchMasterBundleManifest(url);
            if (manifest) {
                // Say so explicitly. This baseline may have been measured on a different
                // commit than the one this build was merged with, so any delta computed
                // from it can attribute another PR's bytes to this one. Silently doing
                // that is the failure this per-commit lookup exists to avoid, so when the
                // fallback fires the reader needs to know it did.
                //
                // The three ways of getting here need different words, because they send
                // the reader to three different places: a base commit with no baseline is
                // a producer-side gap that closes on its own; an undetermined base commit
                // is a property of this checkout that will not; and an explicit opt-out is
                // this build doing what it was configured to do, which is not a fault at
                // all and should not be reported as one.
                let why: string;
                if (lookup.disabled) {
                    why = "per-commit baseline lookup is switched off for this run";
                } else if (lookup.commits.length > 0) {
                    why = "no baseline was published for this build's base commit";
                } else {
                    why = "this build's base commit could not be determined, so no per-commit baseline was requested";
                }
                console.warn(`Using the latest published bundle-size baseline (${url}); ${why}.`);
                return { source: url, manifest };
            }
        }
    }

    const fromGit = readMasterBundleManifestFromGit(refs);
    if (fromGit) return fromGit;

    console.warn("Could not resolve a master bundle-size baseline; the bundle delta UI and PR comment will be skipped.");
    return null;
}

export async function writeMasterBundleManifest(refs?: string[]): Promise<void> {
    const masterManifestPath = resolve(outDir, MASTER_MANIFEST_FILE);
    const baseline = await resolveMasterBundleManifest(refs);
    if (!baseline) {
        rmSync(masterManifestPath, { force: true });
        return;
    }

    writeFileSync(masterManifestPath, JSON.stringify(orderBundleManifest(baseline.manifest), null, 2));
    console.log(`✓ Bundle master baseline manifest (${baseline.source}) written to ${masterManifestPath}`);
}

/**
 * Normalize an absolute module id to a compact, repo-relative display path.
 * - Paths inside the repo are made relative to the repo root.
 * - Paths inside pnpm's `.pnpm/<pkg>@ver/node_modules/<pkg>/...` are collapsed
 *   to `node_modules/<pkg>/...`.
 * - Windows backslashes are normalized to forward slashes.
 * - Virtual ids (starting with `\0`) and query suffixes (e.g. `?raw`) are preserved.
 */
function normalizeModuleId(id: string, sourceRoot = ROOT): string {
    let out = id.replace(/\\/g, "/");
    // Split query suffix (e.g. "?raw") so we don't interfere with path logic.
    const qIdx = out.indexOf("?");
    const query = qIdx >= 0 ? out.slice(qIdx) : "";
    if (qIdx >= 0) out = out.slice(0, qIdx);

    // Virtual modules (Rollup convention) — keep as-is.
    if (out.startsWith("\u0000")) return out + query;

    const rootFwd = sourceRoot.replace(/\\/g, "/") + "/";
    if (out.startsWith(rootFwd)) out = out.slice(rootFwd.length);

    // Collapse pnpm virtual store paths.
    const pnpmMatch = out.match(/(^|\/)node_modules\/\.pnpm\/[^/]+\/node_modules\/(.*)$/);
    if (pnpmMatch) out = "node_modules/" + pnpmMatch[2];

    return out + query;
}

interface BundleInfoExport {
    name: string;
    kind: "function" | "class" | "const" | "enum" | "unknown";
}
interface BundleInfoModule {
    id: string;
    bytes: number;
    exports: BundleInfoExport[];
}
interface BundleInfoChunk {
    file: string;
    bytes: number;
    isEntry: boolean;
    modules: BundleInfoModule[];
}

interface SourceMapLike {
    sources: string[];
    mappings: string;
}

const exportKindCache = new Map<string, Record<string, BundleInfoExport["kind"]>>();

const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_VALUES = new Map([...VLQ_CHARS].map((ch, i) => [ch, i]));

function decodeVlq(segment: string, index: { value: number }): number {
    let result = 0;
    let shift = 0;
    let continuation = 0;
    do {
        const value = VLQ_VALUES.get(segment[index.value++]!) ?? 0;
        continuation = value & 32;
        result += (value & 31) << shift;
        shift += 5;
    } while (continuation);
    const negate = result & 1;
    result >>= 1;
    return negate ? -result : result;
}

function decodeMappings(mappings: string): number[][][] {
    let source = 0;
    let originalLine = 0;
    let originalColumn = 0;
    let name = 0;
    return mappings.split(";").map((line) => {
        let generatedColumn = 0;
        return line
            .split(",")
            .filter(Boolean)
            .map((raw) => {
                const index = { value: 0 };
                generatedColumn += decodeVlq(raw, index);
                if (index.value >= raw.length) return [generatedColumn];
                source += decodeVlq(raw, index);
                originalLine += decodeVlq(raw, index);
                originalColumn += decodeVlq(raw, index);
                const segment = [generatedColumn, source, originalLine, originalColumn];
                if (index.value < raw.length) {
                    name += decodeVlq(raw, index);
                    segment.push(name);
                }
                return segment;
            });
    });
}

function normalizeSourceMapId(source: string, sourceRoot: string): string {
    let clean = source
        .replace(/^file:\/\//, "")
        .replace(/^\/([A-Za-z]:\/)/, "$1")
        .split("?")[0]!;
    const marker = clean.match(/(?:^|\/)((?:packages\/babylon-lite|lab|node_modules)\/.*)$/);
    if (marker) {
        clean = resolve(sourceRoot, marker[1]!);
    }
    if (clean.startsWith("../") || clean.startsWith("./")) {
        return normalizeModuleId(resolve(sourceRoot, "lab", clean), sourceRoot);
    }
    return normalizeModuleId(clean, sourceRoot);
}

function lineStarts(code: string): number[] {
    const starts = [0];
    for (let i = 0; i < code.length; i++) {
        if (code.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
}

function lineEnd(code: string, starts: number[], line: number): number {
    const next = starts[line + 1];
    return next == null ? code.length : Math.max(starts[line]!, next - 1);
}

function minifiedModuleBytes(code: string, map: SourceMapLike | null | undefined, sourceRoot: string): Record<string, number> {
    if (!map?.mappings || !Array.isArray(map.sources)) return {};
    const starts = lineStarts(code);
    const decoded = decodeMappings(map.mappings);
    const bytes: Record<string, number> = {};
    decoded.forEach((segments, line) => {
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i]!;
            const sourceIndex = segment[1];
            if (sourceIndex == null) continue;
            const nextSegment = segments[i + 1];
            const start = starts[line]! + segment[0]!;
            const end = starts[line]! + (nextSegment ? nextSegment[0]! : lineEnd(code, starts, line) - starts[line]!);
            if (end <= start) continue;
            const id = normalizeSourceMapId(map.sources[sourceIndex]!, sourceRoot);
            bytes[id] = (bytes[id] ?? 0) + Buffer.byteLength(code.slice(start, end), "utf8");
        }
    });
    return bytes;
}

/**
 * Parse a .ts / .js source file to classify each exported binding as
 * function / class / const / enum. Uses lightweight regex-based parsing —
 * sufficient for the repo's conventional `export function / const / class`
 * declarations. Also follows same-package `export { X } from "./path.js"`
 * re-exports so chips inherit their original kind.
 */
function extractExportKinds(absPath: string, visited: Set<string> = new Set()): Record<string, BundleInfoExport["kind"]> {
    const cached = exportKindCache.get(absPath);
    if (cached) return cached;
    const map: Record<string, BundleInfoExport["kind"]> = {};
    if (visited.has(absPath) || !existsSync(absPath)) {
        exportKindCache.set(absPath, map);
        return map;
    }
    visited.add(absPath);
    const src = readFileSync(absPath, "utf8");
    for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?function\s*\*?\s*(\w+)/gm)) map[m[1]!] = "function";
    for (const m of src.matchAll(/^\s*export\s+(?:abstract\s+)?class\s+(\w+)/gm)) map[m[1]!] = "class";
    for (const m of src.matchAll(/^\s*export\s+(?:const\s+)?enum\s+(\w+)/gm)) map[m[1]!] = "enum";
    // Match `export const/let/var NAME ... = RHS` without consuming past the line's
    // end — previously the greedy [\s\S]{0,80} capture swallowed subsequent
    // declarations, causing matchAll to skip every other line.
    for (const m of src.matchAll(/^\s*export\s+(?:const|let|var)\s+(\w+)(?:\s*:[^=\r\n]+)?\s*=\s*([^\r\n]{0,200})/gm)) {
        const name = m[1]!;
        const rhs = m[2]!.trimStart();
        const looksLikeFn = /^(async\s+)?function\b/.test(rhs) || /^(async\s+)?\([^)]*\)\s*(?::[^=]+)?=>/.test(rhs) || /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(rhs);
        map[name] = looksLikeFn ? "function" : "const";
    }
    // Parse imports so we can resolve bare `export { X }` lists below.
    const importMap: Record<string, { source: string; origName: string }> = {};
    for (const m of src.matchAll(/^\s*import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gm)) {
        const spec = m[2]!;
        if (!spec.startsWith(".")) continue;
        for (const raw of m[1]!.split(",")) {
            const part = raw.trim().replace(/^type\s+/, "");
            if (!part) continue;
            const asMatch = part.match(/^(\w+)\s+as\s+(\w+)$/);
            const origName = asMatch ? asMatch[1]! : part;
            const localName = asMatch ? asMatch[2]! : part;
            importMap[localName] = { source: spec, origName };
        }
    }
    const resolveSpec = (spec: string): string | null => {
        const baseDir = dirname(absPath);
        const specNoJs = spec.replace(/\.js$/, "");
        for (const c of [specNoJs + ".ts", specNoJs + ".tsx", specNoJs, spec]) {
            const full = resolve(baseDir, c);
            if (existsSync(full)) return full;
        }
        return null;
    };

    // Follow same-package re-exports: `export { A, B as C } from "./foo.js"`
    for (const m of src.matchAll(/^\s*export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gm)) {
        const names = m[1]!;
        const spec = m[2]!;
        if (!spec.startsWith(".")) continue;
        const target = resolveSpec(spec);
        if (!target) continue;
        const targetKinds = extractExportKinds(target, visited);
        for (const raw of names.split(",")) {
            const part = raw.trim();
            if (!part) continue;
            const asMatch = part.match(/^(\w+)\s+as\s+(\w+)$/);
            const sourceName = asMatch ? asMatch[1]! : part;
            const localName = asMatch ? asMatch[2]! : part;
            const kind = targetKinds[sourceName];
            if (kind && !map[localName]) map[localName] = kind;
        }
    }
    // Follow bare `export { A, B as C }` (no `from`) via the import map.
    for (const m of src.matchAll(/^\s*export\s*\{([^}]+)\}\s*;?\s*$/gm)) {
        for (const raw of m[1]!.split(",")) {
            const part = raw.trim();
            if (!part) continue;
            const asMatch = part.match(/^(\w+)\s+as\s+(\w+)$/);
            const localLookup = asMatch ? asMatch[1]! : part;
            const exportName = asMatch ? asMatch[2]! : part;
            if (map[exportName]) continue;
            const imp = importMap[localLookup];
            if (!imp) continue;
            const target = resolveSpec(imp.source);
            if (!target) continue;
            const targetKinds = extractExportKinds(target, visited);
            const kind = targetKinds[imp.origName];
            if (kind) map[exportName] = kind;
        }
    }
    exportKindCache.set(absPath, map);
    return map;
}

/**
 * Write per-scene chunk/module contribution info alongside the bundle output.
 * Consumed by the lab "Bundle" tab to show which .ts files contribute to each
 * chunk (with rendered sizes) and which named exports survived tree-shaking.
 */
function writeBundleInfoToDir(scene: string, result: unknown, infoDir: string, sourceRoot = ROOT): void {
    // Vite build() returns RollupOutput | RollupOutput[] (one per output format).
    // We configure a single ES output, so take the first.
    const output = Array.isArray(result) ? result[0] : result;
    const items = (output as { output?: unknown[] } | undefined)?.output;
    if (!Array.isArray(items)) return;

    const chunks: BundleInfoChunk[] = [];
    for (const item of items) {
        const it = item as {
            type?: string;
            fileName?: string;
            code?: string;
            isEntry?: boolean;
            modules?: Record<string, { renderedLength?: number; renderedExports?: string[] }>;
            map?: SourceMapLike | null;
        };
        if (it.type !== "chunk" || !it.fileName) continue;
        const minifiedBytes = minifiedModuleBytes(it.code ?? "", it.map, sourceRoot);
        const modules: BundleInfoModule[] = [];
        for (const [rawId, m] of Object.entries(it.modules ?? {})) {
            const normalizedId = normalizeModuleId(rawId, sourceRoot);
            // Prefer source-map-attributed minified bytes. Large pure-data modules (e.g.
            // checked-in `*-nme.ts` NME payloads) are emitted as object/string literals for
            // which esbuild produces NO per-token source-map segments, so attribution yields
            // 0 even though the module contributes real bytes. Fall back to Rollup's
            // `renderedLength` (the module's rendered size in the chunk) so such modules are
            // still recorded — otherwise the ignored-module accounting can't subtract them.
            const bytes = minifiedBytes[normalizedId] || m.renderedLength || 0;
            if (bytes <= 0) continue;
            const rawNames = Array.isArray(m.renderedExports) ? [...m.renderedExports].sort() : [];
            // Resolve kinds from the source file on disk (strip any ?query suffix).
            const srcPath = rawId.split("?")[0]!;
            const kinds = srcPath.startsWith("\u0000") ? {} : extractExportKinds(srcPath);
            const exports: BundleInfoExport[] = rawNames.map((name) => ({
                name,
                kind: kinds[name] ?? "unknown",
            }));
            modules.push({ id: normalizedId, bytes, exports });
        }
        modules.sort((a, b) => b.bytes - a.bytes);
        chunks.push({
            file: it.fileName,
            bytes: Buffer.byteLength(it.code ?? "", "utf8"),
            isEntry: !!it.isEntry,
            modules,
        });
    }
    chunks.sort((a, b) => Number(b.isEntry) - Number(a.isEntry) || b.bytes - a.bytes);

    mkdirSync(infoDir, { recursive: true });
    writeFileSync(resolve(infoDir, `${scene}.json`), JSON.stringify({ scene, chunks }, null, 2));
}

export function writeBundleInfo(scene: string, result: unknown): void {
    writeBundleInfoToDir(scene, result, bundleInfoDir, ROOT);
}

const SCENES = process.env.BUNDLE_SCENES ? process.env.BUNDLE_SCENES.split(",") : ALL_SCENES;
// Only scenes with a Babylon.js reference source (lab/src/bjs/<scene>.ts) get a `bjs-` variant.
// Lite-only demos (e.g. the text-renderer scenes 180/181, marked skipParity) have no BJS
// counterpart, so skip them rather than failing to resolve a non-existent entry module.
const BJS_SCENES = process.env.SKIP_BJS ? [] : SCENES.filter((s) => existsSync(resolve(labDir, `src/bjs/${s}.ts`))).map((s) => `bjs-${s}`);

function getAllBundleFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...getAllBundleFiles(fullPath));
        else results.push(fullPath);
    }
    return results;
}

const MIME: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
};

export function startStaticServer(root: string): Promise<{ server: Server; port: number }> {
    const publicDir = join(root, "public");
    return new Promise((res) => {
        const server = createServer((req, resp) => {
            const url = (req.url ?? "/").split("?")[0]!;
            // Try root first (HTML pages), then public/ (bundle JS, assets)
            let filePath = join(root, url === "/" ? "index.html" : url);
            if (!existsSync(filePath)) {
                const publicUrl = url.startsWith("/lite/bundle/") || url.startsWith("/lite/thumbnails/") ? url.slice("/lite".length) : url;
                filePath = join(publicDir, publicUrl);
            }
            if (!existsSync(filePath) && url.startsWith("/lite/reference/lite/")) {
                filePath = resolve(root, "..", url.slice("/lite/".length));
            }
            if (existsSync(filePath) && !filePath.includes("..")) {
                resp.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
                resp.end(readFileSync(filePath));
            } else {
                resp.writeHead(404);
                resp.end();
            }
        });
        server.listen(0, () => {
            const addr = server.address();
            res({ server, port: typeof addr === "object" ? addr!.port : 0 });
        });
    });
}

function elapsed(startMs: number): string {
    return `${((performance.now() - startMs) / 1000).toFixed(1)}s`;
}

/** Strip the no-op `__vitePreload(() => import("chunk"), [])` wrappers that Vite
 *  injects around dynamic imports. Bare and one-export projection callbacks
 *  collapse to `import("chunk")`.
 *
 *  These Lite bundles disable module preload, and the preload helper itself is a
 *  pure passthrough (`baseModule => baseModule()`), so the wrapper and its empty
 *  deps array are semantically dead weight. The helper lives in a separate chunk,
 *  so esbuild can't inline it across the chunk boundary — hence ~6 bytes of
 *  wrapper survive per dynamic import in every chunk. Removing them shrinks every
 *  code-split scene (feature-rich glTF assets carry dozens of these). Applied to
 *  the finalized on-disk output in {@link buildScene} because Vite resolves the
 *  preload form too late for a renderChunk/generateBundle hook to see it. */
export function stripNoopPreloadWrappers(code: string): string {
    return code
        .replace(
            /[\w$]+\(async\(\)=>\{const\{([\w$]+):([\w$]+)\}=await (import\([^()]*\));return\{\1:\2\}\},\[\]\)/g,
            "$3"
        )
        .replace(/[\w$]+\(\s*\(\s*\)\s*=>\s*(import\([^()]*\)(?:\.then\(\s*[\w$]+\s*=>\s*[\w$]+\.[\w$]+\s*\))?)\s*,\s*\[\s*\]\s*\)/g, "$1");
}

function minimalVitePreloadPlugin(): Plugin {
    const id = "\0minimal-vite-preload";
    return {
        name: "minimal-vite-preload",
        enforce: "pre",
        resolveId(source) {
            return source === "vite/preload-helper.js" ? id : null;
        },
        load(source) {
            return source === id ? "export const __vitePreload = (baseModule) => baseModule();" : null;
        },
        transform(_code, source) {
            return source.endsWith("vite/preload-helper.js") ? "export const __vitePreload = (baseModule) => baseModule();" : null;
        },
    };
}

type PackageRequire = ReturnType<typeof createRequire>;

interface VendorRuntime {
    name: string;
    external: (id: string) => boolean;
    imports: Record<string, string>;
    usedByLiteScene: (scene: string, source: string, config: SceneConfigEntry | undefined) => boolean;
    copyFiles: (_require: PackageRequire, vendorDir: string) => void;
}

function hasAny(source: string, needles: readonly string[]): boolean {
    return needles.some((needle) => source.includes(needle));
}

const VENDOR_RUNTIMES: VendorRuntime[] = [
    {
        name: "havok",
        external: (id) => id === "@babylonjs/havok",
        imports: {
            "@babylonjs/havok": "/vendor/havok.js",
        },
        usedByLiteScene: (_scene, source) => source.includes("@babylonjs/havok"),
        copyFiles: (_require, vendorDir) => {
            const havokMain = _require.resolve("@babylonjs/havok");
            const havokSrc = resolve(dirname(dirname(havokMain)), "esm/HavokPhysics_es.js");
            if (existsSync(havokSrc)) {
                writeFileSync(resolve(vendorDir, "havok.js"), readFileSync(havokSrc));
            }
        },
    },
    {
        name: "manifold-3d",
        external: (id) => id === "manifold-3d" || id.startsWith("manifold-3d/"),
        imports: {
            "manifold-3d": "/vendor/manifold-3d/manifold.js",
            "manifold-3d/manifold.wasm?url": "data:text/javascript,export%20default%20%22/vendor/manifold-3d/manifold.wasm%22%3B",
        },
        usedByLiteScene: (_scene, source) => hasAny(source, ["initializeCsg2Async", "createCsg2FromMesh", "createMeshesFromCsg2", "createMeshFromCsg2"]),
        copyFiles: (_require, vendorDir) => {
            const manifoldJsSrc = _require.resolve("manifold-3d/manifold.js");
            const manifoldDir = resolve(vendorDir, "manifold-3d");
            mkdirSync(manifoldDir, { recursive: true });
            writeFileSync(resolve(manifoldDir, "manifold.js"), readFileSync(manifoldJsSrc));
            const manifoldWasmSrc = resolve(dirname(manifoldJsSrc), "manifold.wasm");
            if (existsSync(manifoldWasmSrc)) {
                writeFileSync(resolve(manifoldDir, "manifold.wasm"), readFileSync(manifoldWasmSrc));
            }
        },
    },
    {
        name: "recast-navigation",
        external: (id) => id.startsWith("@recast-navigation/"),
        imports: {
            "@recast-navigation/core": "/vendor/recast-navigation/core.js",
            "@recast-navigation/generators": "/vendor/recast-navigation/generators.js",
            "@recast-navigation/wasm": "/vendor/recast-navigation/wasm-compat.js",
            "@recast-navigation/wasm/wasm": "/vendor/recast-navigation/wasm.js",
        },
        usedByLiteScene: (_scene, source, config) =>
            source.includes("createNavigationPluginAsync") || config?.tags?.includes("navigation") === true || config?.tags?.includes("recast") === true,
        copyFiles: (_require, vendorDir) => {
            const recastDir = resolve(vendorDir, "recast-navigation");
            mkdirSync(recastDir, { recursive: true });
            const coreSrc = _require.resolve("@recast-navigation/core");
            writeFileSync(resolve(recastDir, "core.js"), readFileSync(resolve(dirname(coreSrc), "index.mjs")));
            const gensSrc = _require.resolve("@recast-navigation/generators");
            writeFileSync(resolve(recastDir, "generators.js"), readFileSync(resolve(dirname(gensSrc), "index.mjs")));
            const wasmPkg = dirname(dirname(_require.resolve("@recast-navigation/wasm")));
            writeFileSync(resolve(recastDir, "wasm-compat.js"), readFileSync(resolve(wasmPkg, "dist/recast-navigation.wasm-compat.js")));
            writeFileSync(resolve(recastDir, "wasm.js"), readFileSync(resolve(wasmPkg, "dist/recast-navigation.wasm.js")));
            writeFileSync(resolve(recastDir, "recast-navigation.wasm.wasm"), readFileSync(resolve(wasmPkg, "dist/recast-navigation.wasm.wasm")));
        },
    },
];

export function isLiteBundleExternal(id: string): boolean {
    return VENDOR_RUNTIMES.some((runtime) => runtime.external(id));
}

/** Force certain modules into their own chunks so bundle-size accounting can isolate
 *  them cleanly. Currently used to separate `text-shaper` (a 670 KB vendor shaping
 *  library) so the gzip-bytes accounting can exclude it as a self-contained chunk
 *  matching the ignored-module pattern in `bundle-size-accounting.ts`. Matches both the
 *  source form (`node_modules/text-shaper/…`) and the built-package form, where the lib
 *  build has already pre-bundled it into `build/lib/_chunks/vendor/text-shaper-<hash>.js`. */
function liteManualChunks(id: string): string | undefined {
    const clean = id.replace(/\\/g, "/").split("?")[0]!;
    if (/(?:^|\/)text-shaper[-/]/.test(clean)) {
        return TEXT_SHAPER_CHUNK_NAME;
    }
    return undefined;
}

/** The manual-chunk name {@link liteManualChunks} pins the `text-shaper` vendor
 *  runtime into. Every scene imports the `babylon-lite` barrel, which re-exports the
 *  default text APIs that pull in `text-shaper`; for the ~200 scenes that use no text,
 *  tree-shaking empties that pinned chunk, so Rollup logs a harmless
 *  `Generated an empty chunk: "text-shaper"` (`EMPTY_BUNDLE`) — once per scene. The
 *  empty chunk is never referenced or loaded, so {@link liteBundleOnWarn} silences
 *  exactly that warning while leaving every other Rollup warning intact. */
const TEXT_SHAPER_CHUNK_NAME = "text-shaper";

/** Suppress the expected empty-`text-shaper`-chunk warning (see
 *  {@link TEXT_SHAPER_CHUNK_NAME}); forward all other Rollup warnings unchanged. */
const liteBundleOnWarn: Rollup.WarningHandlerWithDefault = (warning, defaultHandler) => {
    if (warning.code === "EMPTY_BUNDLE") {
        const names = warning.names ?? [];
        const emptyChunkNames = names.length > 0 ? names : [warning.message];
        if (emptyChunkNames.every((entry) => entry.includes(TEXT_SHAPER_CHUNK_NAME))) {
            return;
        }
    }
    defaultHandler(warning);
};

function readLiteSceneSource(scene: string): string {
    try {
        return readFileSync(liteSceneEntry(scene), "utf-8");
    } catch {
        return "";
    }
}

function getLiteSceneVendorRuntimes(scene: string): VendorRuntime[] {
    if (scene.startsWith("bjs-")) return [];
    const source = readLiteSceneSource(scene);
    const config = sceneConfigByName.get(scene);
    return VENDOR_RUNTIMES.filter((runtime) => runtime.usedByLiteScene(scene, source, config));
}

function ensureBundleHtmlImportMap(scene: string): void {
    const runtimes = getLiteSceneVendorRuntimes(scene);
    if (runtimes.length === 0) return;
    const htmlPath = liteHtmlPath(`bundle-${scene}.html`);
    if (!existsSync(htmlPath)) return;

    const imports = Object.assign({}, ...runtimes.map((runtime) => runtime.imports)) as Record<string, string>;
    const importMap = `<script type="importmap">${JSON.stringify({ imports })}</script>`;
    const html = readFileSync(htmlPath, "utf-8");
    const existing = html.match(/(^[ \t]*)<script type="importmap">[\s\S]*?<\/script>/m);
    const next = existing ? html.replace(existing[0], `${existing[1] ?? ""}${importMap}`) : html.replace(/(^[ \t]*)<style>/m, `$1${importMap}\n$1<style>`);
    if (next !== html) {
        writeFileSync(htmlPath, next);
    }
}

function copyVendorRuntimeFiles(): void {
    const vendorDir = resolve(labDir, "public/vendor");
    mkdirSync(vendorDir, { recursive: true });
    const _require = createRequire(resolve(labDir, "package.json"));
    for (const runtime of VENDOR_RUNTIMES) {
        try {
            runtime.copyFiles(_require, vendorDir);
        } catch {
            console.warn(`Could not copy ${runtime.name} vendor runtime; scenes that use it may fail until its package is installed.`);
        }
    }
}

export async function buildLiteSceneBundleInfo(scene: string, sourceRoot: string, infoDir: string): Promise<void> {
    const sourceLabDir = resolve(sourceRoot, "lab");
    const sourceSrcDir = resolve(sourceRoot, "packages/babylon-lite/src");
    const sceneOutDir = resolve(ROOT, ".bundle-size-tmp/master-bundle-info-build", scene);
    rmSync(sceneOutDir, { recursive: true, force: true });

    const buildResult = await build({
        root: sourceLabDir,
        configFile: false,
        base: "./",
        publicDir: false,
        logLevel: "warn",
        plugins: [wgslMinifyPlugin({ mangle: false }), terserPropertyManglePlugin(), minimalVitePreloadPlugin()],
        resolve: {
            // Master-comparison bundle-info resolves `babylon-lite` to the TS SOURCE of an
            // arbitrary master worktree (`sourceRoot`), NOT its `build/lib`: that worktree
            // generally has no built package, and this data only drives the lab's advisory
            // "vs master" size delta (the per-scene ceilings remain the real blocker, and
            // they ARE measured against `build/lib`). Sizes here may therefore differ
            // slightly from a real consumer's, which is acceptable for an advisory baseline.
            alias: {
                "babylon-lite": sourceSrcDir,
            },
            dedupe: ["@babylonjs/core"],
        },
        build: {
            outDir: sceneOutDir,
            emptyOutDir: true,
            target: LITE_BUNDLE_TARGET,
            minify: "esbuild",
            sourcemap: "hidden",
            modulePreload: false,
            rollupOptions: {
                input: { [scene]: liteSceneEntry(scene, sourceLabDir) },
                external: isLiteBundleExternal,
                onwarn: liteBundleOnWarn,
                output: {
                    format: "es",
                    entryFileNames: "[name].js",
                    chunkFileNames: `${scene}-[name]-[hash].js`,
                    banner: NAME_POLYFILL,
                    manualChunks: liteManualChunks,
                },
            },
        },
    });

    writeBundleInfoToDir(scene, buildResult, infoDir, sourceRoot);
    rmSync(sceneOutDir, { recursive: true, force: true });
}

/** Chromium flags for the measurement browser. SwiftShader under CI, or locally when the
 *  `--software` flag is passed; otherwise the real GPU (SwiftShader is far slower, and
 *  several heavy scenes never reach `dataset.ready` under it on Windows).
 *  See `DEVICE_DEPENDENT_NOTE`. */
export function measurementBrowserArgs(): string[] {
    const swiftShaderArgs =
        process.env.CI || softwareRenderRequested()
            ? ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"]
            : [];
    return ["--force-color-profile=srgb", "--enable-unsafe-webgpu", ...swiftShaderArgs];
}

/** `--software` on the command line, or `BUNDLE_SOFTWARE_RENDER=1`. Only an explicit
 *  truthy value counts, so `BUNDLE_SOFTWARE_RENDER=0` disables it as one would expect. */
function softwareRenderRequested(): boolean {
    const env = process.env.BUNDLE_SOFTWARE_RENDER;
    return process.argv.includes("--software") || env === "1" || env === "true";
}

/** Why a few scenes' local numbers are not comparable to the published master baseline.
 *
 *  CI measures under SwiftShader; a developer machine measures on its real GPU. A few
 *  runtime paths branch on device capability and dynamic-import different chunks as a
 *  result — scenes 113/114/115 resolve detailed picking to `picking-detailed-pipeline` on
 *  a real GPU and to `picking-pipeline` under SwiftShader. Their measured chunk set (and
 *  size) therefore depends on the machine, so a local build shows a delta against the
 *  CI-measured baseline for scenes it never touched. That delta is noise, not a
 *  regression; the run logs this note so it is not mistaken for one.
 *
 *  Forcing SwiftShader for the whole build was tried and rejected: on Windows the heavy
 *  IBL scenes never reach `dataset.ready` under it. Restricting the run to the flagged
 *  scenes is the canonical way to reproduce CI's numbers for them:
 *
 *      pnpm build:bundle-manifest:device
 *
 *  That command needs a working SwiftShader WebGPU stack — reliable on the Linux CI image,
 *  flaky-to-unusable on Windows, where these scenes also time out. On Windows, treat CI's
 *  measurement as the authoritative one for these three. */
const DEVICE_DEPENDENT_NOTE = "device-dependent chunk set — differs from the CI-measured baseline (reproduce CI with: pnpm build:bundle-manifest:device)";

/** A scene with less than this much room under its ceiling is reported after a build: at
 *  that margin the next shared-path change lands on it, and finding that out from CI costs
 *  ~35 minutes. */
const TIGHT_HEADROOM_BYTES = 256;
/** Cap the tight-headroom list so a build's output stays readable; the rest are counted. */
const TIGHT_HEADROOM_LIST_LIMIT = 10;

export async function buildBundleScenes(): Promise<void> {
    const t0 = performance.now();
    // Scenes are bundled against the built `build/lib` tree by default; old baseline
    // worktrees can opt into TS-source fallback via LITE_BUNDLE_ALLOW_SRC_FALLBACK=true.
    const liteAliasDir = resolveLiteAliasDir();
    const requestedSceneNames = normalizeSceneSelection(parseSceneSelectionArg());
    const scenesToBuild = selectRequestedScenes(SCENES, requestedSceneNames);
    const bjsScenesRequested = selectRequestedScenes(BJS_SCENES, requestedSceneNames);
    const knownSceneNames = new Set<string>([...SCENES, ...BJS_SCENES]);
    if (requestedSceneNames) {
        const unknown = [...requestedSceneNames].filter((scene) => !knownSceneNames.has(scene));
        if (unknown.length > 0) {
            throw new Error(`Unknown bundle scene(s): ${unknown.join(", ")}.`);
        }
    }
    // Do NOT wipe outDir — keep existing data live in the lab tab during the build.
    // Each scene is updated atomically (new files written, stale old chunks removed).
    mkdirSync(outDir, { recursive: true });
    await writeMasterBundleManifest();
    for (const scene of scenesToBuild) {
        ensureBundleHtmlImportMap(scene);
    }

    // ── 1. Build all scenes ──────────────────────────────────────────────
    /** Modules that must keep side effects (they patch prototypes via bare import). */
    const BJS_SIDE_EFFECT_MODULES = ["animatable", "thinInstanceMesh"];
    function isBjsSideEffectModule(id: string): boolean {
        return BJS_SIDE_EFFECT_MODULES.some((m) => id.includes(m));
    }

    /** Override sideEffects for @babylonjs packages so Rollup can tree-shake. */
    function bjsSideEffectsFalsePlugin(): Plugin {
        return {
            name: "bjs-side-effects-false",
            resolveId: {
                order: "pre" as const,
                async handler(source, importer, options) {
                    if (!source.includes("@babylonjs")) return null;
                    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
                    if (!resolved) return null;
                    if (isBjsSideEffectModule(source)) return { ...resolved, moduleSideEffects: true };
                    return { ...resolved, moduleSideEffects: false };
                },
            },
        };
    }

    function minimalVitePreloadPlugin(): Plugin {
        const id = "\0minimal-vite-preload";
        return {
            name: "minimal-vite-preload",
            enforce: "pre",
            resolveId(source) {
                return source === "vite/preload-helper.js" ? id : null;
            },
            load(source) {
                return source === id ? "export const __vitePreload = (baseModule) => baseModule();" : null;
            },
            transform(_code, source) {
                return source.endsWith("vite/preload-helper.js") ? "export const __vitePreload = (baseModule) => baseModule();" : null;
            },
        };
    }

    async function buildScene(scene: string) {
        const sceneOutDir = resolve(outDir, scene);
        const isBjs = scene.startsWith("bjs-");

        const buildResult = await build({
            root: labDir,
            configFile: false,
            base: "./",
            publicDir: false,
            logLevel: "warn",
            plugins: isBjs ? [bjsSideEffectsFalsePlugin()] : [wgslMinifyPlugin({ mangle: false }), terserPropertyManglePlugin(), minimalVitePreloadPlugin()],
            resolve: {
                // Resolve `babylon-lite` to the built `build/lib` tree (NOT the TS source)
                // so the measured bundle reflects exactly what a consumer of the published
                // package gets. Using the directory (not index.js) also preserves internal,
                // lab-only deep imports that are intentionally absent from the public package
                // export map. `build:lib` must run first unless explicit source fallback is
                // enabled for legacy baselines.
                alias: {
                    "babylon-lite": liteAliasDir,
                },
                dedupe: ["@babylonjs/core"],
            },
            build: {
                outDir: sceneOutDir,
                emptyOutDir: true,
                ...(!isBjs && { target: LITE_BUNDLE_TARGET }),
                minify: "esbuild",
                sourcemap: "hidden",
                modulePreload: false,
                rollupOptions: {
                    input: { [scene]: isBjs ? bjsSceneEntry(scene) : liteSceneEntry(scene) },
                    // Exclude third-party WASM runtimes from Lite bundles so the
                    // bundle-size metric reflects only first-party Lite engine code.
                    ...(!isBjs && { external: isLiteBundleExternal, onwarn: liteBundleOnWarn }),
                    output: {
                        format: "es",
                        entryFileNames: "[name].js",
                        chunkFileNames: `${scene}-[name]-[hash].js`,
                        banner: NAME_POLYFILL,
                        ...(!isBjs && { manualChunks: liteManualChunks }),
                    },
                    ...(isBjs && {
                        treeshake: {
                            moduleSideEffects: (id: string) => !id.includes("@babylonjs") || isBjsSideEffectModule(id),
                        },
                    }),
                },
                ...(isBjs && { target: "esnext" }),
            },
        });

        // Extract per-chunk module contribution info from the Rollup output so the
        // lab UI can show which .ts files ended up in each chunk (with rendered sizes).
        writeBundleInfo(scene, buildResult);

        // Atomically replace this scene's files in outDir:
        // 1. Write all new files (overwriting existing ones).
        // 2. Remove any stale old chunk files that didn't appear in the new build.
        const bundleFiles = getAllBundleFiles(sceneOutDir);
        const newNames = new Set<string>();
        for (const f of bundleFiles) {
            const name = f.substring(sceneOutDir.length + 1).replace(/\\/g, "/");
            if (name.endsWith(".map")) continue;
            newNames.add(name);
            const dest = resolve(outDir, name);
            mkdirSync(dirname(dest), { recursive: true });
            if (!isBjs && name.endsWith(".js")) {
                // Vite wraps every dynamic import in a no-op `__vitePreload(()=>import(x),[])`
                // helper. With modulePreload disabled the wrapper does nothing, so strip it
                // back to a bare `import(x)` to shave ~6 bytes per dynamic import across all
                // chunks. Done on the finalized on-disk output (Vite resolves the preload
                // form too late for a renderChunk/generateBundle hook to see it).
                writeFileSync(dest, stripNoopPreloadWrappers(readFileSync(f, "utf-8")), "utf-8");
            } else {
                writeFileSync(dest, readFileSync(f));
            }
        }
        // Remove stale files from a previous build of this scene (chunk hash may differ).
        for (const existing of readdirSync(outDir)) {
            if ((existing === `${scene}.js` || existing.startsWith(`${scene}-`)) && !newNames.has(existing)) {
                rmSync(resolve(outDir, existing));
            }
        }
        rmSync(sceneOutDir, { recursive: true, force: true });
    }

    // Load existing per-scene manifest files to check for cached BJS sizes.
    const existingManifest: BundleManifest = readCurrentBundleManifest();

    // Only build BJS scenes whose sizes aren't already cached in the manifest
    const bjsScenesToBuild = requestedSceneNames
        ? bjsScenesRequested
        : BJS_SCENES.filter((bjsScene) => {
              const liteScene = bjsScene.replace("bjs-", "");
              const cached = existingManifest[liteScene];
              if (cached?.bjsRawKB == null) {
                  return true;
              }
              const sourcePath = bjsSceneEntry(liteScene);
              const bundlePath = resolve(outDir, `${bjsScene}.js`);
              if (!existsSync(bundlePath)) {
                  return true;
              }
              return statSync(sourcePath).mtimeMs > statSync(bundlePath).mtimeMs;
          });

    // Build sequentially — parallel Vite build() calls within the same process
    // cause race conditions (0-byte chunk files, stale measurements on Windows).
    const totalScenes = scenesToBuild.length + bjsScenesToBuild.length;
    let built = 0;
    for (const scene of scenesToBuild) {
        built++;
        const tScene = performance.now();
        console.log(`[${built}/${totalScenes}] Building ${scene}...`);
        await buildScene(scene);
        console.log(`[${built}/${totalScenes}] ✓ ${scene} (${elapsed(tScene)}, total ${elapsed(t0)})`);
    }
    if (bjsScenesToBuild.length < BJS_SCENES.length) {
        console.log(`  Skipping ${BJS_SCENES.length - bjsScenesToBuild.length} BJS scenes (sizes cached in manifest)`);
    }
    for (const scene of bjsScenesToBuild) {
        built++;
        const tScene = performance.now();
        console.log(`[${built}/${totalScenes}] Building ${scene}...`);
        await buildScene(scene);
        console.log(`[${built}/${totalScenes}] ✓ ${scene} (${elapsed(tScene)}, total ${elapsed(t0)})`);
    }

    console.log(`\nAll ${totalScenes} scenes built in ${elapsed(t0)}`);

    copyVendorRuntimeFiles();
    if (process.env.SKIP_MEASURE) {
        console.log("Skipping live size measurement (SKIP_MEASURE is set)");
        console.log(`✓ Bundle scenes built to ${outDir} (total ${elapsed(t0)})`);
        return;
    }
    const tMeasure = performance.now();
    const manifest = await measureLiveSizes(scenesToBuild, bjsScenesToBuild, requestedSceneNames == null);
    console.log(`Live measurement completed in ${elapsed(tMeasure)}`);

    console.log("\n=== Per-scene bundle sizes (live runtime measurement) ===");
    for (const scene of scenesToBuild) {
        const s = manifest[scene];
        if (s) {
            let line = `  ${scene}: ${s.rawKB} KB raw, ${s.gzipKB} KB gzip`;
            if (s.bjsRawKB != null) line += `  |  BJS: ${s.bjsRawKB} KB raw, ${s.bjsGzipKB} KB gzip`;
            console.log(line);
        }
    }
    reportCeilingHeadroom(scenesToBuild, manifest);
    if (process.exitCode) {
        console.error(`✘ Bundle scenes built to ${outDir}, but a ceiling was exceeded (total ${elapsed(t0)})`);
        return;
    }
    console.log(`✓ Bundle scenes + manifest built to ${outDir} (total ${elapsed(t0)})`);
}

/**
 * Report each measured scene against its `scene-config.json` ceiling, in BYTES.
 *
 * `rawKB` is rounded to 0.1 KB, so a scene sitting exactly at its ceiling can overflow by
 * a few bytes while the printed size still reads the same value — the overflow then only
 * surfaces in CI's bundle-size job, ~35 minutes later.
 * Comparing exact bytes here surfaces it immediately, and listing the tightest scenes makes
 * a zero-margin scene visible *before* it is the thing that breaks someone else's PR.
 */
function reportCeilingHeadroom(scenes: readonly string[], manifest: Record<string, BundleManifestEntry>): void {
    const over: string[] = [];
    const tight: { scene: string; headroom: number; ceilingKB: number }[] = [];

    for (const scene of scenes) {
        const measured = manifest[scene]?.rawBytes;
        const config = sceneConfigByName.get(scene);
        const ceilingKB = config?.maxRawKB;
        // Honour the same opt-out as the ceiling test in bundle-size.spec.ts.
        if (measured == null || ceilingKB == null || config?.skipBundleSize) {
            continue;
        }
        const ceilingBytes = ceilingKB * 1024;
        // Compare before rounding: a ceiling like 92.2 KB is 94412.8 bytes, so 94413 bytes is
        // over by 0.2 — which `Math.round` would turn into `-0` and wave through.
        if (measured > ceilingBytes) {
            over.push(`  ${scene}: ${(measured / 1024).toFixed(3)} KB exceeds ceiling ${ceilingKB} KB by ${Math.ceil(measured - ceilingBytes)} bytes`);
        } else {
            const headroom = Math.floor(ceilingBytes - measured);
            if (headroom < TIGHT_HEADROOM_BYTES) {
                tight.push({ scene, headroom, ceilingKB });
            }
        }
    }

    if (tight.length > 0) {
        tight.sort((a, b) => a.headroom - b.headroom);
        const shown = tight.slice(0, TIGHT_HEADROOM_LIST_LIMIT).map((t) => `  ${t.scene}: ${t.headroom} B below its ${t.ceilingKB} KB ceiling`);
        const more = tight.length > shown.length ? `\n  … and ${tight.length - shown.length} more under ${TIGHT_HEADROOM_BYTES} B` : "";
        console.log(`\n⚠ ${tight.length} scene(s) with little headroom — a shared-path change may push them over:\n${shown.join("\n")}${more}`);
    }
    if (over.length > 0) {
        console.error(`\n✘ Bundle-size ceiling exceeded (exact bytes; scene-config.json maxRawKB):\n${over.join("\n")}`);
        console.error(`\nRaising a ceiling requires explicit user approval — see GUIDANCE.md.`);
        process.exitCode = 1;
    }
}

/**
 * Start a temporary static server, launch a headless browser, load each
 * bundle-sceneN.html, and measure only the /bundle/*.js bytes that are
 * actually fetched at runtime.
 */
/** How many times to attempt measuring a single Lite scene before giving up. */
const LITE_MEASURE_ATTEMPTS = 3;

/** Default budget for a Lite scene to reach its `dataset.ready` signal. */
const READY_TIMEOUT_MS_DEFAULT = 50_000;

/**
 * Per-scene overrides for the ready-timeout.
 *
 * A few scenes perform compute-heavy GPU work that is near-instant on real
 * hardware but dramatically slower under CI's software WebGPU (SwiftShader).
 * scene129 (Gaussian Splatting + GPU picking) combines a GS radix-sort compute
 * pass with a GPU→CPU picking readback (`pickAsync` → buffer `mapAsync`), which
 * SwiftShader executes far slower than a real adapter. It renders in ~2s on a
 * real GPU but does not reliably reach `dataset.ready` within the 50s default
 * under SwiftShader, so the bundle measurement flakes with the identical
 * "did not become ready (timed out after 50s …)" error across unrelated PRs.
 *
 * scene164 (device-lost recovery) is slow for a related but distinct reason: it is
 * the one scene that deliberately destroys the WebGPU device and rebuilds the whole
 * resource graph — environment cubemap mips, BRDF LUT, every material texture, meshes,
 * skeletons, morph targets and the ESM shadow pipelines — and only signals `ready`
 * after rendering settled post-recovery frames. Every frame it draws re-renders a
 * 1024² ESM shadow map (`forceRefreshEveryFrame`, required so the map tracks the
 * pinned pose) for a skinned and morphed caster, so it draws far more expensive
 * frames than a typical scene, which reaches `ready` after a handful. `dataset.ready`
 * is withheld until after recovery on purpose — setting it earlier would exclude the
 * entire recovery path from this scene's recorded size — so that work cannot be moved
 * outside the measured window.
 *
 * Recording a size only once the scene renders is intentional (the render
 * pipeline's lazy chunks load on first render), so the right fix is a larger
 * budget for these scenes rather than measuring a truncated bundle. We grant the
 * same 150s the parity spec already allows for scene129; a genuinely-broken
 * scene still fails loudly, just after a longer wait.
 */
const READY_TIMEOUT_OVERRIDES_MS: Readonly<Record<string, number>> = {
    scene129: 150_000,
    scene164: 150_000,
};

function readyTimeoutForScene(scene: string): number {
    return READY_TIMEOUT_OVERRIDES_MS[scene] ?? READY_TIMEOUT_MS_DEFAULT;
}

/**
 * Measure a Lite scene, retrying on failure. A Lite scene that never reaches its
 * `dataset.ready` signal (e.g. a transient failure or rate-limit fetching a large
 * multi-file remote asset such as Sponza's ~70 files in CI) would otherwise be
 * silently under-counted: the render pipeline's lazily-imported chunks only load
 * once the scene renders. `measurePage(..., requireReady=true)` rejects such a
 * measurement rather than recording a truncated size, so we retry a few times to
 * absorb transient network flakiness before failing the build loudly.
 */
async function measureLiteSceneWithRetry(
    browser: any,
    port: number,
    scene: string
): Promise<{ rawKB: number; rawBytes: number; gzipKB: number; ignoredRawKB: number; chunks: string[] }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= LITE_MEASURE_ATTEMPTS; attempt++) {
        try {
            return await measurePage(browser, port, scene, `lite/bundle-${scene}.html`, "/bundle/", true, readyTimeoutForScene(scene));
        } catch (err) {
            lastError = err;
            console.warn(`  ${scene}: measurement attempt ${attempt}/${LITE_MEASURE_ATTEMPTS} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    throw new Error(
        `Failed to measure ${scene} after ${LITE_MEASURE_ATTEMPTS} attempts. This usually indicates a transient failure ` +
            `(e.g. rate-limit) fetching a remote asset during measurement, which would truncate the bundle. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
}

async function measureLiveSizes(liteScenes: readonly string[], bjsScenes: readonly string[], pruneManifest = true): Promise<BundleManifest> {
    const { chromium } = await import("@playwright/test");
    const { server, port } = await startStaticServer(labDir);

    // Seed from any existing per-scene manifest files so subset builds preserve
    // other scenes' entries and the live UI can refresh mid-build.
    const manifest: BundleManifest = readCurrentBundleManifest();

    // Persist a single scene's per-scene file, then refresh the generated
    // aggregate `manifest.json` that runtime consumers (lab UI, tests) read.
    function flushScene(scene: string): void {
        const entry = manifest[scene];
        if (entry) writePerSceneManifest(scene, entry);
        writeAggregateBundleManifest(manifest);
    }

    const deviceDependent = (scene: string): boolean => !!sceneConfigByName.get(scene)?.deviceDependentChunks && !process.env.CI && !softwareRenderRequested();

    try {
        const tBrowser = performance.now();
        console.log("Launching measurement browser...");
        const browser = await chromium.launch({ channel: "chrome", headless: true, args: measurementBrowserArgs() });
        console.log(`Browser launched in ${elapsed(tBrowser)}`);

        // Measure Lite scenes (write after each), retrying transient failures.
        for (const scene of liteScenes) {
            const tPage = performance.now();
            const { rawKB, rawBytes, gzipKB, ignoredRawKB, chunks } = await measureLiteSceneWithRetry(browser, port, scene);
            manifest[scene] = { ...manifest[scene], rawKB, rawBytes, gzipKB, ignoredRawKB, runtimeChunks: chunks };
            flushScene(scene);
            const ignored = ignoredRawKB > 0 ? `, ignored ${ignoredRawKB} KB raw ${IGNORED_BUNDLE_MODULE_PATTERN}` : "";
            const note = deviceDependent(scene) ? ` — ${DEVICE_DEPENDENT_NOTE}` : "";
            console.log(`  measured ${scene}: ${rawKB} KB raw, ${gzipKB} KB gzip${ignored} (${elapsed(tPage)})${note}`);
        }

        // Measure BJS scenes — skip if sizes already cached in manifest
        for (const bjsScene of bjsScenes) {
            const liteScene = bjsScene.replace("bjs-", "");
            if (manifest[liteScene]?.bjsRawKB != null) {
                console.log(`  ${bjsScene}: ${manifest[liteScene]!.bjsRawKB} KB raw, ${manifest[liteScene]!.bjsGzipKB} KB gzip (cached)`);
                continue;
            }
            const tPage = performance.now();
            let rawKB: number;
            let gzipKB: number;
            try {
                ({ rawKB, gzipKB } = await measurePage(browser, port, bjsScene, `lite/bundle-${bjsScene}.html`, "/bundle/"));
            } catch (err) {
                console.warn(`  ${bjsScene}: skipped BJS measurement (${err instanceof Error ? err.message : String(err)})`);
                break;
            }
            if (manifest[liteScene]) {
                manifest[liteScene].bjsRawKB = rawKB;
                manifest[liteScene].bjsGzipKB = gzipKB;
                flushScene(liteScene);
            }
            console.log(`  measured ${bjsScene}: ${rawKB} KB raw, ${gzipKB} KB gzip (${elapsed(tPage)})`);
        }

        await browser.close();
    } finally {
        server.close();
    }

    if (pruneManifest) {
        const currentScenes = new Set(liteScenes);
        for (const scene of Object.keys(manifest)) {
            if (!currentScenes.has(scene)) {
                delete manifest[scene];
                rmSync(perSceneManifestPath(scene), { force: true });
            }
        }
        writeAggregateBundleManifest(manifest);
    }

    return manifest;
}

/**
 * On-disk cache for remote scene assets fetched during measurement.
 *
 * Bundle-size measurement loads each scene in a headless browser and counts the
 * JS chunks it fetches. Many scenes pull models/textures/environments from remote
 * hosts (assets.babylonjs.com, playground.babylonjs.com, cdn.jsdelivr.net, …).
 * A scene's render-pipeline chunks are dynamic imports that load only once the
 * scene renders, so any remote asset that fails to fetch would prevent the scene
 * from rendering and truncate its measured bundle. With ~230 remote requests
 * across ~10 hosts per run, transient failures/rate-limits are near-certain over
 * time and make measurement non-deterministic.
 *
 * We intercept every non-localhost request in the measurement browser and serve
 * it from this cache: on a miss we fetch from the origin with PER-REQUEST retry
 * (far more robust than reloading the whole scene) and persist the bytes; on a
 * hit we serve from disk with no network at all. This makes measurement
 * deterministic and lets CI warm the cache once (via BUNDLE_ASSET_CACHE_DIR).
 * If an asset is genuinely unfetchable after retries the request is aborted, the
 * scene fails to become ready, and the caller fails loudly — bundle size is never
 * recorded from a truncated load.
 */
const ASSET_CACHE_DIR = process.env.BUNDLE_ASSET_CACHE_DIR ? resolve(process.env.BUNDLE_ASSET_CACHE_DIR) : resolve(ROOT, ".bundle-asset-cache");
const ASSET_FETCH_ATTEMPTS = 4;

interface CachedAsset {
    status: number;
    contentType: string;
    body: Buffer;
}

// De-dupe concurrent/repeat requests for the same URL within a single run so an
// asset shared across scenes is fetched at most once. Cleared on failure so a
// later scene can retry.
const assetMemCache = new Map<string, Promise<CachedAsset>>();

function assetCacheKey(url: string): string {
    return createHash("sha256").update(url).digest("hex");
}

async function fetchAssetWithRetry(url: string): Promise<CachedAsset> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= ASSET_FETCH_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(url, { redirect: "follow" });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status} ${res.statusText}`);
            }
            const body = Buffer.from(await res.arrayBuffer());
            return { status: res.status, contentType: res.headers.get("content-type") ?? "application/octet-stream", body };
        } catch (err) {
            lastErr = err;
            if (attempt < ASSET_FETCH_ATTEMPTS) {
                await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
            }
        }
    }
    throw new Error(`asset fetch failed after ${ASSET_FETCH_ATTEMPTS} attempts: ${url} — ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

async function getCachedAsset(url: string): Promise<CachedAsset> {
    const inflight = assetMemCache.get(url);
    if (inflight) {
        return inflight;
    }
    const load = (async (): Promise<CachedAsset> => {
        const key = assetCacheKey(url);
        const bodyPath = resolve(ASSET_CACHE_DIR, key);
        const metaPath = resolve(ASSET_CACHE_DIR, `${key}.json`);
        if (!process.env.BUNDLE_ASSET_CACHE_DISABLE && existsSync(bodyPath) && existsSync(metaPath)) {
            const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { status: number; contentType: string };
            return { status: meta.status, contentType: meta.contentType, body: readFileSync(bodyPath) };
        }
        const asset = await fetchAssetWithRetry(url);
        console.log(`    [asset-cache miss] fetched ${url}`);
        mkdirSync(ASSET_CACHE_DIR, { recursive: true });
        // Atomic write (tmp + rename) so a crash mid-write can't leave a partial body.
        const tmpBody = `${bodyPath}.tmp${process.pid}`;
        writeFileSync(tmpBody, asset.body);
        renameSync(tmpBody, bodyPath);
        writeFileSync(metaPath, JSON.stringify({ url, status: asset.status, contentType: asset.contentType }));
        return asset;
    })();
    assetMemCache.set(url, load);
    load.catch(() => assetMemCache.delete(url));
    return load;
}

/**
 * Route every request the measurement page makes: localhost (the bundle server)
 * passes through untouched so JS chunks are measured normally; every remote asset
 * is served from {@link getCachedAsset}. Aborts on unfetchable assets so the scene
 * fails loudly rather than measuring a truncated bundle.
 */
async function installAssetCacheRoute(page: any, port: number): Promise<void> {
    const localBase = `http://localhost:${port}`;
    await page.route("**/*", async (route: any) => {
        const url = route.request().url();
        if (url.startsWith(localBase) || (!url.startsWith("http://") && !url.startsWith("https://"))) {
            await route.continue().catch(() => {});
            return;
        }
        try {
            const asset = await getCachedAsset(url);
            await route.fulfill({
                status: asset.status,
                headers: {
                    "content-type": asset.contentType,
                    // Faithfully permissive CORS: the real hosts already allow these cross-origin
                    // asset fetches (that's why scenes load today), so echo an allow-all header
                    // rather than the origin's specific one.
                    "access-control-allow-origin": "*",
                    "cache-control": "public, max-age=31536000",
                },
                body: asset.body,
            });
        } catch {
            // Unfetchable after retries — abort so the scene fails to render and the
            // caller's requireReady guard turns it into a loud, non-silent failure.
            await route.abort().catch(() => {});
        }
    });
}

export async function measurePage(
    browser: any,
    port: number,
    scene: string,
    htmlFile: string,
    bundlePath: string,
    requireReady = false,
    readyTimeoutMs = READY_TIMEOUT_MS_DEFAULT
): Promise<{ rawKB: number; rawBytes: number; gzipKB: number; ignoredRawKB: number; chunks: string[] }> {
    const page = await browser.newPage();
    const jsPayloads: RuntimeJsPayload[] = [];
    const chunkFiles: string[] = [];
    const responseReads: Promise<void>[] = [];
    const responseReadErrors: unknown[] = [];

    page.on("response", (resp: any) => {
        const url = resp.url();
        if (url.includes(bundlePath) && url.endsWith(".js") && resp.ok()) {
            const read = (async () => {
                const idx = url.indexOf(bundlePath);
                const fileName = url.slice(idx + bundlePath.length).split("?")[0];
                const body = await resp.body();
                jsPayloads.push({ file: fileName, body });
                chunkFiles.push(fileName);
            })().catch((err: unknown) => {
                responseReadErrors.push(err);
            });
            responseReads.push(read);
        }
    });

    await installAssetCacheRoute(page, port);
    await page.goto(`http://localhost:${port}/${htmlFile}`);
    // Resolve as soon as the scene finishes (dataset.ready) OR reports a fatal
    // error (dataset.error), so a fast-failing scene doesn't burn the full timeout.
    let notReadyReason: string | undefined;
    try {
        await page.waitForFunction(
            () => {
                const c = document.querySelector("canvas");
                return c?.dataset.ready === "true" || c?.dataset.error != null;
            },
            undefined,
            { timeout: readyTimeoutMs }
        );
        notReadyReason = await page.evaluate(() => {
            const c = document.querySelector("canvas");
            if (c?.dataset.ready === "true") return undefined;
            return c?.dataset.error ?? "canvas reported neither ready nor error";
        });
    } catch (err) {
        // Only treat a genuine Playwright timeout as "not ready"; any other error
        // (page crash, execution context destroyed, navigation failure, …) is a
        // real failure that must propagate instead of masquerading as a timeout.
        if (!(err instanceof Error) || err.name !== "TimeoutError") {
            await page.close();
            throw err;
        }
        // waitForFunction timed out: the scene set neither ready nor error.
        notReadyReason = `timed out after ${Math.round(readyTimeoutMs / 1000)}s waiting for canvas ready/error signal`;
    }

    // For Lite scenes (requireReady), a scene that never rendered would under-count
    // its bundle: the render pipeline's lazily-imported chunks (pbr-renderable,
    // ibl-fragment, generate-mipmaps, …) only load once the scene renders, so a
    // failed remote-asset fetch would silently produce a truncated size. Reject the
    // measurement so the caller can retry / fail loudly instead of recording a bogus
    // decrease. BJS pages (requireReady=false) may legitimately never reach ready
    // without a real GPU, so they keep the lenient "measure whatever loaded" behavior.
    if (requireReady && notReadyReason !== undefined) {
        await page.close();
        throw new Error(`measurePage: scene "${scene}" did not become ready (${notReadyReason}); refusing to record a truncated bundle.`);
    }

    await Promise.all(responseReads);
    if (responseReadErrors.length > 0) {
        throw responseReadErrors[0];
    }
    const summary = summarizeRuntimeBundle(jsPayloads, bundleInfoDir, scene);
    const ignoredRawKB = bytesToRoundedKB(summary.ignoredRawBytes);
    const rawBytes = summary.rawBytes;

    await page.close();
    return {
        rawKB: bytesToRoundedKB(rawBytes),
        rawBytes,
        gzipKB: bytesToRoundedKB(summary.gzipBytes),
        ignoredRawKB,
        chunks: Array.from(new Set(chunkFiles)).sort(),
    };
}
