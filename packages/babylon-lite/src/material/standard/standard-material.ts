/** StandardMaterial — Blinn-Phong material types and scene uniform helpers.
 *
 *  Pipeline creation is handled by standard-pipeline.ts (dynamic permutation system).
 *  This module owns the shared types and the scene UBO update function.
 *
 *  Scene UBO (group 0, binding 0): 176 bytes = 44 floats
 *    viewProjection: mat4x4 (16 floats)
 *    view: mat4x4 (16 floats)
 *    vEyePosition: vec4 (4 floats)
 *    vFogInfos: vec4 (4 floats) — x=mode, y=start, z=end, w=density
 *    vFogColor: vec4 (4 floats) — rgb + pad
 */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";
import { computeUboLayout } from "../../shader/ubo-layout.js";
import { createStandardTemplate } from "./standard-template.js";
import { _getStdExts } from "./standard-pipeline.js";

// ─── Shared Constants ────────────────────────────────────────────────

// Scene UBO size derived from template's baseSceneUboFields (lazy-computed)
let _sceneUboSize: number | null = null;
function getSceneUboSize(): number {
    if (_sceneUboSize === null) {
        const tpl = createStandardTemplate({ textures: {}, needsUV: false, needsUV2: false, hasShadow: false });
        _sceneUboSize = computeUboLayout(tpl.baseSceneUboFields).totalBytes;
    }
    return _sceneUboSize;
}

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

export const standardGroupBuilder: MeshGroupBuilder & { _loadRebuildSingle?: () => Promise<any> } = async (scene, meshes) => {
    const hasTI = meshes.some((m) => !!m.thinInstances);
    const hasShadow = meshes.some((m) => m.receiveShadows) && scene.lights.some((l: { shadowGenerator?: unknown }) => !!l.shadowGenerator);

    let tiSync: ((engine: EngineContextInternal, ti: any, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number, hasColor: boolean) => number) | undefined;
    let tiFragment: any;
    let shadowFragment: any;

    const { _registerStdExt } = await import("./standard-pipeline.js");

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

    const { buildStandardMeshRenderables } = await import("./standard-renderable.js");
    return buildStandardMeshRenderables(scene, meshes, {
        tiSync,
        tiFragment,
        shadowFragment,
    });
};
// Lazy loader for the single-mesh rebuild function — loaded only when a material swap happens
standardGroupBuilder._loadRebuildSingle = () => import("./standard-single-rebuild.js");

// ─── Shared Types ────────────────────────────────────────────────────

/** StandardMaterial properties — plain data. */
export interface StandardMaterialProps {
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

// ─── Scene Uniforms Update ───────────────────────────────────────────

// Pre-allocated scratch buffer for scene uniform writes (avoids per-frame allocation)
let _sceneUniformScratch: Float32Array<ArrayBuffer> | null = null;

/** Write per-frame scene uniforms to the given UBO.
 *  Identical layout across all pipeline variants. */
export function updateSceneUniforms(
    engine: EngineContextInternal,
    sceneUBO: GPUBuffer,
    viewProjection: Float32Array,
    viewMatrix: Float32Array,
    eyePosition: [number, number, number],
    fog?: FogConfig
): void {
    const device = engine.device;
    const size = getSceneUboSize() / 4;
    if (!_sceneUniformScratch || _sceneUniformScratch.length !== size) {
        _sceneUniformScratch = new Float32Array(size);
    }
    const data = _sceneUniformScratch;
    data.fill(0);
    data.set(viewProjection, 0); // 0-15: viewProjection
    data.set(viewMatrix, 16); // 16-31: view
    data[32] = eyePosition[0]; // 32-35: vEyePosition
    data[33] = eyePosition[1];
    data[34] = eyePosition[2];
    data[35] = 0;
    if (fog) {
        data[36] = fog.mode; // 36-39: vFogInfos
        data[37] = fog.start;
        data[38] = fog.end;
        data[39] = fog.density;
        data[40] = fog.color[0]; // 40-43: vFogColor
        data[41] = fog.color[1];
        data[42] = fog.color[2];
        data[43] = 0;
    }
    device.queue.writeBuffer(sceneUBO, 0, data);
}
