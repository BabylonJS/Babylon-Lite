import type { EngineContext } from "../../engine/engine.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import { _registerStdExt, STD_SCENE_FOG } from "./standard-flags.js";
import type { StdExt } from "./standard-flags.js";
import type { StandardMaterialProps, StandardSceneShaderContext } from "./standard-material.js";

// ─── Durable opt-in mesh-feature preload seam ───────────────────────
//
// An opt-in Standard mesh-feature ext (e.g. skeletal skinning) must be present in the
// GLOBAL ext registry not only for the initial group build but for any LATER
// SYNCHRONOUS `_rebuildSingle` — a skeletal mesh added AFTER `registerScene` (material
// swap / per-pass override) cannot itself `import()`. The old design gated the import
// on `meshes.some(isSkeletal)` at initial-build time, so a scene whose first group had
// no skeletal mesh never imported the fragment and late skeletal meshes silently
// rendered bind-pose.
//
// Instead each enabler (`enableStandardSkeleton()`) calls `_preloadStdMeshExt()`, which
// EAGERLY imports the fragment and registers the ext the moment the enabler runs
// (before `registerScene`). Registration is global + persistent, so it is durable
// across late mesh adds and material swaps. The group builder additionally awaits any
// pending preloads before its first build as a backstop. Zero bytes when no enabler is
// called — the enabler module (and this import) fully tree-shakes away.
let _stdMeshExtPreloads: Promise<void>[] | null = null;

/** @internal Eagerly import + globally register an opt-in Standard mesh-feature ext so
 *  it is available for both the initial build and any later synchronous rebuild. */
export function _preloadStdMeshExt(load: () => Promise<unknown>, key: string): void {
    const promise = load().then((mod) => {
        _registerStdExt((mod as Record<string, StdExt>)[key]!);
    });
    (_stdMeshExtPreloads ??= []).push(promise);
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
        let tiUpdate: ((engine: EngineContext, ti: any, hasColor: boolean, indexCount: number) => GPUBuffer | null) | undefined;
        let tiFragment: any;
        let shadowFragment: any;
        let morphFragment: any;
        let cull: typeof import("../../mesh/thin-instance-cull-binding.js") | undefined;
        let fogFragment: ShaderFragment | null = null;

        const imports: Promise<any>[] = [];
        if (hasTI) {
            imports.push(
                import("../../mesh/thin-instance-gpu.js").then((m) => {
                    tiSync = m.syncThinInstanceBuffers;
                    tiUpdate = m.syncThinInstanceForDraw;
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
        if (scene.fog) {
            imports.push(
                import("./std-fog-wgsl.js").then((m) => {
                    fogFragment = m.createStandardFogFragment();
                })
            );
        }
        if (_stdMeshExtPreloads) {
            for (const preload of _stdMeshExtPreloads) {
                imports.push(preload);
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
        const sceneShader: StandardSceneShaderContext | null = scene.fog ? { _features: STD_SCENE_FOG, _fragments: [fogFragment!] } : null;
        const result = renderableMod.buildStandardMeshRenderables(scene, meshes, { tiSync, tiUpdate, tiFragment, shadowFragment, morphFragment, cull, sceneShader });
        // Wire the per-mesh rebuild closure used by material swap + per-pass override.
        builder._rebuildSingle = result.rebuildSingle;
        return result;
    };
    builder._materialFamily = "standard";
    return (_standardGroupBuilder = builder);
}
