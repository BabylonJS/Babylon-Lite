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
import { execFileSync } from "child_process";
import { resolve, dirname, join, extname } from "path";
import { rmSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from "fs";
import { initialize as initMiniray, minify as minifyWgslMiniray } from "miniray";
import { minify as terserMinify, type ECMA, type SourceMapOptions } from "terser";
import { bytesToRoundedKB, IGNORED_BUNDLE_MODULE_PATTERN, summarizeRuntimeBundle, type RuntimeJsPayload } from "./bundle-size-accounting";

/**
 * Vite plugin: minify WGSL shader text using miniray (whitespace removal + identifier mangling).
 * For `?raw` WGSL imports: miniray minifies whitespace AND short-renames module/local identifiers.
 *   - Caveat 1: miniray's mangler does NOT guard against shadowing module-scope vars (e.g. it may
 *     rename a local to the same letter as a uniform binding). We pass `keepNames: ["u", "in",
 *     "finalColor"]` for `gaussian-splatting.wgsl` to reserve (a) the uniform binding name `u`
 *     so locals don't collide with it (otherwise WGSL parsing fails with "cannot index into
 *     mat3x3"), and (b) the fragment-stage identifiers `in` (parameter) / `finalColor` (local)
 *     that runtime fragment-plugin code (`gsLinearDepthFragment` etc.) references.
 *   - Caveat 2: miniray strips block comments. The GS shaders embed `/* GS_FRAGMENT_* *\/`
 *     markers used by `applyGsFragments` to splice in fragment-plugin code at runtime. We
 *     encode each marker as a `const _GS_FRAGMENT_X_:u32=0u;` declaration before miniray
 *     (which survives with `treeShaking: false`), then decode back to a comment marker
 *     after minification — keeping the runtime API and source format unchanged.
 * For inline template-literal WGSL in JS output: regex-based operator/whitespace stripping.
 * Gaussian-splatting raw WGSL gets a small shader-specific identifier compaction pass.
 */
export function wgslMinifyPlugin(opts: { mangle?: boolean } = {}): Plugin {
    // Identifier mangling shortens scene WGSL to satisfy bundle-size ceilings, but it
    // rewrites bare tokens (e.g. worldPos -> wp) PER CHUNK. That is only safe when a
    // shader's struct declaration and all its usages land in the same chunk. The demo
    // bundler splits code far more aggressively, so the declaration and usage can end up
    // in different chunks (and esbuild may turn no-substitution templates into plain
    // strings the mangler skips), producing inconsistent names like "struct member wp
    // not found". Demos have no size ceilings, so they opt out of mangling entirely.
    const mangle = opts.mangle !== false;
    return {
        name: "wgsl-minify",
        enforce: "pre",
        async buildStart() {
            await initMiniray({});
        },
        transform(code: string, id: string) {
            if (!id.includes(".wgsl")) return null;
            const match = code.match(/^export default "(.*)"$/s);
            if (!match) return null;
            const raw = JSON.parse(`"${match[1]}"`);
            const isGs = id.includes("gaussian-splatting.wgsl");
            // Encode `/* GS_FRAGMENT_X *\/` comment markers as const declarations so they
            // survive miniray's comment stripping. Decoded back below.
            const encoded = isGs ? raw.replace(/\/\*(GS_FRAGMENT_\w+)\*\//g, "const _$1_:u32=0u;") : raw;
            const result = minifyWgslMiniray(encoded, isGs ? { keepNames: ["u", "in", "finalColor"], treeShaking: false } : {});
            let minified = typeof result === "string" ? result : result.code;
            if (isGs) {
                minified = minified.replace(/const\s+_(GS_FRAGMENT_\w+)_\s*:\s*u32\s*=\s*0u\s*;/g, "/*$1*/");
            }
            const compact = isGs ? mangleGaussianSplattingWgsl(minified) : minified;
            return { code: `export default ${JSON.stringify(compact)}`, map: null };
        },
        renderChunk(code: string) {
            // NOTE: the NME inline WGSL mangler (mangleInlineWgsl) was removed. It ran
            // per-chunk only on "pbr-metallic-roughness-block" chunks, but NME PBR helper
            // functions / shared bindings (nme_pbr_fresSchlick, nmeBrdfLUT, ...) live in
            // sibling chunks (pbr-mr-helper-*, iridescence-block) that escaped the filter,
            // so their definitions stayed unmangled while call sites were mangled — the
            // assembled shader then failed with "unresolved call target". Renaming across
            // code-split chunks cannot be done safely per-chunk, so we no longer mangle
            // these identifiers at all (a small bundle-size cost on NME scenes only).
            const minified = minifyTemplateWgsl(code, mangle);
            return { code: minified, map: null };
        },
    };
}

function replaceWgslIdentifiers(code: string, replacements: readonly (readonly [string, string])[]): string {
    let out = code;
    for (const [from, to] of replacements) {
        out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
    }
    return out;
}

function mangleGaussianSplattingWgsl(code: string): string {
    // KEEP IN SYNC with `packages/babylon-lite/src/mesh/GaussianSplatting/gaussian-splatting-pipeline.ts:GS_FIELD_MANGLE`.
    // The runtime version normalises any spliced fragment-plugin code to use these mangled
    // names so the WebGPU compiler sees a single consistent identifier set.
    return replaceWgslIdentifiers(code, [
        ["world", "w"],
        ["view", "v"],
        ["projection", "p"],
        ["viewport", "vp"],
        ["focal", "f"],
        ["dataSize", "ds"],
        ["alpha", "a"],
        ["_pad", "_p"],
        ["vColor", "vc"],
        ["vPos", "vq"],
        ["dataUv", "du"],
        ["splatIndex", "si"],
        ["corner", "co"],
        ["center", "ce"],
        ["color", "cl"],
        ["covA", "ca"],
        ["covB", "cb"],
        ["worldPos", "wp"],
        ["modelView", "mv"],
        ["camspace", "cs"],
        ["pos2d", "p2"],
        ["bounds", "bd"],
        ["Vrk", "vr"],
        ["invZ2", "iz2"],
        ["invZ", "iz"],
        ["cov2d", "c2"],
        ["kernelSize", "ks"],
        ["radius", "ra"],
        ["epsilon", "ep"],
        ["lambda1", "l1"],
        ["lambda2", "l2"],
        ["diag", "dg"],
        ["majorAxis", "ma"],
        ["minorAxis", "mi"],
        ["vCenter", "vc2"],
    ]);
}

/** Strip spaces around WGSL operators inside template literal content.
 *  When `mangle` is true, also shorten known WGSL identifiers (scene size optimization). */
function minifyTemplateWgsl(code: string, mangle = true): string {
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
            i = processTemplateLiteral(code, i, len, out, mangle);
            continue;
        }

        out.push(ch);
        i++;
    }
    return out.join("");
}

function processTemplateLiteral(code: string, i: number, len: number, out: string[], mangle = true): number {
    const wgsl: string[] = [];
    const flushWgsl = (): void => {
        if (wgsl.length > 0) {
            const joined = wgsl.join("");
            out.push(mangle ? mangleWgslIdentifiers(joined) : joined);
            wgsl.length = 0;
        }
    };
    while (i < len) {
        const ch = code[i]!;

        if (ch === "\\") {
            wgsl.push(ch, code[i + 1] ?? "");
            i += 2;
            continue;
        }
        if (ch === "`") {
            flushWgsl();
            out.push("`");
            return i + 1;
        }
        if (ch === "$" && i + 1 < len && code[i + 1] === "{") {
            flushWgsl();
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
                    i = processTemplateLiteral(code, i, len, out, mangle);
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
            const prev = wgsl.length > 0 ? wgsl[wgsl.length - 1]! : "";
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
                wgsl.push(" ");
            }
            i = j;
            continue;
        }

        wgsl.push(ch);
        i++;
    }
    flushWgsl();
    return i;
}

function mangleWgslIdentifiers(code: string): string {
    const replacements: [string, string][] = [
        ["computeLighting", "cl"],
        ["computeSphericalCoords", "csc"],
        ["computePlanarCoords", "cpc"],
        ["computePbrLight", "cpl"],
        ["perturbNormal", "pn"],
        ["PbrLightResult", "PLR"],
        ["LightEntry", "LE"],
        ["lightsUniforms", "LU"],
        ["vLightData", "d"],
        ["vLightDiffuse", "c"],
        ["vLightSpecular", "s"],
        ["vLightDirection", "r"],
        ["viewDirectionW", "vdw"],
        ["normalW", "nw"],
        ["diffuseBase", "db"],
        ["specularBase", "sb"],
        ["baseAmbientColor", "bac"],
        ["reflectionColor", "rc"],
        ["finalDiffuse", "fd"],
        ["finalSpecular", "fs"],
        ["directDiffuse", "dd"],
        ["directSpecular", "ds"],
        ["directRoughness", "dr"],
        ["directAlphaG", "dag"],
        ["shadowFactors", "sf"],
        ["lightIndex0", "li0"],
        ["lightIndex", "lix"],
        ["lightColor", "lc"],
        ["lightAtten", "la"],
        ["specColor", "sc"],
        ["isHemi", "ih"],
        ["viewNormal", "vn"],
        ["viewDir", "vd"],
        ["reflCoords", "rcd"],
        ["finalWorld", "fw"],
        ["worldPos4", "wp4"],
        ["normalWorld", "nwm"],
        ["positionW", "pw"],
        ["bumpScale", "bs"],
        ["opSample", "os"],
        ["diffuseColor", "dc"],
        ["emissiveContrib", "ec"],
        ["specularColor", "spc"],
        ["baseColor", "bc"],
        ["glossiness", "gl"],
        ["alpha", "al"],
        ["surfaceAlbedo", "sa"],
        ["roughness", "rg"],
        ["colorF0", "f0"],
        ["colorF90", "f90"],
        ["finalIrradiance", "fi"],
        ["finalRadianceScaled", "fr"],
        ["finalSpecularScaled", "fss"],
        ["AA_factor_x", "aax"],
        ["AA_factor_y", "aay"],
        ["alphaG", "ag"],
        ["NdotV", "nv"],
        ["rangeAtten", "ra"],
        ["rangeAtt", "rat"],
        ["spotC", "sc2"],
        ["lightToFrag", "ltf"],
        ["lightDist2", "ld2"],
        ["lightDist", "ld"],
        ["toLight", "tl"],
        ["dist", "dst"],
        ["entry", "e"],
        ["hemiDiffuse", "hd"],
        ["coloredFresnel", "cf"],
        ["BillboardSystem", "BS"],
        ["BillboardBasis", "BB"],
        ["getBillboardBasis", "gbb"],
        ["billboards", "bb"],
        ["opacityMul", "om"],
        ["cameraRight", "cr"],
        ["cameraUp", "cu"],
        ["lockAxis", "la"],
        ["projectedRightLen", "prl"],
        ["safeProjectedRightLen", "sprl"],
        ["projectedRight", "pr"],
        ["fallbackSeed", "fsd"],
        ["fallbackRightRaw", "frr"],
        ["fallbackRight", "fr"],
        ["sampleColor", "scol"],
        ["cosRot", "cr2"],
        ["sinRot", "sr2"],
        ["rotated", "rot"],
        // NOTE: Do NOT add WGSL struct-varying member names (e.g. "worldPos",
        // "worldNormal", "worldTangent", ...) to this list. Their struct is
        // assembled at runtime from JS string literals (e.g. {Z:"worldPos"})
        // which this mangler deliberately never touches (it only rewrites bare
        // identifiers inside backtick WGSL template literals). Mangling the
        // hardcoded `out.worldPos`/`input.worldPos` usages while leaving the
        // string-built struct member as `worldPos` produces invalid WGSL
        // ("struct member wp not found"), especially when usages and the struct
        // declaration land in different code-split chunks. Only chunk-local
        // temporaries like `worldPos4` (mangled to `wp4` above) are safe here.
        ["iUvMin", "ium"],
        ["iUvMax", "iux"],
        ["iPivot", "ip"],
        ["iColor", "ic"],
        ["iSize", "isz"],
        ["iPos", "ipos"],
        ["iRot", "ir"],
    ];
    return replaceWgslIdentifiers(code, replacements);
}

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
const MANIFEST_GIT_PATH = "lab/public/bundle/manifest.json";
const MANIFEST_FILE = "manifest.json";
const MASTER_MANIFEST_FILE = "master-manifest.json";
export const NAME_POLYFILL = 'var __name=(fn,name)=>(Object.defineProperty(fn,"name",{value:name,configurable:true}),fn);';
export const LITE_BUNDLE_TARGET = "esnext";

interface SceneConfigEntry {
    id: number;
    tags?: string[];
}

interface BundleManifestEntry {
    rawKB: number;
    gzipKB: number;
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

function readMasterBundleManifest(refs = ["upstream/master", "origin/master", "master"]): { ref: string; manifest: BundleManifest } | null {
    const errors: string[] = [];
    for (const ref of refs) {
        try {
            const json = execFileSync("git", ["show", `${ref}:${MANIFEST_GIT_PATH}`], { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
            return { ref, manifest: JSON.parse(json) as BundleManifest };
        } catch (err) {
            errors.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    console.warn(`Could not read ${MANIFEST_GIT_PATH} from master refs; bundle delta UI will not have a master baseline. ${errors.join(" | ")}`);
    return null;
}

export function writeMasterBundleManifest(refs?: string[]): void {
    const masterManifestPath = resolve(outDir, MASTER_MANIFEST_FILE);
    const baseline = readMasterBundleManifest(refs);
    if (!baseline) {
        rmSync(masterManifestPath, { force: true });
        return;
    }

    writeFileSync(masterManifestPath, JSON.stringify(orderBundleManifest(baseline.manifest), null, 2));
    console.log(`✓ Bundle master baseline manifest (${baseline.ref}) written to ${masterManifestPath}`);
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
            const bytes = minifiedBytes[normalizedId] ?? 0;
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
const BJS_SCENES = process.env.SKIP_BJS ? [] : SCENES.map((s) => `bjs-${s}`);

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
    ".css": "text/css",
    ".wasm": "application/wasm",
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
 *  injects around every dynamic import down to a bare `import("chunk")`.
 *
 *  These Lite bundles disable module preload, and the preload helper itself is a
 *  pure passthrough (`baseModule => baseModule()`), so the wrapper and its empty
 *  deps array are semantically dead weight. The helper lives in a separate chunk,
 *  so esbuild can't inline it across the chunk boundary — hence ~6 bytes of
 *  wrapper survive per dynamic import in every chunk. Removing them shrinks every
 *  code-split scene (feature-rich glTF assets carry dozens of these). Applied to
 *  the finalized on-disk output in {@link buildScene} because Vite resolves the
 *  preload form too late for a renderChunk/generateBundle hook to see it. */
function stripNoopPreloadWrappers(code: string): string {
    return code.replace(/[\w$]+\(\s*\(\s*\)\s*=>\s*(import\([^()]*\))\s*,\s*\[\s*\]\s*\)/g, "$1");
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
                output: {
                    format: "es",
                    entryFileNames: "[name].js",
                    chunkFileNames: `${scene}-[name]-[hash].js`,
                    banner: NAME_POLYFILL,
                },
            },
        },
    });

    writeBundleInfoToDir(scene, buildResult, infoDir, sourceRoot);
    rmSync(sceneOutDir, { recursive: true, force: true });
}

export function measurementBrowserArgs(): string[] {
    const swiftShaderArgs = process.env.CI
        ? ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"]
        : [];
    return ["--force-color-profile=srgb", "--enable-unsafe-webgpu", ...swiftShaderArgs];
}

export async function buildBundleScenes(): Promise<void> {
    const t0 = performance.now();
    // Do NOT wipe outDir — keep existing data live in the lab tab during the build.
    // Each scene is updated atomically (new files written, stale old chunks removed).
    mkdirSync(outDir, { recursive: true });
    writeMasterBundleManifest();
    for (const scene of SCENES) {
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
                ...(!isBjs && { target: LITE_BUNDLE_TARGET }),
                minify: "esbuild",
                sourcemap: "hidden",
                modulePreload: false,
                rollupOptions: {
                    input: { [scene]: isBjs ? bjsSceneEntry(scene) : liteSceneEntry(scene) },
                    // Exclude third-party WASM runtimes from Lite bundles so the
                    // bundle-size metric reflects only first-party Lite engine code.
                    ...(!isBjs && { external: isLiteBundleExternal }),
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

    // Load existing current manifest to check for cached BJS sizes.
    const manifestPath = resolve(outDir, MANIFEST_FILE);
    let existingManifest: BundleManifest = {};
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

    copyVendorRuntimeFiles();
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
async function measureLiveSizes(): Promise<BundleManifest> {
    const { chromium } = await import("@playwright/test");
    const { server, port } = await startStaticServer(labDir);
    const manifestPath = resolve(outDir, MANIFEST_FILE);
    const masterManifestPath = resolve(outDir, MASTER_MANIFEST_FILE);
    let masterManifest: BundleManifest = {};
    if (existsSync(masterManifestPath)) {
        try {
            masterManifest = JSON.parse(readFileSync(masterManifestPath, "utf-8"));
        } catch {
            /* no master baseline */
        }
    }

    // Load existing manifest so we can update incrementally (UI can refresh mid-build)
    let manifest: BundleManifest = {};
    if (existsSync(manifestPath)) {
        try {
            manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        } catch {
            /* start fresh */
        }
    }

    function flush(): void {
        // The lab UI may fetch manifest.json mid-build, so a plain writeFileSync (which truncates
        // the live file) can collide with a concurrent reader and surface as a transient Windows
        // file-lock error (errno -4094 UNKNOWN / EBUSY). Write a sibling temp file and rename it
        // into place — rename is atomic and never truncates the file readers hold open. Retry a few
        // times to ride out any residual lock (e.g. AV scanning the freshly written file).
        const json = JSON.stringify(orderBundleManifest(manifest), null, 2);
        const tmpPath = `${manifestPath}.tmp`;
        for (let attempt = 0; ; attempt++) {
            try {
                writeFileSync(tmpPath, json);
                renameSync(tmpPath, manifestPath);
                return;
            } catch (err) {
                if (attempt >= 5) {
                    throw err;
                }
                const wait = Date.now() + 50 * (attempt + 1);
                while (Date.now() < wait) {
                    /* brief synchronous backoff before retrying the atomic write */
                }
            }
        }
    }

    try {
        const tBrowser = performance.now();
        console.log("Launching measurement browser...");
        const browser = await chromium.launch({ channel: "chrome", headless: true, args: measurementBrowserArgs() });
        console.log(`Browser launched in ${elapsed(tBrowser)}`);

        // Measure Lite scenes (write after each)
        for (const scene of SCENES) {
            const tPage = performance.now();
            const masterIgnoredRawKB = masterManifest[scene]?.ignoredRawKB;
            const { rawKB, gzipKB, ignoredRawKB, chunks } = await measurePage(browser, port, scene, `lite/bundle-${scene}.html`, "/bundle/", masterIgnoredRawKB);
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
                flush();
            }
            console.log(`  measured ${bjsScene}: ${rawKB} KB raw, ${gzipKB} KB gzip (${elapsed(tPage)})`);
        }

        await browser.close();
    } finally {
        server.close();
    }

    if (!process.env.BUNDLE_SCENES) {
        const currentScenes = new Set(SCENES);
        for (const scene of Object.keys(manifest)) {
            if (!currentScenes.has(scene)) {
                delete manifest[scene];
            }
        }
        flush();
    }

    return manifest;
}

export async function measurePage(
    browser: any,
    port: number,
    scene: string,
    htmlFile: string,
    bundlePath: string,
    ignoredRawKBOverride?: number
): Promise<{ rawKB: number; gzipKB: number; ignoredRawKB: number; chunks: string[] }> {
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

    await page.goto(`http://localhost:${port}/${htmlFile}`);
    try {
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 50_000 });
    } catch {
        // BJS pages may not reach ready state without GPU — just measure fetched JS
    }

    await Promise.all(responseReads);
    if (responseReadErrors.length > 0) {
        throw responseReadErrors[0];
    }
    const summary = summarizeRuntimeBundle(jsPayloads, bundleInfoDir, scene);
    const ignoredRawKB = ignoredRawKBOverride ?? bytesToRoundedKB(summary.ignoredRawBytes);
    const rawBytes = ignoredRawKBOverride == null ? summary.rawBytes : Math.max(0, summary.fetchedRawBytes - ignoredRawKBOverride * 1024);

    await page.close();
    return {
        rawKB: bytesToRoundedKB(rawBytes),
        gzipKB: bytesToRoundedKB(summary.gzipBytes),
        ignoredRawKB,
        chunks: Array.from(new Set(chunkFiles)).sort(),
    };
}
