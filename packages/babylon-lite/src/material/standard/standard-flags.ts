import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import type { StandardMaterialProps } from "./standard-material.js";

// ─── Pluggable Shadow Shader Extensions (tree-shakable) ────────────
// PCF shadow code is registered at runtime by createPcfShadowGenerator(),
// so it's only bundled when PCF is actually used.
export interface ShadowShaderExt {
    declarations: string;
    fn: string;
    call: string;
}

let _pcfShadowExt: ShadowShaderExt | null = null;

export function registerPcfShadowShader(ext: ShadowShaderExt): void {
    _pcfShadowExt = ext;
}

export function getPcfShadowExt(): ShadowShaderExt | null {
    return _pcfShadowExt;
}

// ─── Feature Flags ──────────────────────────────────────────────────

export const HAS_DIFFUSE_TEXTURE = 1 << 0;
export const HAS_EMISSIVE_TEXTURE = 1 << 1;
export const RECEIVE_SHADOWS = 1 << 2;
export const HAS_BUMP_TEXTURE = 1 << 3;
export const HAS_SPECULAR_TEXTURE = 1 << 4;
export const HAS_AMBIENT_TEXTURE = 1 << 5;
export const HAS_LIGHTMAP_TEXTURE = 1 << 6;
export const HAS_OPACITY_TEXTURE = 1 << 7;
export const LIGHTMAP_USES_UV2 = 1 << 8;
export const AMBIENT_USES_UV2 = 1 << 9;
export const DOUBLE_SIDED = 1 << 10;
export const DIFFUSE_USES_UV2 = 1 << 11;
export const SPECULAR_USES_UV2 = 1 << 12;
export const OPACITY_FROM_RGB = 1 << 13;
export const HAS_REFLECTION_TEXTURE = 1 << 14;
export const THIN_INSTANCES = 1 << 15;
export const THIN_INSTANCE_COLOR = 1 << 16;
export const DISABLE_LIGHTING = 1 << 17;
export const PCF_SHADOWS = 1 << 18;
export const MATERIAL_ALPHA_BLEND = 1 << 19;
export const HAS_CUBE_REFLECTION = 1 << 20;

// ─── Pluggable Shadow Pipeline Extensions (tree-shakable) ──────────
// PCF bind group layout config is registered at runtime by createPcfShadowGenerator().
export interface ShadowBglConfig {
    textureSampleType: GPUTextureSampleType;
    samplerType: GPUSamplerBindingType;
}

let _pcfBglConfig: ShadowBglConfig | null = null;

/** Called by PCF shadow generator to register its BGL config. */
export function registerPcfShadowBgl(config: ShadowBglConfig): void {
    _pcfBglConfig = config;
}

/** Get the registered PCF shadow BGL config (if any). */
export function getPcfShadowBglConfig(): ShadowBglConfig | null {
    return _pcfBglConfig;
}

// ─── Standard Material Extension Registry ───────────────────────────

/** Bind-ordering phase for StdExt textures (alphabetical by id within phase, matching composer). */
export type StdExtPhase = "mesh";

/** Unified extension for Standard material. Each fragment module exports one.
 *  Fragments register via `_registerStdExt(ext)` at dynamic-import sites. */
export interface StdExt {
    readonly id: string;
    readonly phase: StdExtPhase;
    /** Feature bit this ext gates on. */
    readonly feature: number;
    frag(features: number, shadowLights?: ShadowLightSlotLite[]): ShaderFragment;
    /** Push group-1 bind entries starting at binding `b`; return new b. */
    bind?(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number): number;
    /** Enumerate textures for acquire/release. */
    textures?(mat: StandardMaterialProps, out: Texture2D[]): void;
}

export interface ShadowLightSlotLite {
    lightIndex: number;
    shadowType: "esm" | "pcf";
}

// Lazy-init: avoids a module-level `new Map()` that defeats tree-shaking for
// consumers importing flags/registry symbols without using extensions.
// See GUIDANCE.md §4 ("Zero module-level side effects").
let _stdExts: Map<string, StdExt> | null = null;
let _stdExtsSorted: readonly StdExt[] | null = null;

export function _registerStdExt(ext: StdExt): void {
    (_stdExts ??= new Map()).set(ext.id, ext);
    _stdExtsSorted = null;
}

export function _getStdExts(): ReadonlyMap<string, StdExt> {
    return (_stdExts ??= new Map());
}

export function _getStdExtsSorted(): readonly StdExt[] {
    if (!_stdExtsSorted) {
        const map = _stdExts;
        _stdExtsSorted = map ? Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id)) : [];
    }
    return _stdExtsSorted;
}

/** Derived: mesh needs UV attribute (any texture present). */
export const NEEDS_UV = HAS_DIFFUSE_TEXTURE | HAS_EMISSIVE_TEXTURE | HAS_BUMP_TEXTURE | HAS_SPECULAR_TEXTURE | HAS_AMBIENT_TEXTURE | HAS_LIGHTMAP_TEXTURE | HAS_OPACITY_TEXTURE;

/** Derived: mesh needs UV2 attribute. */
export const NEEDS_UV2 = LIGHTMAP_USES_UV2 | AMBIENT_USES_UV2 | DIFFUSE_USES_UV2 | SPECULAR_USES_UV2;
