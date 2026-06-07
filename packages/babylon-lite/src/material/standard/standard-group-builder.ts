import type { EngineContext } from "../../engine/engine.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";
import { _registerStdExt } from "./standard-flags.js";
import type { StandardMaterialProps } from "./standard-material.js";

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
    const hasCulling = meshes.some((m) => !!m.thinInstances?._gpuCullingEnabled);
    const hasShadow = meshes.some((m) => m.receiveShadows) && scene.lights.some((l: { shadowGenerator?: unknown }) => !!l.shadowGenerator);

    let tiSync: ((engine: EngineContext, ti: any, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number, hasColor: boolean) => number) | undefined;
    let tiFragment: any;
    let shadowFragment: any;
    let cull: typeof import("../../mesh/thin-instance-cull-binding.js") | undefined;

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
        // GPU culling helper — fetched only when a thin-instance mesh opted in, so
        // non-culling scenes never load it (and its compute-cull dependency chain).
        if (hasCulling) {
            imports.push(
                import("../../mesh/thin-instance-cull-binding.js").then((m) => {
                    cull = m;
                })
            );
        }
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
    const result = renderableMod.buildStandardMeshRenderables(scene, meshes, { tiSync, tiFragment, shadowFragment, cull });
    // Wire the per-mesh rebuild closure used by material swap + per-pass override.
    standardGroupBuilder._rebuildSingle = result.rebuildSingle;
    return result;
};

standardGroupBuilder._materialFamily = "standard";
