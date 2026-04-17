/** PBR feature flag constants + light extension registry.
 *  Tiny shared module imported by both pbr-pipeline and light extensions. */

import type { PbrLightExtension } from "../../light/types.js";

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

// ─── features2 (extended feature bits) ──────────────────────────────
// Used when `features` runs out of bits. Threaded separately through
// composePbr / getOrCreatePbrPipeline / createPbrMeshBindGroup.
export const PBR2_CC_INT_MAP = 1 << 0;
export const PBR2_CC_ROUGH_MAP = 1 << 1;
export const PBR2_CC_NORMAL_MAP = 1 << 2;
export const PBR2_CC_F0_REMAP_OFF = 1 << 3;

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

// ─── Subsurface Extension Registry ──────────────────────────────────
/** @internal */
export interface PbrSubsurfaceExt {
    detect(mat: unknown): number;
    frag(features: number, hasIbl: boolean): unknown;
    ubo(d: Float32Array, m: unknown, o: ReadonlyMap<string, number>): void;
    bind(f: number, m: unknown, e: GPUBindGroupEntry[], b: number): void;
    textures(m: unknown, t: unknown[]): void;
}
let _ssExt: PbrSubsurfaceExt | null = null;
/** @internal */ export function _setSubsurfaceExt(e: PbrSubsurfaceExt): void {
    _ssExt = e;
}
/** @internal */ export function _getSubsurfaceExt(): PbrSubsurfaceExt | null {
    return _ssExt;
}
