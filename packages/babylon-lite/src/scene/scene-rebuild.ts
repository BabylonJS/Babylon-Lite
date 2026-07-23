import type { SceneContext } from "./scene-core.js";
import type { Mesh } from "../mesh/mesh.js";
import type { MeshGroupBuildResult, Renderable } from "../render/renderable.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import type { Material } from "../material/material.js";

const byOrder = (a: Renderable, b: Renderable): number => a.order - b.order;
type TransmissionTransaction = readonly [commit: () => void, rollback: () => void];

/**
 * Rebuild the PBR material group(s) of a scene in place, recompiling their pipelines.
 *
 * Needed after a scene-wide COMPILE-TIME PBR shader feature changes — tone mapping being
 * the first case. `rebuildMaterial` cannot do this: it reuses the per-scene composer
 * closure captured at build time (which already baked in the tone-mapping decision), so
 * it only rebuilds bind groups/pipelines from the SAME shader source. This re-runs the
 * group builder from scratch, so the scene-wide feature scan and WGSL composition run
 * again with the current `imageProcessing` configuration.
 *
 * Scoped to the PBR family (the only family whose shaders bake image-processing state).
 * PBR group builders return no scene-UBO updater, so none is re-registered here; if this
 * is ever generalized to families that own an updater, updater replacement must be added.
 *
 * No-op before the scene's initial build has run (nothing to rebuild yet).
 *
 * @param scene - The scene whose PBR pipelines should be rebuilt.
 */
export async function rebuildScenePbrPipelines(scene: SceneContext, force = false): Promise<void> {
    const ctx = scene;
    if (!ctx._built && !force) {
        return;
    }

    const engine = ctx.surface.engine;
    const retireOld = (disposers: (() => void)[]): void => {
        if (ctx._z) {
            disposers.forEach((dispose) => dispose());
        } else {
            retireGpuResources(engine, () => disposers.forEach((dispose) => dispose()));
        }
    };

    let changed = false;
    for (const [builder, meshes] of ctx._groups) {
        if (builder._materialFamily !== "pbr" || meshes.length === 0) {
            continue;
        }
        const runtime = ctx._runtimeBuilds;
        await runtime?.wait(meshes);
        const rebuild = async (): Promise<void> => {
            const groupMeshes = [...meshes];
            const hadBuiltGroup = !!meshes.r;
            const cleanupStart = ctx._disposables.length;
            // Capture the existing per-mesh teardown closures WITHOUT running them yet. The teardown
            // releases each material's refcounted GPU textures (and destroys the old per-mesh UBOs); running
            // it before the rebuild could drop a shared texture's refcount to zero and destroy it, leaving
            // the freshly built bind groups pointing at a destroyed texture ("Destroyed texture used in a
            // submit"). Instead we rebuild first (make-before-break): the builder re-acquires the same
            // textures, bumping their refcount, so running the old teardown afterwards nets no change and the
            // textures stay alive.
            const oldByMesh = new Map<Mesh, (() => void)[]>();
            const materials = new Map(groupMeshes.map((mesh) => [mesh, mesh.material] as const));
            for (const mesh of groupMeshes) {
                const disposers = ctx._meshDisposables.get(mesh);
                if (disposers) {
                    oldByMesh.set(mesh, disposers);
                    ctx._meshDisposables.delete(mesh);
                }
            }

            // Re-run the builder — re-scans meshes for scene-wide features, recompiles pipelines, and
            // overwrites each mesh's _meshDisposables with fresh teardown closures (re-acquiring textures).
            let result: MeshGroupBuildResult;
            let transmission: TransmissionTransaction | undefined;
            ctx._p = (value) => {
                transmission = value;
                return true;
            };
            try {
                result = await builder(ctx, groupMeshes);
            } catch (error) {
                transmission?.[1]();
                for (const mesh of groupMeshes) {
                    const previous = oldByMesh.get(mesh);
                    const built = ctx._meshDisposables.get(mesh);
                    if (built && built !== previous) {
                        for (const dispose of built) {
                            dispose();
                        }
                    }
                    const live = ctx.meshes.includes(mesh) && mesh.material === materials.get(mesh) && mesh.material?._buildGroup === builder && meshes.includes(mesh);
                    if (previous && live) {
                        ctx._meshDisposables.set(mesh, previous);
                    } else {
                        ctx._meshDisposables.delete(mesh);
                        if (previous) {
                            retireOld(previous);
                        }
                    }
                }
                throw error;
            } finally {
                delete ctx._p;
            }
            if (ctx._z || runtime?._d()) {
                transmission?.[1]();
                for (const mesh of groupMeshes) {
                    const built = ctx._meshDisposables.get(mesh);
                    const previous = oldByMesh.get(mesh);
                    if (built && built !== previous) {
                        for (const dispose of built) {
                            dispose();
                        }
                    }
                    ctx._meshDisposables.delete(mesh);
                }
                for (const dispose of ctx._disposables.splice(0)) {
                    dispose();
                }
                const oldDisposers = [...oldByMesh.values()].flat();
                retireOld(oldDisposers);
                return;
            }
            transmission?.[0]();
            builder._rebuildSingle = result.rebuildSingle;
            meshes.r = ctx._runtimeBuilds?.base(builder, result.rebuildSingle) ?? result.rebuildSingle;
            if (hadBuiltGroup) {
                dedupeGroupCleanup(ctx, cleanupStart);
            }
            const liveMeshes = new Set(
                groupMeshes.filter((mesh) => ctx.meshes.includes(mesh) && mesh.material === materials.get(mesh) && mesh.material?._buildGroup === builder && meshes.includes(mesh))
            );
            const rebuiltMaterials = new Set<Material>();
            for (const mesh of groupMeshes) {
                if (!liveMeshes.has(mesh)) {
                    const previous = oldByMesh.get(mesh);
                    const built = ctx._meshDisposables.get(mesh);
                    if (built && built !== previous) {
                        for (const dispose of built) {
                            dispose();
                        }
                    }
                    if (previous && ctx.meshes.includes(mesh)) {
                        ctx._meshDisposables.set(mesh, previous);
                        oldByMesh.delete(mesh);
                    } else {
                        ctx._meshDisposables.delete(mesh);
                    }
                    continue;
                }
                rebuiltMaterials.add(mesh.material);
                ctx._runtimeBuilds?.reset(mesh);
            }
            for (const material of rebuiltMaterials) {
                material._csmGen = (material._csmGen ?? 0) + 1;
            }
            // Remove the group's existing renderables only after the replacement build succeeded.
            for (let i = ctx._renderables.length - 1; i >= 0; i--) {
                if (liveMeshes.has(ctx._renderables[i]!.mesh as Mesh)) {
                    ctx._renderables.splice(i, 1);
                }
            }

            ctx._renderables.push(...result.renderables.filter((renderable) => !renderable.mesh || liveMeshes.has(renderable.mesh)));

            // Tear down the OLD per-mesh GPU state now that the rebuild is complete: destroys the old UBOs
            // (no longer referenced by the new bind groups) and releases the textures the builder just
            // re-acquired, so shared textures' refcounts return to their pre-rebuild value and stay alive.
            //
            // This must NOT run synchronously: the old per-mesh/material UBOs may still be referenced by a
            // next frame command buffer, and destroying them now hits the WebGPU validation error
            // "Buffer used in submit while destroyed". Retire after that frame submits and drains, mirroring
            // processMaterialSwaps. The make-before-break
            // refcount invariant holds across the defer: the builder already re-acquired the shared textures
            // (refcount bumped), so they stay alive until the deferred release nets the refcount back down.
            const oldDisposers = [...oldByMesh.values()].flat();
            retireOld(oldDisposers);
        };

        const { X } = await import("./scene-runtime-mesh-build.js");
        await X(ctx, builder, rebuild);
        if (ctx._z || runtime?._d()) {
            return;
        }
        changed = true;
    }

    if (changed) {
        ctx._renderables.sort(byOrder);
        ctx._renderableVersion++;
        ctx._materialEpoch++;
        if (ctx._built) {
            ctx._frameGraph.build();
        }
    }

    function dedupeGroupCleanup(scene: SceneContext, start: number): void {
        const existing = new Set(scene._disposables.slice(0, start));
        for (let i = scene._disposables.length - 1; i >= start; i--) {
            if (existing.has(scene._disposables[i]!)) {
                scene._disposables.splice(i, 1);
            }
        }
    }
}
