/**
 * Shared WGSL minification Vite plugin.
 *
 * Used both by the scene/demo bundle harness (scripts/bundle-scenes-core.ts,
 * bundle-demos-core.ts) AND by the published package build
 * (packages/babylon-lite/vite.config.ts). Keeping it in one place ensures the
 * shipped `@babylonjs/lite` package and the bundle-size measurements minify WGSL
 * identically, so the harness can measure the real published artifact.
 *
 * Two minification paths (see {@link wgslMinifyPlugin}):
 *   - `transform` on `?raw` `.wgsl` imports → miniray whitespace removal (+ optional
 *     identifier mangling). This is where the bulk of WGSL lives (standalone `.wgsl`
 *     shader files).
 *   - `renderChunk` on emitted JS → strips whitespace/comments inside inline
 *     backtick-template WGSL in TypeScript source.
 */
import { type Plugin } from "vite";
import { initialize as initMiniray, minify as minifyWgslMiniray } from "miniray";

function replaceWgslIdentifiers(code: string, replacements: readonly (readonly [string, string])[]): string {
    let out = code;
    for (const [from, to] of replacements) {
        out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
    }
    return out;
}

function mangleGaussianSplattingWgsl(code: string): string {
    // KEEP IN SYNC with the runtime mangling table in
    // `packages/babylon-lite/src/mesh/GaussianSplatting/gaussian-splatting-pipeline.ts:applyGsFragments`.
    // The runtime version normalises any spliced fragment-plugin code to use these
    // mangled names so the WebGPU compiler sees a single consistent identifier set.
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
export function wgslMinifyPlugin(opts: { mangle?: boolean; templates?: boolean } = {}): Plugin {
    // Identifier mangling shortens scene WGSL to satisfy bundle-size ceilings, but it
    // rewrites bare tokens (e.g. worldPos -> wp) PER CHUNK. That is only safe when a
    // shader's struct declaration and all its usages land in the same chunk. The demo
    // bundler splits code far more aggressively, so the declaration and usage can end up
    // in different chunks (and esbuild may turn no-substitution templates into plain
    // strings the mangler skips), producing inconsistent names like "struct member wp
    // not found". Demos have no size ceilings, so they opt out of mangling entirely.
    const mangle = opts.mangle !== false;
    // `templates: false` disables the inline-template `renderChunk` minification, keeping
    // only the `?raw` `.wgsl` `transform`. The package build sets this: its module-granular
    // output is NOT esbuild-minified, so running the template minifier on raw source (with
    // `//` comments, nested templates and complex `${…}` JS) is unsafe, and the scene/demo
    // harness already minifies inline templates once when it bundles the package's output —
    // running it in BOTH places double-processes and corrupts `/* … */` shader markers.
    const templates = opts.templates !== false;
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
            // Encode `/* GS_FRAGMENT_X */` comment markers as const declarations so they
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
            if (!templates) return null;
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
