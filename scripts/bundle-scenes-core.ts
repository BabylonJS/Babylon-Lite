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
import { build, type Plugin } from "vite";
import { resolve, dirname, join, extname } from "path";
import { rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { initialize as initMiniray, minify as minifyWgslMiniray } from "miniray";
import { minify as terserMinify } from "terser";
import { bytesToRoundedKB, IGNORED_BUNDLE_MODULE_PATTERN, summarizeRuntimeBundle, type RuntimeJsPayload } from "./bundle-size-accounting";

/**
 * Vite plugin: minify WGSL shader text using miniray (whitespace removal + comment stripping).
 * For `?raw` WGSL imports: miniray minification (no identifier mangling — miniray's mangler
 * produces invalid WGSL on some shaders).
 * For inline template-literal WGSL in JS output: regex-based operator/whitespace stripping.
 */
function wgslMinifyPlugin(): Plugin {
    return {
        name: "wgsl-minify",
        enforce: "pre",
        async buildStart() {
            await initMiniray();
        },
        transform(code: string, id: string) {
            if (!id.includes(".wgsl")) return null;
            const match = code.match(/^export default "(.*)"$/s);
            if (!match) return null;
            const raw = JSON.parse(`"${match[1]}"`);
            const result = minifyWgslMiniray(raw, { mangle: false });
            const minified = typeof result === "string" ? result : result.code;
            return { code: `export default ${JSON.stringify(minified)}`, map: null };
        },
        renderChunk(code: string, chunk) {
            const minified = minifyTemplateWgsl(code);
            const isPbrChunk = chunk.fileName?.includes("pbr-metallic-roughness-block") || chunk.name?.includes("pbr-metallic-roughness-block");
            return { code: isPbrChunk ? mangleInlineWgsl(minified) : minified, map: null };
        },
    };
}

function mangleInlineWgsl(code: string): string {
    const replacements: [string, string][] = [
        ["nme_pbr_transmittanceBurley", "pTB"],
        ["nme_pbr_anisoBentNormal", "pAB"],
        ["nme_pbr_anisoRoughness", "pAR"],
        ["nme_pbr_colorAtDistance", "pCD"],
        ["nme_pbr_visAnisoSmith", "pVS"],
        ["nme_pbr_diffuseEON", "pDE"],
        ["nme_pbr_cocaLambert", "pCL"],
        ["nme_pbr_burleyAnisoD", "pBD"],
        ["nme_pbr_fresSchlick", "pFS"],
        ["nme_pbr_ccSchlick", "pCC"],
        ["nme_pbr_charlieD", "pCH"],
        ["nme_pbr_distGGX", "pDG"],
        ["nme_pbr_geomGGX", "pGG"],
        ["refractionSpecEnvReflectance", "rser"],
        ["ccDirectAbsorption_h", "cdah"],
        ["ccDirectAbsorption", "cda"],
        ["ccAbsorptionColor", "cac"],
        ["ccNdotLRefract_h", "cnlrh"],
        ["ccNdotVRefract", "cnvr"],
        ["ccNdotLRefract", "cnlr"],
        ["ccTintThickness", "ctt"],
        ["ccSpecEnvReflRaw", "cserr"],
        ["ccSpecEnvRefl", "cse"],
        ["ccFresnelIBL", "cfi"],
        ["ccBrdfSample", "cbs"],
        ["directDiffuseTranslucencyScale", "ddts"],
        ["diffuseTransmissionAcc", "dta"],
        ["ssRefractionIrradiance", "sri"],
        ["finalSpecularScaledDirect", "fsd"],
        ["colorSpecEnvReflectance", "cser"],
        ["baseSpecEnvReflectance", "bser"],
        ["ccEnergyConservation", "cec"],
        ["finalRadianceScaled", "frs"],
        ["environmentIrradiance", "eir"],
        ["environmentRadiance", "era"],
        ["translucencyIntensity", "tri"],
        ["baseLayerAbsorption", "bla"],
        ["NdotLUnclamped", "nlu"],
        ["NdotVUnclamped", "nvu"],
        ["ccDirectSpecAcc", "cdsa"],
        ["ccRoughnessIn", "cri"],
        ["ccIntensityIn", "cii"],
        ["ccBumpColor", "cbc"],
        ["ccBumpUv", "cbu"],
        ["ccNormalW", "cnw"],
        ["ccVRefract", "cvr"],
        ["ccAlphaG", "cag"],
        ["ccIorInv", "cii2"],
        ["ccF0_raw", "cfrw"],
        ["ccNdotH_h", "cnhh"],
        ["ccVdotH_h", "cvhh"],
        ["NdotH_h", "nhh"],
        ["VdotH_h", "vhh"],
        ["ccRough", "crg"],
        ["finalIrradiance", "fir"],
        ["finalRefractionRaw", "frr"],
        ["baseLayerAtten", "blt"],
        ["shAlbedoScaling", "sas"],
        ["surfaceAlbedo", "sal"],
        ["refractionOpacity", "rop"],
        ["finalRefraction", "fre"],
        ["ccFinalRadiance", "cfr"],
        ["shadowFactors", "sfs"],
        ["directSpecR0", "dsr"],
        ["lumOverAlpha", "loa"],
        ["geometricNormal", "gnm"],
        ["ccAbsorption", "cab"],
        ["shFinalIbl", "sfi"],
        ["worldNormal", "wnm"],
        ["diffuseAcc", "dac"],
        ["specAcc", "sac"],
        ["worldPos", "wpo"],
        ["cameraPos", "cpo"],
        ["NmePbrMrResult", "PMR"],
        ["NME_PBR_PI", "PI"],
    ];
    let out = code;
    for (const [from, to] of replacements) {
        out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
    }
    return out.replace(/\b0\.0\b/g, "0.").replace(/\b1\.0\b/g, "1.").replace(/\b0\.0000001\b/g, "1e-7").replace(/\b0\.0005\b/g, "5e-4");
}

/** Strip spaces around WGSL operators inside template literal content. */
function minifyTemplateWgsl(code: string): string {
    const out: string[] = [];
    let i = 0;
    const len = code.length;

    while (i < len) {
        const ch = code[i]!;

        // Skip regular string literals
        if (ch === '"' || ch === "'") {
            const q = ch;
            let j = i + 1;
            while (j < len && code[j] !== q) {
                if (code[j] === "\\") j++;
                j++;
            }
            out.push(code.slice(i, j + 1));
            i = j + 1;
            continue;
        }

        // Skip line comments
        if (ch === "/" && i + 1 < len && code[i + 1] === "/") {
            let j = i;
            while (j < len && code[j] !== "\n") j++;
            out.push(code.slice(i, j));
            i = j;
            continue;
        }

        // Template literal — minify WGSL whitespace
        if (ch === "`") {
            out.push("`");
            i++;
            i = processTemplateLiteral(code, i, len, out);
            continue;
        }

        out.push(ch);
        i++;
    }
    return out.join("");
}

function processTemplateLiteral(code: string, i: number, len: number, out: string[]): number {
    while (i < len) {
        const ch = code[i]!;

        if (ch === "\\") {
            out.push(ch, code[i + 1] ?? "");
            i += 2;
            continue;
        }
        if (ch === "`") {
            out.push("`");
            return i + 1;
        }
        if (ch === "$" && i + 1 < len && code[i + 1] === "{") {
            out.push("${");
            i += 2;
            let depth = 1;
            while (i < len && depth > 0) {
                const ec = code[i]!;
                if (ec === "{") depth++;
                else if (ec === "}") {
                    depth--;
                    if (depth === 0) {
                        out.push("}");
                        i++;
                        break;
                    }
                } else if (ec === "`") {
                    out.push("`");
                    i++;
                    i = processTemplateLiteral(code, i, len, out);
                    continue;
                } else if (ec === '"' || ec === "'") {
                    const q = ec;
                    let j = i + 1;
                    while (j < len && code[j] !== q) {
                        if (code[j] === "\\") j++;
                        j++;
                    }
                    out.push(code.slice(i, j + 1));
                    i = j + 1;
                    continue;
                }
                out.push(ec);
                i++;
            }
            continue;
        }

        // Strip WGSL line comments
        if (ch === "/" && i + 1 < len && code[i + 1] === "/") {
            i += 2;
            while (i < len && code[i] !== "\n") i++;
            continue;
        }

        // Collapse WGSL whitespace and strip it around punctuation/operators.
        if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
            const prev = out.length > 0 ? out[out.length - 1]! : "";
            const prevCh = prev.length > 0 ? prev[prev.length - 1]! : "";
            let j = i + 1;
            while (j < len && (code[j] === " " || code[j] === "\n" || code[j] === "\t" || code[j] === "\r")) j++;
            const next = j < len ? code[j]! : "";
            const ops = ":=,+-*/<>(){}[];";
            if (ops.includes(prevCh) || ops.includes(next)) {
                i = j;
                continue;
            }
            if (prevCh !== " " && prevCh !== "`" && next !== "`") {
                out.push(" ");
            }
            i = j;
            continue;
        }

        out.push(ch);
        i++;
    }
    return i;
}

/**
 * Vite plugin: mangle underscore-prefixed properties via Terser.
 * Runs in generateBundle (after esbuild minification) with a shared nameCache
 * so cross-chunk property names stay consistent.
 */
function terserPropertyManglePlugin(): Plugin {
    return {
        name: "terser-property-mangle",
        async generateBundle(_options, bundle) {
            const nameCache: Record<string, unknown> = {};

            for (const [, chunk] of Object.entries(bundle)) {
                if (chunk.type !== "chunk") continue;

                // Dynamically extract WASM import binding names from emscripten
                // glue code.  These are property keys in the env object that the
                // WASM binary imports by name at instantiation time — they must
                // survive property mangling.  The variable holding the object may
                // have been renamed by esbuild, so we anchor on `_abort_js:` which
                // is always the first alphabetical key emscripten emits.
                const wasmReserved: string[] = [];
                const wasmObjMatch = chunk.code.match(/\{(_abort_js:[^}]+)\}/);
                if (wasmObjMatch) {
                    const keys = wasmObjMatch[1].match(/\b(_\w+)\s*:/g);
                    if (keys) wasmReserved.push(...keys.map((k) => k.replace(/\s*:/, "")));
                }

                const result = await terserMinify(chunk.code, {
                    compress: {
                        passes: 2,
                        unsafe: true,
                        unsafe_arrows: true,
                        unsafe_methods: true,
                        pure_getters: true,
                        toplevel: true,
                        booleans_as_integers: true,
                    },
                    mangle: {
                        toplevel: true,
                        properties: {
                            regex: /^_[a-z]/,
                            // `_malloc`/`_free` are emscripten exports accessed on
                            // externally-loaded modules (e.g. draco_decoder.js) whose
                            // glue isn't in the bundle, so wasmReserved can't detect them.
                            reserved: ["_pad", "_pad0", "_pad1", "_pad2", "_pad3", "_pad4", "_imgPad0", "_imgPad1", "_malloc", "_free", ...wasmReserved],
                        },
                    },
                    nameCache,
                    sourceMap: false,
                });

                if (result.code) {
                    chunk.code = result.code;
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
export const outDir = resolve(labDir, "public/bundle");
export const bundleInfoDir = resolve(outDir, "bundle-info");
export const srcDir = resolve(ROOT, "packages/babylon-lite/src");

/**
 * Normalize an absolute module id to a compact, repo-relative display path.
 * - Paths inside the repo are made relative to the repo root.
 * - Paths inside pnpm's `.pnpm/<pkg>@ver/node_modules/<pkg>/...` are collapsed
 *   to `node_modules/<pkg>/...`.
 * - Windows backslashes are normalized to forward slashes.
 * - Virtual ids (starting with `\0`) and query suffixes (e.g. `?raw`) are preserved.
 */
function normalizeModuleId(id: string): string {
    let out = id.replace(/\\/g, "/");
    // Split query suffix (e.g. "?raw") so we don't interfere with path logic.
    const qIdx = out.indexOf("?");
    const query = qIdx >= 0 ? out.slice(qIdx) : "";
    if (qIdx >= 0) out = out.slice(0, qIdx);

    // Virtual modules (Rollup convention) — keep as-is.
    if (out.startsWith("\u0000")) return out + query;

    const rootFwd = ROOT.replace(/\\/g, "/") + "/";
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

const exportKindCache = new Map<string, Record<string, BundleInfoExport["kind"]>>();

/**
 * Parse a .ts / .js source file to classify each exported binding as
 * function / class / const / enum. Uses lightweight regex-based parsing —
 * sufficient for the repo's conventional `export function / const / class`
 * declarations. Also follows same-package `export { X } from "./path.js"`
 * re-exports so chips inherit their original kind.
 */
function extractExportKinds(
    absPath: string,
    visited: Set<string> = new Set(),
): Record<string, BundleInfoExport["kind"]> {
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
        const looksLikeFn =
            /^(async\s+)?function\b/.test(rhs) ||
            /^(async\s+)?\([^)]*\)\s*(?::[^=]+)?=>/.test(rhs) ||
            /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(rhs);
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
function writeBundleInfo(scene: string, result: unknown): void {
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
        };
        if (it.type !== "chunk" || !it.fileName) continue;
        const modules: BundleInfoModule[] = [];
        for (const [rawId, m] of Object.entries(it.modules ?? {})) {
            const bytes = m.renderedLength ?? 0;
            if (bytes <= 0) continue;
            const rawNames = Array.isArray(m.renderedExports) ? [...m.renderedExports].sort() : [];
            // Resolve kinds from the source file on disk (strip any ?query suffix).
            const srcPath = rawId.split("?")[0]!;
            const kinds = srcPath.startsWith("\u0000") ? {} : extractExportKinds(srcPath);
            const exports: BundleInfoExport[] = rawNames.map((name) => ({
                name,
                kind: kinds[name] ?? "unknown",
            }));
            modules.push({ id: normalizeModuleId(rawId), bytes, exports });
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

    mkdirSync(bundleInfoDir, { recursive: true });
    writeFileSync(resolve(bundleInfoDir, `${scene}.json`), JSON.stringify({ scene, chunks }, null, 2));
}

const sceneConfig: { id: number }[] = JSON.parse(readFileSync(resolve(ROOT, "scene-config.json"), "utf-8"));
const ALL_SCENES = sceneConfig.map((s) => `scene${s.id}`);
const SCENES = process.env.BUNDLE_SCENES ? process.env.BUNDLE_SCENES.split(",") : ALL_SCENES;
const BJS_SCENES = process.env.SKIP_BJS ? [] : SCENES.map((s) => `bjs-${s}`);

function getAllJsFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...getAllJsFiles(fullPath));
        else if (entry.name.endsWith(".js")) results.push(fullPath);
    }
    return results;
}

const MIME: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".css": "text/css",
    ".wasm": "application/wasm",
};

function startStaticServer(root: string): Promise<{ server: Server; port: number }> {
    const publicDir = join(root, "public");
    return new Promise((res) => {
        const server = createServer((req, resp) => {
            const url = (req.url ?? "/").split("?")[0]!;
            // Try root first (HTML pages), then public/ (bundle JS, assets)
            let filePath = join(root, url === "/" ? "index.html" : url);
            if (!existsSync(filePath)) filePath = join(publicDir, url);
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

export async function buildBundleScenes(): Promise<void> {
    const t0 = performance.now();
    // Do NOT wipe outDir — keep existing data live in the lab tab during the build.
    // Each scene is updated atomically (new files written, stale old chunks removed).
    mkdirSync(outDir, { recursive: true });

    // ── 1. Build all scenes ──────────────────────────────────────────────
    const NAME_POLYFILL = 'var __name=(fn,name)=>(Object.defineProperty(fn,"name",{value:name,configurable:true}),fn);';

    /** Modules that must keep side effects (they patch prototypes via bare import). */
    const BJS_SIDE_EFFECT_MODULES = ["thinInstanceMesh"];
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

    async function buildScene(scene: string) {
        const sceneOutDir = resolve(outDir, scene);
        const isBjs = scene.startsWith("bjs-");

        const buildResult = await build({
            root: labDir,
            configFile: false,
            publicDir: false,
            logLevel: "warn",
            plugins: isBjs ? [bjsSideEffectsFalsePlugin()] : [wgslMinifyPlugin(), terserPropertyManglePlugin()],
            resolve: {
                // Point babylon-lite directly at TS source directory so the bundle always
                // picks up the current code (no stale node_modules build).
                // Using the directory (not index.ts) so sub-path imports like
                // 'babylon-lite/loader-env/load-dds-env' resolve correctly.
                alias: {
                    "babylon-lite": srcDir,
                },
                dedupe: ["@babylonjs/core"],
            },
            build: {
                outDir: sceneOutDir,
                emptyOutDir: true,
                minify: "esbuild",
                sourcemap: false,
                modulePreload: false,
                rollupOptions: {
                    input: { [scene]: resolve(labDir, isBjs ? `src/bjs/${scene.slice(4)}.ts` : `src/lite/${scene}.ts`) },
                    // Exclude third-party WASM runtimes from Lite bundles so the
                    // bundle-size metric reflects only first-party Lite engine code.
                    ...(!isBjs && { external: ["@babylonjs/havok"] }),
                    output: {
                        format: "es",
                        entryFileNames: "[name].js",
                        chunkFileNames: `${scene}-[name]-[hash].js`,
                        banner: NAME_POLYFILL,
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
        const jsFiles = getAllJsFiles(sceneOutDir);
        const newNames = new Set<string>();
        for (const f of jsFiles) {
            const name = f.substring(sceneOutDir.length + 1).replace(/\\/g, "/");
            newNames.add(name);
            const dest = resolve(outDir, name);
            mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, readFileSync(f));
        }
        // Remove stale files from a previous build of this scene (chunk hash may differ).
        for (const existing of readdirSync(outDir)) {
            if ((existing === `${scene}.js` || existing.startsWith(`${scene}-`)) && !newNames.has(existing)) {
                rmSync(resolve(outDir, existing));
            }
        }
        rmSync(sceneOutDir, { recursive: true, force: true });
    }

    // Load existing manifest to check for cached BJS sizes
    const manifestPath = resolve(outDir, "manifest.json");
    let existingManifest: Record<string, { rawKB: number; gzipKB: number; ignoredRawKB?: number; bjsRawKB?: number; bjsGzipKB?: number; runtimeChunks?: string[] }> = {};
    if (existsSync(manifestPath)) {
        try {
            existingManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        } catch {
            /* start fresh */
        }
    }

    // Only build BJS scenes whose sizes aren't already cached in the manifest
    const bjsScenesToBuild = BJS_SCENES.filter((bjsScene) => {
        const liteScene = bjsScene.replace("bjs-", "");
        const cached = existingManifest[liteScene];
        return cached?.bjsRawKB == null;
    });

    // Build sequentially — parallel Vite build() calls within the same process
    // cause race conditions (0-byte chunk files, stale measurements on Windows).
    const totalScenes = SCENES.length + bjsScenesToBuild.length;
    let built = 0;
    for (const scene of SCENES) {
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

    // Copy third-party WASM runtimes needed by import-mapped bundle pages.
    const vendorDir = resolve(labDir, "public/vendor");
    mkdirSync(vendorDir, { recursive: true });
    try {
        const _require = createRequire(resolve(labDir, "package.json"));
        const havokMain = _require.resolve("@babylonjs/havok");
        const havokSrc = resolve(dirname(dirname(havokMain)), "esm/HavokPhysics_es.js");
        if (existsSync(havokSrc)) {
            writeFileSync(resolve(vendorDir, "havok.js"), readFileSync(havokSrc));
        }
    } catch {
        /* @babylonjs/havok not installed — skip vendor copy */
    }
    // ── 2. Measure real runtime sizes via headless browser ───────────────
    if (process.env.SKIP_MEASURE) {
        console.log("Skipping live size measurement (SKIP_MEASURE is set)");
        console.log(`✓ Bundle scenes built to ${outDir} (total ${elapsed(t0)})`);
        return;
    }
    const tMeasure = performance.now();
    const manifest = await measureLiveSizes();
    console.log(`Live measurement completed in ${elapsed(tMeasure)}`);

    console.log("\n=== Per-scene bundle sizes (live runtime measurement) ===");
    for (const scene of SCENES) {
        const s = manifest[scene];
        if (s) {
            let line = `  ${scene}: ${s.rawKB} KB raw, ${s.gzipKB} KB gzip`;
            if (s.bjsRawKB != null) line += `  |  BJS: ${s.bjsRawKB} KB raw, ${s.bjsGzipKB} KB gzip`;
            console.log(line);
        }
    }
    console.log(`✓ Bundle scenes + manifest built to ${outDir} (total ${elapsed(t0)})`);
}

/**
 * Start a temporary static server, launch a headless browser, load each
 * bundle-sceneN.html, and measure only the /bundle/*.js bytes that are
 * actually fetched at runtime.
 */
async function measureLiveSizes(): Promise<Record<string, { rawKB: number; gzipKB: number; ignoredRawKB?: number; bjsRawKB?: number; bjsGzipKB?: number; runtimeChunks?: string[] }>> {
    const { chromium } = await import("@playwright/test");
    const { server, port } = await startStaticServer(labDir);
    const manifestPath = resolve(outDir, "manifest.json");

    // Load existing manifest so we can update incrementally (UI can refresh mid-build)
    let manifest: Record<string, { rawKB: number; gzipKB: number; ignoredRawKB?: number; bjsRawKB?: number; bjsGzipKB?: number; runtimeChunks?: string[] }> = {};
    if (existsSync(manifestPath)) {
        try {
            manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        } catch {
            /* start fresh */
        }
    }

    function flush(): void {
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }

    try {
        const tBrowser = performance.now();
        console.log("Launching measurement browser...");
        const browser = await chromium.launch({ channel: "chrome", headless: true });
        console.log(`Browser launched in ${elapsed(tBrowser)}`);

        // Measure Lite scenes (write after each)
        for (const scene of SCENES) {
            const tPage = performance.now();
            const { rawKB, gzipKB, ignoredRawKB, chunks } = await measurePage(browser, port, scene, `bundle-${scene}.html`, "/bundle/");
            manifest[scene] = { ...manifest[scene], rawKB, gzipKB, ignoredRawKB, runtimeChunks: chunks };
            flush();
            const ignored = ignoredRawKB > 0 ? `, ignored ${ignoredRawKB} KB raw ${IGNORED_BUNDLE_MODULE_PATTERN}` : "";
            console.log(`  measured ${scene}: ${rawKB} KB raw, ${gzipKB} KB gzip${ignored} (${elapsed(tPage)})`);
        }

        // Measure BJS scenes — skip if sizes already cached in manifest
        for (const bjsScene of BJS_SCENES) {
            const liteScene = bjsScene.replace("bjs-", "");
            if (manifest[liteScene]?.bjsRawKB != null) {
                console.log(`  ${bjsScene}: ${manifest[liteScene]!.bjsRawKB} KB raw, ${manifest[liteScene]!.bjsGzipKB} KB gzip (cached)`);
                continue;
            }
            const tPage = performance.now();
            const { rawKB, gzipKB } = await measurePage(browser, port, bjsScene, `bundle-${bjsScene}.html`, "/bundle/");
            if (manifest[liteScene]) {
                manifest[liteScene].bjsRawKB = rawKB;
                manifest[liteScene].bjsGzipKB = gzipKB;
                flush();
            }
            console.log(`  measured ${bjsScene}: ${rawKB} KB raw, ${gzipKB} KB gzip (${elapsed(tPage)})`);
        }

        await browser.close();
    } finally {
        server.close();
    }

    return manifest;
}

async function measurePage(
    browser: any,
    port: number,
    scene: string,
    htmlFile: string,
    bundlePath: string
): Promise<{ rawKB: number; gzipKB: number; ignoredRawKB: number; chunks: string[] }> {
    const page = await browser.newPage();
    const jsPayloads: RuntimeJsPayload[] = [];
    const chunkFiles: string[] = [];

    page.on("response", async (resp: any) => {
        const url = resp.url();
        if (url.includes(bundlePath) && url.endsWith(".js") && resp.ok()) {
            try {
                const idx = url.indexOf(bundlePath);
                const fileName = url.slice(idx + bundlePath.length).split("?")[0];
                jsPayloads.push({ file: fileName, body: await resp.body() });
                chunkFiles.push(fileName);
            } catch {
                /* page may close before body resolves */
            }
        }
    });

    await page.goto(`http://localhost:${port}/${htmlFile}`);
    try {
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 50_000 });
    } catch {
        // BJS pages may not reach ready state without GPU — just measure fetched JS
    }

    const summary = summarizeRuntimeBundle(jsPayloads, bundleInfoDir, scene);

    await page.close();
    return {
        rawKB: bytesToRoundedKB(summary.rawBytes),
        gzipKB: bytesToRoundedKB(summary.gzipBytes),
        ignoredRawKB: bytesToRoundedKB(summary.ignoredRawBytes),
        chunks: Array.from(new Set(chunkFiles)).sort(),
    };
}
