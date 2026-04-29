/** StandardMaterial — Blinn-Phong material types and scene uniform helpers.
 *
 *  Pipeline creation is handled by standard-pipeline.ts (dynamic permutation system).
 *  This module owns the shared types and the scene UBO update function.
 *
 *  Scene UBO uses the canonical SCENE_UBO layout (shared with PBR).
 */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";
import type { Material, MaterialInternal } from "../material.js";
import { _getStdExts, _registerStdExt } from "./standard-flags.js";

// ─── Standard Group Builder ──────────────────────────────────────────

/** Lazy-imports the standard renderable builder and builds the pipeline. */
// Material-property → fragment-module dispatch table. Each entry is a plain
// extension: if any mesh's material has the named property, dynamic-import
// the fragment module and register the named StdExt export. Keeping this as
// a data table rather than an if-ladder keeps core size flat as extensions
// grow.
const _STD_MAT_EXTS: ReadonlyArray<readonly [keyof StandardMaterialProps, () => Promise<any>, string]> = [
    ["bumpTexture", () => import("./fragments/normal-map-fragment.js"), "bumpStdExt"],
    ["emissiveTexture", () => import("./fragments/std-emissive-fragment.js"), "stdEmissiveExt"],
    ["specularTexture", () => import("./fragments/std-specular-fragment.js"), "stdSpecularExt"],
    ["ambientTexture", () => import("./fragments/std-ambient-fragment.js"), "stdAmbientExt"],
    ["lightmapTexture", () => import("./fragments/std-lightmap-fragment.js"), "stdLightmapExt"],
    ["opacityTexture", () => import("./fragments/std-opacity-fragment.js"), "stdOpacityExt"],
    ["reflectionTexture", () => import("./fragments/std-reflection-fragment.js"), "stdReflectionExt"],
    ["reflectionCubeTexture", () => import("./fragments/std-cube-reflection-fragment.js"), "stdCubeReflectionExt"],
];

export const standardGroupBuilder: MeshGroupBuilder = async (scene, meshes) => {
    const hasTI = meshes.some((m) => !!m.thinInstances);
    const hasShadow = meshes.some((m) => m.receiveShadows) && scene.lights.some((l: { shadowGenerator?: unknown }) => !!l.shadowGenerator);

    let tiSync: ((engine: EngineContextInternal, ti: any, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number, hasColor: boolean) => number) | undefined;
    let tiFragment: any;
    let shadowFragment: any;

    const imports: Promise<any>[] = [];
    if (hasTI) {
        imports.push(
            import("../../mesh/thin-instance-gpu.js").then((m) => {
                tiSync = m.syncThinInstanceBuffers;
            }),
            import("../../shader/fragments/thin-instance-fragment.js").then((m) => {
                tiFragment = m.createThinInstanceFragment;
            })
        );
    }
    if (hasShadow) {
        imports.push(
            import("./fragments/std-shadow-fragment.js").then((m) => {
                shadowFragment = m.createStdShadowFragment;
            })
        );
    }
    for (const [prop, load, key] of _STD_MAT_EXTS) {
        if (meshes.some((m) => !!(m.material as any)[prop])) {
            imports.push(load().then((mod) => _registerStdExt(mod[key])));
        }
    }
    if (imports.length > 0) {
        await Promise.all(imports);
    }

    const renderableMod = await import("./standard-renderable.js");
    const result = renderableMod.buildStandardMeshRenderables(scene, meshes, {
        tiSync,
        tiFragment,
        shadowFragment,
    });
    // Wire the per-mesh rebuild closure used by material swap + per-pass override.
    standardGroupBuilder._rebuildSingle = result.rebuildSingle;
    return result;
};

// ─── Shared Types ────────────────────────────────────────────────────

/** StandardMaterial properties — plain data. */
export interface StandardMaterialProps extends Material {
    diffuseColor: [number, number, number];
    alpha: number;
    specularColor: [number, number, number];
    specularPower: number;
    emissiveColor: [number, number, number];
    ambientColor: [number, number, number];
    /** Optional diffuse texture. Null = solid color only. */
    diffuseTexture: Texture2D | null;
    /** Diffuse texture UV channel. 0=UV1, 1=UV2. Default 0. */
    diffuseCoordIndex: 0 | 1;
    /** Optional emissive texture. Null = solid emissive color only. */
    emissiveTexture: Texture2D | null;
    /** Optional bump/normal-map texture. Uses cotangent-frame (no tangent attribute needed). */
    bumpTexture: Texture2D | null;
    /** Bump perturbation strength. Default 1.0 (maps to 1/level in BJS). */
    bumpLevel: number;
    /** Optional specular texture. Replaces specularColor; alpha modulates glossiness. */
    specularTexture: Texture2D | null;
    /** Specular texture UV channel. 0=UV1, 1=UV2. Default 0. */
    specularCoordIndex: 0 | 1;
    /** Optional ambient/occlusion texture. Multiplies final diffuse contribution. */
    ambientTexture: Texture2D | null;
    /** Ambient texture intensity. Default 1.0. */
    ambientTexLevel: number;
    /** Ambient texture UV channel. 0=UV1, 1=UV2. Default 0. */
    ambientCoordIndex: 0 | 1;
    /** Optional lightmap texture. Added to final color (additive mode). */
    lightmapTexture: Texture2D | null;
    /** Lightmap intensity. Default 1.0. */
    lightmapLevel: number;
    /** Lightmap UV channel. 0=UV1, 1=UV2. Default 1 (BJS convention). */
    lightmapCoordIndex: 0 | 1;
    /** Optional opacity texture. Multiplies alpha (.a channel). */
    opacityTexture: Texture2D | null;
    /** Opacity texture intensity. Default 1.0. */
    opacityLevel: number;
    /** When true, derive opacity from RGB luminance instead of .a channel. Default false. */
    opacityFromRGB: boolean;
    /** Alpha test cutoff. Fragments with alpha < alphaCutOff are discarded. Default 0 (no alpha test). */
    alphaCutOff: number;
    /** Optional reflection texture (2D spherical map). Null = no reflection. */
    reflectionTexture: Texture2D | null;
    /** Optional cube reflection texture. Null = no cube reflection. */
    reflectionCubeTexture: { texture: GPUTexture; view: GPUTextureView; sampler: GPUSampler } | null;
    /** Reflection intensity. Default 1.0. */
    reflectionLevel: number;
    /** Reflection coordinate mode. 1=spherical, 2=planar. Default 1. */
    reflectionCoordMode: 1 | 2;
    /** UV tiling scale. Default [1, 1]. */
    uvScale: [number, number];
    /** Back-face culling. Default true (BJS convention). False = double-sided. */
    backFaceCulling: boolean;
    /** When true, skip all lighting and output emissive * diffuse * baseColor. Default false. */
    disableLighting: boolean;
}

/** @internal Extended StandardMaterialProps with internal build group. */
export interface StandardMaterialPropsInternal extends StandardMaterialProps, MaterialInternal {}

/** Fog configuration — plain data. */
export interface FogConfig {
    mode: 0 | 1 | 2 | 3; // 0=off, 1=exp, 2=exp2, 3=linear
    density: number;
    start: number;
    end: number;
    color: [number, number, number];
}

/** Create StandardMaterial with Babylon defaults. */
export function createStandardMaterial(): StandardMaterialProps {
    return {
        diffuseColor: [1, 1, 1],
        alpha: 1,
        specularColor: [1, 1, 1],
        specularPower: 64,
        emissiveColor: [0, 0, 0],
        ambientColor: [0, 0, 0],
        diffuseTexture: null,
        diffuseCoordIndex: 0,
        emissiveTexture: null,
        bumpTexture: null,
        bumpLevel: 1,
        specularTexture: null,
        specularCoordIndex: 0,
        ambientTexture: null,
        ambientTexLevel: 1,
        ambientCoordIndex: 0,
        lightmapTexture: null,
        lightmapLevel: 1,
        lightmapCoordIndex: 1,
        opacityTexture: null,
        opacityLevel: 1,
        opacityFromRGB: false,
        alphaCutOff: 0,
        reflectionTexture: null,
        reflectionCubeTexture: null,
        reflectionLevel: 1,
        reflectionCoordMode: 1,
        uvScale: [1, 1],
        backFaceCulling: true,
        disableLighting: false,
        _buildGroup: standardGroupBuilder,
    } as StandardMaterialProps;
}

/** Collect all non-null textures referenced by a Standard material (for acquire/release). */
export function collectStdBoundTextures(mat: StandardMaterialProps): Texture2D[] {
    const t: Texture2D[] = [];
    if (mat.diffuseTexture) {
        t.push(mat.diffuseTexture);
    }
    for (const ext of _getStdExts().values()) {
        ext.textures?.(mat, t);
    }
    return t;
}
