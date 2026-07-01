/**
 * Module-level side-effect regression tests (bundler tree-shaking).
 *
 * The published `@babylonjs/lite` package declares `sideEffects: false`. These tests
 * VERIFY that claim is honest by bundling side-effect-only imports and asserting the
 * bundler eliminates everything, leaving only a sentinel `console.log`. Anything else
 * surviving is, by definition, a module-level side effect that executes merely on
 * import (e.g. a top-level `globalThis.x = …`, a `register*()` call, a `new Map()` at
 * module scope, or a vendor lib's import-time initialisation). This enforces
 * GUIDANCE's "Zero module-level side effects" pillar. Inspired by the
 * `@babylonjs/core/pure` rollup/webpack tests in the upstream Babylon.js repo.
 *
 * Two complementary tests:
 *
 *  1. **Bare barrel import of the built dist** — proves the SHIPPED artifact a real
 *     npm consumer imports has no side effects in its statically-reachable graph.
 *     This is the real-world consumer guarantee.
 *
 *  2. **Import EVERY source module** — proves no module anywhere is side-effectful,
 *     including ones that are only ever reached via dynamic `import()` (which test 1
 *     cannot see, because the unused dynamic imports tree-shake away before their
 *     target chunks enter the graph). This is the comprehensive guarantee.
 *
 * Why `treeshake.moduleSideEffects` forced on for first-party modules?
 *   `sideEffects: false` would let the bundler drop the whole graph on trust, so an
 *   unused import is trivially empty even if real side effects exist — the test would
 *   pass vacuously. Forcing `moduleSideEffects: true` (for non-external modules) makes
 *   Rollup IGNORE the flag and keep every statement it cannot prove pure, so a genuine
 *   module-init side effect surfaces. `propertyReadSideEffects: false` lets benign
 *   global captures (e.g. `const SS = globalThis.GPUShaderStage`) tree-shake away, so
 *   only genuine module-init work (allocations, calls, mutations) survives.
 */
import { build } from "vite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const PACKAGE_DIR = resolve(ROOT, "packages/babylon-lite");
const PACKAGE_JSON = resolve(PACKAGE_DIR, "package.json");
const SRC_DIR = resolve(PACKAGE_DIR, "src");
const SRC_ENTRY = resolve(SRC_DIR, "index.ts");

/** A real side effect the bundler must always keep, so the expected output is a
 *  recognisable non-empty string rather than "" (which a misconfigured bundler
 *  could produce for the wrong reasons). */
const SENTINEL = 'console.log("Babylon Lite has no module-level side effects");';

/** Bundled third-party runtimes, derived from the package's declared `dependencies`
 *  so this list never drifts from what actually ships. These are out of our control
 *  and isolated into their own chunks (see vite.config.ts), so the tests treat them
 *  as external and trust their `sideEffects` (they tree-shake as whole modules when
 *  unused). Matches a dependency imported bare (`text-shaper`) or via a subpath
 *  (`@recast-navigation/wasm/wasm`). */
const DECLARED_DEPENDENCIES = Object.keys((JSON.parse(readFileSync(PACKAGE_JSON, "utf-8")) as { dependencies?: Record<string, string> }).dependencies ?? {});
const isVendorSpecifier = (source: string): boolean => DECLARED_DEPENDENCIES.some((dep) => source === dep || source.startsWith(`${dep}/`));

/** Vite-generated framework artifacts that are NOT our hand-written modules:
 *   - `?worker[&inline]` worker wrappers emit a guarded `new Blob([...])` at module
 *     scope (and the worker entry itself runs `self.onmessage = …`).
 *   - `?url` / `.wasm` asset references resolve to URLs/paths.
 *  Treated as external so the tests verify only OUR module-init behaviour. */
const FRAMEWORK_SPECIFIER = /\?worker(?:&|$)|\?url(?:&|$)|\.wasm(?:\?|$)/;

const isExternal = (source: string): boolean => isVendorSpecifier(source) || FRAMEWORK_SPECIFIER.test(source);

const normalize = (value: string): string => value.replace(/\r\n/g, "\n").trim();

/** Shared treeshake config: ignore `sideEffects: false` for first-party modules and
 *  verify it (keep anything not provably pure); trust externals as pure; drop benign
 *  property reads. */
const TREESHAKE = {
    moduleSideEffects: (_id: string, external: boolean): boolean => !external,
    propertyReadSideEffects: false,
} as const;

let workDir: string;
let publishedIndex: string;

/** Reproduce the published package's first-party JS output (the `dist/index.js`
 *  graph a real npm consumer imports) into `outDir`, with third-party runtimes and
 *  vite worker artifacts left external. Mirrors vite.config.ts; the d.ts /
 *  package.json plugins are irrelevant to the emitted JS and are omitted. */
async function buildPublishedJs(outDir: string): Promise<void> {
    await build({
        root: PACKAGE_DIR,
        configFile: false,
        logLevel: "silent",
        build: {
            outDir,
            emptyOutDir: true,
            minify: false,
            sourcemap: false,
            lib: { entry: SRC_ENTRY, formats: ["es"] },
            rollupOptions: {
                external: (source: string) => isExternal(source),
                output: { entryFileNames: "index.js", chunkFileNames: "[name].js" },
            },
        },
    });
}

/** Bundle an entry whose source is `entrySource`, with first-party side-effect
 *  detection forced on, and return the trimmed emitted code. */
async function bundleEntry(entryDir: string, entrySource: string): Promise<string> {
    const entry = resolve(entryDir, `entry-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(entry, entrySource);
    const result = (await build({
        configFile: false,
        logLevel: "silent",
        build: {
            write: false,
            minify: false,
            target: "esnext",
            lib: { entry, formats: ["es"], fileName: "out" },
            rollupOptions: {
                external: (source: string) => isExternal(source),
                treeshake: TREESHAKE,
                output: { banner: "" },
            },
        },
    })) as unknown as { output: { type: string; code?: string }[] };
    const output = Array.isArray(result) ? (result[0] as { output: { type: string; code?: string }[] }).output : result.output;
    const chunk = output.find((o) => o.type === "chunk");
    return normalize(chunk?.code ?? "");
}

const bundleBareImport = (entryDir: string, target: string): Promise<string> => bundleEntry(entryDir, `import ${JSON.stringify(target)};\n${SENTINEL}\n`);

/** Every first-party source module a consumer could reach (statically OR via dynamic
 *  `import()`). Web Worker entry modules (`*-worker.ts`) are excluded: they carry a
 *  top-level `self.onmessage = …` by design and are only ever loaded via `?worker`,
 *  never imported as normal modules. */
function enumerateSourceModules(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = resolve(dir, e.name);
            if (e.isDirectory()) {
                walk(p);
            } else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/-worker\.ts$/.test(e.name)) {
                out.push(p);
            }
        }
    };
    walk(SRC_DIR);
    return out;
}

beforeAll(async () => {
    workDir = mkdtempSync(resolve(tmpdir(), "lite-side-effects-"));
    const distDir = resolve(workDir, "dist");
    await buildPublishedJs(distDir);
    publishedIndex = resolve(distDir, "index.js");
}, 300_000);

afterAll(() => {
    if (workDir) {
        rmSync(workDir, { recursive: true, force: true });
    }
});

describe("@babylonjs/lite has no module-level side effects", () => {
    it("bundles a bare `import` of the built package down to nothing (only the sentinel survives)", async () => {
        const code = await bundleBareImport(workDir, publishedIndex);
        expect(
            code,
            "Importing @babylonjs/lite executed module-level code. Anything below the sentinel is a side effect " +
                "(top-level globalThis mutation, register*() call, `new Map()` at module scope, vendor init, etc.). " +
                "Make it lazy/pure so the package's `sideEffects: false` claim holds.\n\n" +
                code
        ).toBe(normalize(SENTINEL));
    }, 120_000);

    it("every source module is side-effect-free, including dynamically-imported ones", async () => {
        // Statically importing EVERY source module forces dynamic-only modules into
        // the analysed graph, so a side effect in a module that is normally reached
        // only via `import()` (invisible to the bare-barrel test above) is caught.
        const modules = enumerateSourceModules();
        const entrySource = modules.map((m) => `import ${JSON.stringify(m)};`).join("\n") + `\n${SENTINEL}\n`;
        const code = await bundleEntry(workDir, entrySource);
        expect(
            code,
            `One of the ${modules.length} source modules has a module-level side effect. Anything below the sentinel ` +
                "is code that runs merely on importing that module (top-level globalThis/self mutation, register*() " +
                "call, `new Map()`/`new Set()` at module scope, etc.). Make it lazy (nullable module var + getter) or " +
                "pure (`/* @__PURE__ */` on a pure call). This includes modules only reached via dynamic import().\n\n" +
                code
        ).toBe(normalize(SENTINEL));
    }, 180_000);

    it("positive control: the harness DOES surface a real module-level side effect", async () => {
        // Guards against the assertions above silently passing because the bundler
        // stopped detecting side effects (config drift). A module that mutates a
        // global on import MUST survive bundling.
        const sideMod = resolve(workDir, "side-effect.js");
        writeFileSync(sideMod, `globalThis.__LITE_SIDE_EFFECT_PROBE__ = (globalThis.__LITE_SIDE_EFFECT_PROBE__ ?? 0) + 1;\nexport const noop = () => {};\n`);
        const code = await bundleBareImport(workDir, sideMod);
        expect(code).toContain("__LITE_SIDE_EFFECT_PROBE__");
        expect(code).not.toBe(normalize(SENTINEL));
    }, 120_000);
});
