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

// ─── Material UBO Writer Registry ───────────────────────────────────
/** @internal Signature for a material-UBO writer contributed by a PBR fragment.
 *  Called once per material update. Each writer checks its own gating
 *  (material props + presence of its UBO fields in `offsets`) and writes
 *  only the slice it owns. Keeps `pbr-renderable.writeMaterialData` neutral. */
export type PbrMaterialUboWriter = (data: Float32Array, material: unknown, offsets: ReadonlyMap<string, number>) => void;

const _matUboWriters = new Map<string, PbrMaterialUboWriter>();
/** @internal Register a material-UBO writer. Keyed by fragment id so
 *  repeated dynamic imports of the same fragment remain idempotent. */
export function _registerPbrMaterialUboWriter(id: string, fn: PbrMaterialUboWriter): void {
    _matUboWriters.set(id, fn);
}
/** @internal Iterate the registered writers. */
export function _getPbrMaterialUboWriters(): ReadonlyMap<string, PbrMaterialUboWriter> {
    return _matUboWriters;
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

const _pbrExts = new Map<string, PbrExt>();
/** @internal Register a PBR extension. Idempotent (keyed by id). */
export function _registerPbrExt(ext: PbrExt): void {
    _pbrExts.set(ext.id, ext);
}
/** @internal Iterate the registered extensions. */
export function _getPbrExts(): ReadonlyMap<string, PbrExt> {
    return _pbrExts;
}
