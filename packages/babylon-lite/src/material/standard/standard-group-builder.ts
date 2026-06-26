import type { EngineContext } from "../../engine/engine.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";
import { _registerStdExt } from "./standard-flags.js";
import type { StdExt } from "./standard-flags.js";
import type { StandardMaterialProps } from "./standard-material.js";
import type { Mesh } from "../../mesh/mesh.js";

// Mesh-feature → StdExt dispatch registry (resolver-hook fold). Each deform/vertex feature
// (skeleton, vertex color) is installed here ONLY by its `enableStandard*()` opt-in
// (enable-standard-mesh-features.ts), which loaders/scenes call when they create such a mesh. A
// scene that never enables one keeps this `null`, so the dispatch loop below folds entirely out of
// the bundle — the same module-local-proven-null fold the stencil path uses — and non-deform
// Standard scenes (fog/skybox, Sponza, …) stay byte-identical to upstream.
export type StdMeshExtDispatch = readonly [(m: Mesh) => boolean, () => Promise<unknown>, string | null];
let _stdMeshExtDispatch: StdMeshExtDispatch[] | null = null;
/** @internal Install a mesh-feature StdExt dispatcher (called only by `enableStandard*` opt-ins).
 *  `key` names the StdExt export to register, or is `null` for chunks that self-install. */
export function _registerStdMeshExtDispatch(d: StdMeshExtDispatch): void {
    (_stdMeshExtDispatch ??= []).push(d);
}

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

/** Lazily-created singleton standard-material {@link MeshGroupBuilder}. Lazy-init
 *  keeps the module free of top-level side effects so a scene that uses no standard
 *  material tree-shakes the builder (and its renderable graph) away. */
let _standardGroupBuilder: MeshGroupBuilder | null = null;
export function getStandardGroupBuilder(): MeshGroupBuilder {
    if (_standardGroupBuilder) {
        return _standardGroupBuilder;
    }
    const builder: MeshGroupBuilder = async (scene, meshes) => {
        const hasTI = meshes.some((m) => !!m.thinInstances);
        const hasCulling = meshes.some((m) => !!m.thinInstances?._gpuCullingEnabled);
        const hasShadow = meshes.some((m) => m.receiveShadows) && scene.lights.some((l: { shadowGenerator?: unknown }) => !!l.shadowGenerator);
        const hasMorph = meshes.some((m) => !!m.morphTargets);

        let tiSync: ((engine: EngineContext, ti: any, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number, hasColor: boolean) => number) | undefined;
        let tiFragment: any;
        let shadowFragment: any;
        let morphFragment: any;
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
        if (hasMorph) {
            imports.push(
                import("../../shader/fragments/morph-fragment-core.js").then((m) => {
                    morphFragment = m.createMorphFragment;
                })
            );
        }
        // Deform/vertex mesh-feature StdExts (skeleton, vertex color) are dispatched from the
        // module-local `_stdMeshExtDispatch` registry, populated only by the `enableStandard*()`
        // opt-ins loaders/scenes call. When no feature was enabled the registry is `null` and this
        // whole block folds away, so non-deform Standard scenes stay byte-identical.
        if (_stdMeshExtDispatch) {
            for (const [pred, load, key] of _stdMeshExtDispatch) {
                if (meshes.some(pred)) {
                    imports.push(
                        load().then((mod) => {
                            if (key) {
                                _registerStdExt((mod as Record<string, StdExt>)[key]!);
                            }
                        })
                    );
                }
            }
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
        const result = renderableMod.buildStandardMeshRenderables(scene, meshes, { tiSync, tiFragment, shadowFragment, morphFragment, cull });
        // Wire the per-mesh rebuild closure used by material swap + per-pass override.
        builder._rebuildSingle = result.rebuildSingle;
        return result;
    };
    builder._materialFamily = "standard";
    return (_standardGroupBuilder = builder);
}
