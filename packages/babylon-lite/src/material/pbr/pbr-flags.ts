/** PBR feature flag constants + light extension registry.
 *  Tiny shared module imported by both pbr-pipeline and light extensions. */

import type { PbrLightExtension } from "../../light/types.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { Texture2D } from "../../texture/texture-2d.js";

export const PBR_HAS_NORMAL_MAP = 1 << 0;
export const PBR_HAS_EMISSIVE = 1 << 1;
export const PBR_HAS_ENV = 1 << 2;
export const PBR_HAS_SKELETON = 1 << 3;
export const PBR_HAS_TONEMAP = 1 << 4;
export const PBR_HAS_MORPH_TARGETS = 1 << 5;
export const PBR_HAS_ALPHA_BLEND = 1 << 6;
export const PBR_HAS_SPEC_GLOSS = 1 << 7;
export const PBR_HAS_DOUBLE_SIDED = 1 << 8;
export const PBR_HAS_COTANGENT_NORMAL = 1 << 9;
export const PBR_HAS_METALLIC_REFLECTANCE_MAP = 1 << 10;
export const PBR_HAS_REFLECTANCE_MAP = 1 << 11;
export const PBR_HAS_USE_ALPHA_ONLY_MR = 1 << 12;
const PBR_LIGHT_TYPE_SHIFT = 13;
export const PBR_HAS_OCCLUSION = 1 << 15;
export const PBR_HAS_SKELETON_8 = 1 << 16;
export const PBR_HAS_SPECULAR_AA = 1 << 17;
export const PBR_HAS_THIN_INSTANCES = 1 << 18;
export const PBR_HAS_INSTANCE_COLOR = 1 << 19;
export const PBR_HAS_CLEARCOAT = 1 << 20;
export const PBR_HAS_EMISSIVE_COLOR = 1 << 21;
export const PBR_HAS_SHEEN = 1 << 22;
export const PBR_HAS_SHEEN_TEXTURE = 1 << 23;
export const PBR_HAS_RECEIVE_SHADOWS = 1 << 24;
export const PBR_HAS_GAMMA_ALBEDO = 1 << 25;
export const PBR_HAS_ANISOTROPY = 1 << 26;
export const PBR_HAS_SUBSURFACE = 1 << 27;
export const PBR_HAS_THICKNESS_MAP = 1 << 28;
export const PBR_HAS_SKYBOX = 1 << 29;
export const PBR_HAS_SHEEN_ALBEDO_SCALING = 1 << 30;

// ─── features2 (extended feature bits) ──────────────────────────────
// Used when `features` runs out of bits. Threaded separately through
// composePbr / getOrCreatePbrPipeline / createPbrMeshBindGroup.
export const PBR2_CC_INT_MAP = 1 << 0;
export const PBR2_CC_ROUGH_MAP = 1 << 1;
export const PBR2_CC_NORMAL_MAP = 1 << 2;
export const PBR2_CC_F0_REMAP_OFF = 1 << 3;
/** Material has KHR_materials_transmission (refraction through surface). */
export const PBR2_HAS_REFRACTION = 1 << 4;
/** Material has KHR_materials_volume (thickness-based Beer-Lambert absorption). */
export const PBR2_HAS_VOLUME = 1 << 5;
/** Material has a transmission texture (R channel). */
export const PBR2_HAS_REFRACTION_MAP = 1 << 6;
/** Thickness texture samples the G channel (KHR_materials_volume). */
export const PBR2_HAS_THICKNESS_GLTF_CHANNEL = 1 << 7;
/** Material is unlit — bypass all lighting (KHR_materials_unlit). */
export const PBR2_HAS_UNLIT = 1 << 8;
/** Any bound texture on this material carries a non-identity UV transform
 *  (`uScale/vScale/uOffset/vOffset/uAng` on its Texture2D). Enables per-
 *  texture UV-transform UBO fields + `txfUV` wrapping in the shader. */
export const PBR2_HAS_UV_TRANSFORM = 1 << 9;
/** Material has non-default metallicF0Factor or metallicReflectanceColor
 *  without reflectance textures (factor-only KHR_materials_specular). */
export const PBR2_HAS_REFLECTANCE_FACTORS = 1 << 10;
/** Mesh has per-vertex COLOR_0 data. */
export const PBR2_HAS_VERTEX_COLOR = 1 << 11;
/** Mesh has a second UV set (TEXCOORD_1) and the material uses it for occlusion. */
export const PBR2_HAS_UV2 = 1 << 12;
/** Material has a sheen texture with a KHR_texture_transform. Sheen owns its
 *  own `sheenUVm`/`sheenUVt` UBO fields and applies txfUV locally. */
export const PBR2_HAS_SHEEN_UV_TX = 1 << 13;

let _lightExt: PbrLightExtension | null = null;
/** @internal */ export function _setPbrLightExtension(ext: PbrLightExtension): void {
    _lightExt = ext;
}
/** @internal */ export function _getPbrLightExtension(): PbrLightExtension | null {
    return _lightExt;
}
const _lightTagToType: Record<string, number> = { hemispheric: 1, directional: 2, point: 3 };
/** @internal */ export function getLightTypeFeatureBits(): number {
    return (_lightTagToType[_lightExt?.tag ?? ""] ?? 0) << PBR_LIGHT_TYPE_SHIFT;
}

// ─── Unified PBR Extension Registry ─────────────────────────────────
/** @internal Bind-group phase, matching composer slot layout:
 *  - "vertex": vertex-stage bindings (morph, skeleton) — between material UBO and base textures
 *  - "base-tex": material-phase bindings (between base textures and lightsUBO)
 *  - "ibl": scene-env bindings (after lightsUBO, before fragment-phase exts)
 *  - "fragment": fragment-phase bindings (after IBL, alphabetical by id) */
export type PbrExtPhase = "vertex" | "base-tex" | "ibl" | "fragment";

/** @internal Fragment creation context threaded through `PbrExt.frag`. */
export interface PbrFragCtx {
    readonly features: number;
    readonly features2: number;
    readonly hasIbl: boolean;
    readonly hasAnyNormal: boolean;
    readonly hasSpecularAA: boolean;
    /** Aniso bent-normal WGSL (IBL only). */
    readonly anisoBentNormalCode?: string;
    /** Pre-baked skybox WGSL (IBL only). */
    readonly iblSkyboxCalc?: string;
}

/** @internal Bind-group entry build context threaded through `PbrExt.bind`. */
export interface PbrBindCtx {
    readonly features: number;
    readonly features2: number;
    readonly material: unknown;
    /** Populated for "vertex" phase (skeleton, morph). */
    readonly mesh?: { skeleton?: { boneTexture: GPUTexture } | null; morphTargets?: { texture: GPUTexture; weightsBuffer?: GPUBuffer } | null };
    /** Populated for "ibl" phase. */
    readonly env?: { brdfLutView: GPUTextureView; brdfSampler: GPUSampler; specularCubeView: GPUTextureView; cubeSampler: GPUSampler } | null;
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
    frag?(ctx: PbrFragCtx): ShaderFragment | null;
    /** Write this ext's slice of the material UBO. */
    writeUbo?(data: Float32Array, mat: unknown, offsets: ReadonlyMap<string, number>): void;
    /** Push group-1 bind entries starting at binding `b`; return new b. */
    bind?(ctx: PbrBindCtx, entries: GPUBindGroupEntry[], b: number): number;
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
