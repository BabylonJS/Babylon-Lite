/** PBR feature flag constants + extension registry.
 *  Tiny shared module imported by both pbr-pipeline and PBR fragments. */

import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { Texture2D } from "../../texture/texture-2d.js";

export * from "./pbr-flag-bits.js";

// ─── Unified PBR Extension Registry ─────────────────────────────────
/** @internal Bind-group phase, matching composer slot layout:
 *  - "vertex": vertex-stage bindings (morph, skeleton) — between material UBO and base textures
 *  - "base-tex": material-phase bindings (between base textures and lightsUBO)
 *  - "ibl": scene-env bindings (after lightsUBO, before fragment-phase exts)
 *  - "fragment": fragment-phase bindings (after IBL, alphabetical by id) */
export type PbrExtPhase = "vertex" | "base-tex" | "ibl" | "fragment";

/** @internal Fragment creation context threaded through `PbrExt.frag`. */
export interface _PbrFragCtx {
    readonly _features: number;
    readonly _features2: number;
    /** Mesh feature bits, separate from material feature bits. */
    readonly _meshFeatures: number;
    readonly _hasIbl: boolean;
    readonly _hasAnyNormal: boolean;
    readonly _hasSpecularAA: boolean;
    /** Aniso bent-normal WGSL (IBL only). */
    readonly _anisoBentNormalCode?: string;
    /** Pre-baked skybox WGSL (IBL only). */
    readonly _iblSkyboxCalc?: string;
}

/** @internal Bind-group entry build context threaded through `PbrExt.bind`. */
export interface _PbrBindCtx {
    readonly _engine: import("../../engine/engine.js").EngineContextInternal;
    readonly _features: number;
    readonly _features2: number;
    /** Mesh feature bits, separate from material feature bits. */
    readonly _meshFeatures: number;
    readonly _material: unknown;
    /** Populated for "vertex" phase (skeleton, morph). */
    readonly _mesh?: { skeleton?: { boneTexture: GPUTexture } | null; morphTargets?: { texture: GPUTexture; weightsBuffer?: GPUBuffer } | null };
    /** Populated for "ibl" phase. */
    readonly _env?: { brdfLutView: GPUTextureView; brdfSampler: GPUSampler; specularCubeView: GPUTextureView; cubeSampler: GPUSampler } | null;
    /** Per-render-task scene-color snapshot for transmissive RTT refraction. */
    readonly _refractionTexture?: Texture2D | null;
}

/** @internal Unified PBR extension. All hooks optional.
 *  An ext is registered once (at its dynamic-import site in pbr-renderable)
 *  and invoked by the pipeline/material/renderable hot paths. Zero side
 *  effects at module load — registration is explicit. */
export interface PbrExt {
    readonly id: string;
    readonly phase: PbrExtPhase;
    /** Contribute feature bits for a given material. Returns {f,f2} to OR in. */
    detect?(mat: unknown): { f: number; f2: number };
    /** Contribute a ShaderFragment (null if gated off for this variant). */
    frag?(ctx: _PbrFragCtx): ShaderFragment | null;
    /** Write this ext's slice of the material UBO. */
    writeUbo?(data: Float32Array, mat: unknown, offsets: ReadonlyMap<string, number>): void;
    /** Push group-1 bind entries starting at binding `b`; return new b. */
    bind?(ctx: _PbrBindCtx, entries: GPUBindGroupEntry[], b: number): number;
    /** Enumerate textures for acquire/release. */
    textures?(mat: unknown, out: Texture2D[]): void;
}

// Lazy-init: a module-level `new Map()` would defeat tree-shaking for any
// consumer that imports from pbr-flags.ts without actually registering or
// iterating extensions. See GUIDANCE.md §4 ("Zero module-level side effects").
let _pbrExts: Map<string, PbrExt> | null = null;
let _pbrExtsSorted: readonly PbrExt[] | null = null;
/** @internal Register a PBR extension. Idempotent (keyed by id). */
export function _registerPbrExt(ext: PbrExt): void {
    (_pbrExts ??= new Map()).set(ext.id, ext);
    _pbrExtsSorted = null;
}
/** @internal Iterate the registered extensions. */
export function _getPbrExts(): ReadonlyMap<string, PbrExt> {
    return (_pbrExts ??= new Map());
}
/** @internal Return extensions sorted by id (alphabetical, stable within a build). Memoised. */
export function _getPbrExtsSorted(): readonly PbrExt[] {
    if (!_pbrExtsSorted) {
        const map = _pbrExts;
        _pbrExtsSorted = map ? Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id)) : [];
    }
    return _pbrExtsSorted;
}
