// Leaf module shared by the base GS pipeline and the modules it lazy-loads
// (gs-picking-pipeline.ts); see tests/lite/build/lazy-import-cycles.test.ts.

import type { GsShaderFragment } from "./gaussian-splatting-mesh.js";

export function applyGsFragments(wgsl: string, fragments: readonly GsShaderFragment[]): string {
    const slotCode: Record<string, string> = {};
    for (const frag of fragments) {
        if (frag.helperFunctions) {
            slotCode["GS_FRAGMENT_DEFINITIONS"] = (slotCode["GS_FRAGMENT_DEFINITIONS"] ?? "") + frag.helperFunctions + "\n";
        }
        for (const [slot, code] of Object.entries(frag.fragmentSlots ?? {})) {
            slotCode[slot] = (slotCode[slot] ?? "") + code + "\n";
        }
    }
    const spliced = wgsl.replace(/\/\*(GS_FRAGMENT_\w+)\*\//g, (_, slot: string) => slotCode[slot] ?? "");

    // Field-name mangler for the GS shader. Mirrors `mangleGaussianSplattingWgsl`
    // in `scripts/bundle-scenes-core.ts` (build-time mangling of the base WGSL).
    //
    // The build-time mangler renames struct fields like `u.projection → u.p` in
    // the bundled `gaussian-splatting.wgsl`. Fragment-plugin code (e.g.
    // `gsLinearDepthFragment`) lives in TS string constants that reference the
    // un-mangled names (`u.projection`), so without normalisation the spliced
    // WGSL has both `u.projection` (from the fragment) and `u.p` (from the base),
    // causing a WebGPU parse error.
    //
    // Running the same mangler at runtime on the final spliced string makes both
    // parts use the mangled names. The substitution is idempotent (single-letter
    // mangled names don't match the `\bfullName\b` regexes) and harmless in dev
    // mode (where the base WGSL is un-mangled, so this just normalises everything
    // to the mangled form — WebGPU accepts both).
    //
    // KEEP IN SYNC with `scripts/bundle-scenes-core.ts:mangleGaussianSplattingWgsl`.
    //
    // Inlined here (rather than a top-level constant) so it tree-shakes out when
    // fragments are never used — scenes that don't use depth/picking fragments
    // (e.g. scenes 120-126) pay zero runtime cost for this mangling table.
    const mangles: [string, string][] = [
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
    ];

    let mangled = spliced;
    for (const [from, to] of mangles) {
        mangled = mangled.replace(new RegExp(`\\b${from}\\b`, "g"), to);
    }
    return mangled;
}
