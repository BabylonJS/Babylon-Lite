/**
 * Shared harness for the bundler build tests (`bundling-*.test.ts`, `treeshake-*.test.ts`).
 *
 * All four tests exercise the SHIPPED module-granular `build/lib` output (the tree a real npm
 * consumer imports via the package's `main`/`module` -> `./lib/index.js`). Keeping every helper
 * here means the vendor-external list, module enumeration, and bundler invocation live in one place
 * and never drift between the Rollup and webpack ports.
 *
 * Why `build/lib` (not `src`): it is exactly what consumers bundle, and it is plain ESM `.js` (one
 * file per source module), so webpack can bundle it with no TypeScript loader and every module —
 * including dynamic-`import()`-only ones like `mesh/csg2.js` — is individually reachable for the
 * "import every module" enumeration.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const ROOT = resolve(__dirname, "../../..");
export const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite");
export const BUILD_LIB_DIR = resolve(PACKAGE_DIR, "build/lib");
export const LIB_ENTRY = resolve(BUILD_LIB_DIR, "index.js");
const PACKAGE_JSON = resolve(PACKAGE_DIR, "package.json");
const VITE_JS = resolve(PACKAGE_DIR, "node_modules/vite/bin/vite.js");

/** A real side effect a bundler must always keep, so "nothing survived" reads as a recognisable
 *  non-empty string rather than "" (which a misconfigured bundler could emit for the wrong reason). */
export const SENTINEL = 'console.log("Babylon Lite bundler harness sentinel");';

/** Bundled third-party runtimes, derived from the package's declared `dependencies` so this list
 *  never drifts from what actually ships. In `build/lib` these live in `_chunks/vendor/*.js` and are
 *  reached only by relative import; consumers get them as isolated chunks. The bundler tests treat
 *  them as external so they validate only OUR first-party module graph (fast, and vendor init is out
 *  of our control). The wasm assets they reference are external for the same reason. */
const DECLARED_DEPENDENCIES = Object.keys((JSON.parse(readFileSync(PACKAGE_JSON, "utf-8")) as { dependencies?: Record<string, string> }).dependencies ?? {});

const NODE_BUILTIN = /^(node:)?(module|fs|path|url|os|crypto|worker_threads|util|stream|events|buffer)$/;

/** True for a request the bundler tests treat as external: a bundled vendor chunk, a wasm/`?url`
 *  asset, a bare vendor specifier, or a Node builtin. */
export function isExternalRequest(request: string): boolean {
    if (!request) {
        return false;
    }
    if (/[\\/]_chunks[\\/]vendor[\\/]/.test(request)) {
        return true;
    }
    if (/\.wasm(\?|$)/.test(request) || /\?url(&|$)/.test(request) || /\?worker(&|$)/.test(request)) {
        return true;
    }
    if (NODE_BUILTIN.test(request)) {
        return true;
    }
    return DECLARED_DEPENDENCIES.some((dep) => request === dep || request.startsWith(`${dep}/`));
}

/** Warnings that are inherent to bundling a large library and say nothing about our code health.
 *  Everything else must be zero for the bundling tests to pass. */
export const BENIGN_WARNING_RE = /asset size limit|entrypoint size limit|performance recommendations|exceed the recommended size limit|bigger than 244 KiB|Circular dependenc/i;

let _libBuilt = false;

/** Newest mtime (ms) among the package's TypeScript sources — used to decide whether the existing
 *  `build/lib` output is already up to date. */
function newestSrcMtime(): number {
    let newest = 0;
    const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) {
                walk(p);
            } else if (/\.ts$/.test(e.name)) {
                const m = statSync(p).mtimeMs;
                if (m > newest) {
                    newest = m;
                }
            }
        }
    };
    walk(resolve(PACKAGE_DIR, "src"));
    return newest;
}

/** Build the package's `build/lib` output once per test process, and only when it is missing or
 *  stale relative to `src`. Skipping a fresh build both saves time and avoids clobbering `build/lib`
 *  while a sibling build-test file is reading it (the build-test project runs files sequentially —
 *  see `vitest.config.ts` — so this check means only the first file actually rebuilds). Mirrors
 *  `public-api-types.test.ts`: invoked via the current node executable + vite's JS entry so it does
 *  not depend on PATH. */
export function ensureLibBuilt(): void {
    if (_libBuilt) {
        return;
    }
    const fresh = existsSync(LIB_ENTRY) && statSync(LIB_ENTRY).mtimeMs >= newestSrcMtime();
    if (!fresh) {
        const built = spawnSync(process.execPath, [VITE_JS, "build", "--mode", "lib"], {
            cwd: PACKAGE_DIR,
            encoding: "utf-8",
        });
        if (built.status !== 0) {
            throw new Error(`babylon-lite build (--mode lib) failed:\n${built.stdout ?? ""}${built.stderr ?? ""}`);
        }
    }
    _libBuilt = true;
}

/** Every first-party `build/lib` module a consumer could reach (statically OR via dynamic
 *  `import()`). Excludes the vendor chunks, sourcemaps, and `*-worker.js` entries (which carry a
 *  top-level `self.onmessage = …` by design and are only ever loaded via `?worker`). */
export function enumerateLibModules(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === "_chunks") {
                    continue;
                }
                walk(p);
            } else if (/\.js$/.test(e.name) && !/-worker\.js$/.test(e.name)) {
                out.push(p);
            }
        }
    };
    walk(BUILD_LIB_DIR);
    return out;
}

// ─── Temp entry management ─────────────────────────────────────────────────

const _tempDirs: string[] = [];

/** Create a temp dir with an entry file containing `source`; returns the entry path. */
export function makeTempEntry(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), "lite-bundler-"));
    _tempDirs.push(dir);
    const entry = join(dir, "entry.mjs");
    writeFileSync(entry, source);
    return entry;
}

/** Remove all temp dirs created during the run. Call from `afterAll`. */
export function cleanupTempDirs(): void {
    for (const dir of _tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** An entry that bare-imports the built package barrel plus the sentinel. */
export const barrelEntrySource = (): string => `import ${JSON.stringify(LIB_ENTRY)};\n${SENTINEL}\n`;

/** An entry that statically imports EVERY first-party module (forces dynamic-only modules such as
 *  `mesh/csg2.js` into the parsed graph) plus the sentinel. */
export const everyModuleEntrySource = (): string =>
    enumerateLibModules()
        .map((m) => `import ${JSON.stringify(m)};`)
        .join("\n") + `\n${SENTINEL}\n`;

// ─── Bundler results ───────────────────────────────────────────────────────

export interface BundleResult {
    errors: string[];
    /** All warnings, verbatim (first line each). */
    warnings: string[];
    /** Warnings after removing `BENIGN_WARNING_RE` (size/perf noise). */
    significantWarnings: string[];
    /** Emitted bundle code (concatenated across chunks), for tree-shaking content assertions. */
    code: string;
}

function classify(warnings: string[]): string[] {
    return warnings.filter((w) => !BENIGN_WARNING_RE.test(w));
}

// ─── Webpack ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const webpack = require("webpack") as typeof import("webpack").webpack;

export interface WebpackOpts {
    entrySource: string;
    /** "production" (Terser + full tree-shaking) or "development". */
    mode: "production" | "development";
    /** When true, disable webpack tree-shaking (usedExports/sideEffects/providedExports) to
     *  reproduce pipelines that defer optimization to a later stage (e.g. Google Closure Compiler,
     *  as Word Web does). This forces every barrel-reachable module to be parsed. */
    disableTreeShaking: boolean;
}

/** Run a webpack build in memory and return errors + warnings + emitted code. */
export function runWebpack(opts: WebpackOpts): Promise<BundleResult> {
    const entry = makeTempEntry(opts.entrySource);
    const optimization = opts.disableTreeShaking
        ? { usedExports: false, sideEffects: false, providedExports: false, minimize: false, concatenateModules: false }
        : { minimize: opts.mode === "production" };
    return new Promise((res, rej) => {
        const compiler = webpack({
            mode: opts.mode,
            entry,
            output: { path: join(entry, "..", "dist"), filename: "out.js" },
            target: ["web", "es2020"],
            performance: { hints: false },
            optimization,
            externals: [
                ({ request }: { request?: string }, cb: (err?: Error | null, result?: string) => void) => (request && isExternalRequest(request) ? cb(null, `var {}`) : cb()),
            ],
            stats: "errors-warnings",
        });
        compiler.run((err, stats) => {
            if (err) {
                compiler.close(() => rej(err));
                return;
            }
            const info = stats!.toJson({ all: false, warnings: true, errors: true, assets: true });
            const warnings = (info.warnings ?? []).map((w) => (typeof w === "string" ? w : w.message));
            const errors = (info.errors ?? []).map((e) => (typeof e === "string" ? e : e.message));
            // Concatenate emitted assets for content assertions.
            const outDir = join(entry, "..", "dist");
            let code = "";
            try {
                for (const f of readdirSync(outDir)) {
                    if (f.endsWith(".js")) {
                        code += readFileSync(join(outDir, f), "utf-8") + "\n";
                    }
                }
            } catch {
                // No output emitted (hard error build); leave code empty.
            }
            compiler.close(() => res({ errors, warnings, significantWarnings: classify(warnings), code }));
        });
    });
}

// ─── Rollup (via Vite's build API, which wraps Rollup) ─────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { build: viteBuild } = require("vite") as typeof import("vite");

export interface RollupOpts {
    entrySource: string;
    format: "es" | "cjs";
    minify: boolean;
    /** Force first-party side-effect retention (ignore `sideEffects:false`) so a genuine module-init
     *  side effect survives tree-shaking instead of the whole graph being dropped on trust. */
    forceModuleSideEffects?: boolean;
}

/** Run a Rollup build (via Vite's `build()`) and return errors + warnings + emitted code. */
export async function runRollup(opts: RollupOpts): Promise<BundleResult> {
    const entry = makeTempEntry(opts.entrySource);
    const warnings: string[] = [];
    const errors: string[] = [];
    let code = "";
    try {
        const result = (await viteBuild({
            configFile: false,
            logLevel: "silent",
            build: {
                write: false,
                minify: opts.minify ? "terser" : false,
                target: "es2020",
                lib: { entry, formats: [opts.format], fileName: "out" },
                rollupOptions: {
                    external: (id: string) => isExternalRequest(id),
                    treeshake: opts.forceModuleSideEffects ? { moduleSideEffects: (_id: string, external: boolean) => !external, propertyReadSideEffects: false } : undefined,
                    onwarn: (w: { message: string }) => warnings.push(w.message),
                },
            },
        })) as unknown as { output: { type: string; code?: string }[] } | { output: { type: string; code?: string }[] }[];
        const output = Array.isArray(result) ? result[0]!.output : result.output;
        for (const chunk of output) {
            if (chunk.type === "chunk" && chunk.code) {
                code += chunk.code + "\n";
            }
        }
    } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
    }
    return { errors, warnings, significantWarnings: classify(warnings), code };
}

/** The recognisable sentinel content, for asserting "nothing but the sentinel survived" regardless
 *  of each bundler's runtime wrapper (webpack wraps in an IIFE + `__webpack_require__` scaffold;
 *  Rollup emits the bare statements). We assert on the sentinel's marker string plus the absence of
 *  any first-party package identifier, rather than exact-string equality. */
export const SENTINEL_MARKER = "Babylon Lite bundler harness sentinel";

/** First-party identifiers that must NOT appear in a fully tree-shaken bundle of a side-effect-only
 *  barrel import. If any survives, module-level code ran on import (a side effect) or `sideEffects`
 *  boundaries are wrong. Spans several subsystems so a leak anywhere is caught. */
const SURVIVING_PACKAGE_IDENTIFIERS: readonly (readonly [string, RegExp])[] = [
    ["engine", /createEngine|createSurface/],
    ["text", /createTextRenderer|createTextLayer|TextRenderer/],
    ["sprite", /createSpriteRenderer|createSprite2DLayer/],
    ["csg2/manifold", /reserveIDs|manifoldModule|CSG2 is not initialized/],
    ["havok", /createHavokWorld|HP_World_Create/],
    ["material", /createPbrMaterial|createStandardMaterial/],
];

/** Names of any first-party subsystems whose identifiers survived in `code` (should be empty for a
 *  side-effect-only import of a properly tree-shaking package). */
export function survivingPackageSubsystems(code: string): string[] {
    return SURVIVING_PACKAGE_IDENTIFIERS.filter(([, re]) => re.test(code)).map(([name]) => name);
}

/** True when a bundle contains the sentinel and no surviving first-party package code — i.e. the
 *  bundler tree-shook the whole side-effect-free graph away. */
export function isSentinelOnly(code: string): boolean {
    return code.includes(SENTINEL_MARKER) && survivingPackageSubsystems(code).length === 0;
}
