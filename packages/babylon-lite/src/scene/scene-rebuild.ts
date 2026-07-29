import type { SceneContext, SceneMeshGroup } from "./scene-core.js";
import type { Mesh } from "../mesh/mesh.js";
import type { MeshGroupBuildResult, MeshGroupBuilder, Renderable } from "../render/renderable.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import type { Material } from "../material/material.js";

const byOrder = (a: Renderable, b: Renderable): number => a.order - b.order;
type TransmissionTransaction = readonly [commit: () => void, rollback: () => void];

/** Reconcile+build passes an all-family rebuild will run while group membership keeps drifting. Drift can
 *  only be introduced by application code that re-materials a mesh from inside an awaited material build, so
 *  two passes settle every realistic case; the bound only exists so a pathological builder cannot spin. */
const MAX_RECONCILE_PASSES = 8;

/** Rebuild entry point re-armed when a group had to be given up on. Self-import: this module is already
 *  loaded at that point, so it costs no extra chunk. */
const rearmRebuild = (scene: SceneContext): Promise<void> => rebuildSceneRenderables(scene);

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
    await rebuildSceneGroups(scene, "pbr", force);
}

/**
 * Rebuild EVERY material group of a built scene in place so renderables pick up the scene's current
 * light/shadow topology.
 *
 * Renderables bake scene-wide state at build time: the per-mesh light INDEX list, the single- vs
 * multi-light shader permutation, whether a mesh receives shadows, and the shadow bind group of the
 * generator attached to each light. Light data itself is uploaded every frame, but none of that baked
 * state follows a light being added, removed, or swapped — this re-runs the group builders so it does.
 *
 * Called automatically when a scene whose topology changed is registered again, so the usual flow is
 * `unregisterScene` → mutate lights → `registerScene*`. Call it directly to apply a change to a scene
 * that stays registered.
 *
 * Only group-owned renderables are replaced: feature-owned entries in `scene._renderables` (skybox,
 * ground, HDR backdrop, Gaussian splats) are preserved. Node materials that captured their shadow
 * generators at parse time keep those references and are out of scope.
 *
 * No-op before the scene's initial build has run.
 *
 * @param scene - The scene to rebuild.
 */
export async function rebuildSceneRenderables(scene: SceneContext): Promise<void> {
    await rebuildSceneGroups(scene, undefined, false);
}

/** @internal Shared group-rebuild core. `family` restricts the rebuild to one material family
 *  (`undefined` rebuilds every family). */
async function rebuildSceneGroups(scene: SceneContext, family: "standard" | "pbr" | "node" | "shader" | undefined, force: boolean): Promise<void> {
    const ctx = scene;
    if (!ctx._built && !force) {
        return;
    }
    // Topology generation this rebuild starts from: the installed rebuild hook is only disarmed when the
    // rebuild fully applied AND no further removal landed while it was in flight.
    const generation = ctx._lightListVersion ?? 0;

    const engine = ctx.surface.engine;
    const retireOld = (disposers: (() => void)[]): void => {
        if (ctx._z) {
            disposers.forEach((dispose) => dispose());
        } else {
            retireGpuResources(engine, () => disposers.forEach((dispose) => dispose()));
        }
    };

    let changed = false;
    // Set when the scene was disposed, a runtime build superseded us, or a group could not be committed:
    // the pending teardown must stay queued for the next attempt / disposeScene rather than be retired
    // while some group still binds the removed resources.
    let aborted = false;
    // Set only when the traversal reached the end WITHOUT throwing. A builder rejection leaves later groups
    // still bound to the old shadow resources, so their teardown must not be retired.
    let completed = false;
    // Set when a group had to be given up on or dropped: a rebuild is armed for the next registration, so the
    // `finally` must not disarm it.
    let rearmed = false;
    // Finalisation must survive a builder rejection: groups rebuilt before the throw already replaced their
    // renderables (and scheduled their old resources for retirement), so leaving the scene unsorted with a
    // stale renderable version would render them with dangling state.
    try {
        // A material swap rebuilds a mesh's renderable through the NEW family's builder but leaves the mesh
        // listed under its OLD group (`processMaterialSwaps` never migrates membership), so a rebuild driven
        // by `_groups` alone would never revisit it — leaving it bound to the removed light's shadow
        // resources. Reconcile membership from each mesh's current material first, so every live mesh is
        // rebuilt exactly once, by the builder that owns it now. A swap landing DURING an awaited build can
        // introduce a family that had no group at all, so the traversal runs again (bounded) when membership
        // drifted; if it still drifts, a rebuild is armed for the next registration rather than leaving the
        // mesh with no group to build it.
        for (let pass = 1; ; pass++) {
            if (family !== undefined) {
                await rebuildEachGroup();
                break;
            }
            reconcileGroups(ctx);
            await rebuildEachGroup();
            if (!membershipDrifted(ctx)) {
                break;
            }
            if (pass >= MAX_RECONCILE_PASSES) {
                ctx._rebuildHook = rearmRebuild;
                rearmed = true;
                aborted = true;
                break;
            }
        }
        completed = true;
    } finally {
        if (changed) {
            ctx._renderables.sort(byOrder);
            ctx._renderableVersion++;
            ctx._materialEpoch++;
            if (ctx._built) {
                ctx._frameGraph.build();
            }
        }
        // GPU teardown that a topology change deferred (a removed shadow generator's task) is retired ONLY by a
        // full, all-family rebuild that ran to completion AGAINST THE TOPOLOGY IT STARTED FROM: a family-scoped
        // rebuild (image processing → PBR only), a rebuild that threw part-way, or one that raced another
        // removal would free resources that groups built against the older topology still bind. A completed
        // traversal with zero eligible groups counts as success, otherwise a scene whose only light was removed
        // would strand the teardown until disposal.
        if (family === undefined && completed && !aborted && (ctx._lightListVersion ?? 0) === generation) {
            const pending = ctx._pendingTopologyRetirements?.splice(0);
            if (pending?.length) {
                retireOld(pending);
            }
            // Fully applied — disarm the hook installed by `removeFromScene`. Anything else (a group left on
            // its previous build or dropped, a rejection, or another removal landing mid-flight) leaves a
            // rebuild armed so the next registration retries.
            if (!rearmed) {
                ctx._rebuildHook = undefined;
            }
        }
    }

    async function rebuildEachGroup(): Promise<void> {
        for (const [builder, meshes] of ctx._groups) {
            if (family !== undefined && builder._materialFamily !== family) {
                continue;
            }
            if (meshes.length === 0) {
                // Every member left (removed, or migrated to another family's group). Drop whenever the group
                // was previously BUILT or tracked — not just when it currently owns renderables: a build that
                // produced none still left `r` (and the runtime caches derived from it) behind, and that
                // closure baked the old light/shadow topology, so a mesh joining later would be materialised
                // through exactly the stale state this rebuild exists to replace.
                if (meshes.o || meshes.r) {
                    dropGroupOutput(builder, meshes);
                    changed = true;
                }
                continue;
            }
            const runtime = ctx._runtimeBuilds;
            await runtime?.wait(meshes);
            let unstable = false;
            const rebuild = async (): Promise<void> => {
                // Build only the meshes that currently belong to this group with this builder's material
                // family: a mesh whose material was swapped away is still listed in `_groups` (the swap path
                // does not move group membership) and its output would be discarded anyway. Pre-filtering
                // also makes any later mismatch a genuine mid-build mutation rather than pre-existing staleness.
                const groupMeshes = [...meshes].filter((mesh) => ctx.meshes.includes(mesh) && mesh.material?._buildGroup === builder);
                if (groupMeshes.length === 0) {
                    // No live member left (every mesh was removed or re-materialed): the group's previous
                    // output draws meshes that are gone, so drop it rather than leave it bound to freed
                    // buffers — and clear the tracking so a later rebuild does not look for it.
                    dropGroupOutput(builder, meshes);
                    return;
                }
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
                if (builder._materialFamily === "pbr" && groupMeshes.some((mesh) => (mesh.material as { gammaAlbedo?: boolean } | null)?.gammaAlbedo)) {
                    meshes._w = null;
                }
                if (hadBuiltGroup) {
                    dedupeGroupCleanup(ctx, cleanupStart);
                }
                const liveMeshes = new Set(
                    groupMeshes.filter(
                        (mesh) => ctx.meshes.includes(mesh) && mesh.material === materials.get(mesh) && mesh.material?._buildGroup === builder && meshes.includes(mesh)
                    )
                );
                // A MERGED renderable (no `mesh` back-reference) draws every mesh the builder was handed, so it
                // cannot be committed when the group changed during the await: a mesh removed or re-materialed
                // meanwhile is excluded from `liveMeshes` and its GPU buffers are freed, yet the merged draw
                // would still reference them. Discard this build; the caller retries against the settled
                // membership, and gives up (dropping the group's output) if it keeps racing.
                if (liveMeshes.size !== groupMeshes.length && result.renderables.some((renderable) => !renderable.mesh)) {
                    for (const mesh of groupMeshes) {
                        const built = ctx._meshDisposables.get(mesh);
                        const previous = oldByMesh.get(mesh);
                        if (built && built !== previous) {
                            for (const dispose of built) {
                                dispose();
                            }
                        }
                        if (previous && ctx.meshes.includes(mesh)) {
                            ctx._meshDisposables.set(mesh, previous);
                        } else {
                            ctx._meshDisposables.delete(mesh);
                            if (previous) {
                                // The mesh left the scene while we held its disposers out of `_meshDisposables`,
                                // so `removeFromScene`/`disposeScene` could not run them — retire them here or
                                // they leak for the engine's lifetime.
                                retireOld(previous);
                            }
                        }
                    }
                    unstable = true;
                    return;
                }
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
                // Remove the group's existing renderables only after the replacement build succeeded. The group's
                // tracked output is dropped by identity as well: a group's meshes can be MERGED into one combined
                // renderable whose `mesh` is undefined, which mesh-identity removal alone would leave behind
                // (drawing the stale pipeline alongside the rebuilt one).
                const stale = meshes.o;
                const staleSet = stale?.length ? new Set<Renderable>(stale) : null;
                for (let i = ctx._renderables.length - 1; i >= 0; i--) {
                    const existing = ctx._renderables[i]!;
                    if (liveMeshes.has(existing.mesh as Mesh) || staleSet?.has(existing)) {
                        ctx._renderables.splice(i, 1);
                    }
                }

                const kept = result.renderables.filter((renderable) => !renderable.mesh || liveMeshes.has(renderable.mesh));
                ctx._renderables.push(...kept);
                meshes.o = kept;

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
            // A merged build that raced concurrent mutation is retried against the settled membership. The
            // attempt count is bounded: if the group keeps moving, its previous output is dropped rather than
            // left drawing meshes whose buffers may already be freed.
            const MAX_ATTEMPTS = 3;
            for (let attempt = 1; ; attempt++) {
                unstable = false;
                await X(ctx, builder, rebuild);
                if (ctx._z || runtime?._d()) {
                    aborted = true;
                    return;
                }
                if (!unstable) {
                    break;
                }
                if (attempt >= MAX_ATTEMPTS) {
                    // The group keeps moving under us. Drawing nothing beats drawing meshes whose buffers may
                    // already be freed, so its output is dropped — and a rebuild is ARMED so the group comes
                    // back on the scene's next registration. Arming matters most for family-scoped callers
                    // (`setSceneImageProcessing`), which have no hook of their own and would otherwise report
                    // success while leaving the group blank.
                    dropGroupOutput(builder, meshes);
                    ctx._rebuildHook = rearmRebuild;
                    rearmed = true;
                    aborted = true;
                    break;
                }
            }
            if (unstable) {
                // Gave up on this group: the topology change has NOT been applied to it, so the removed
                // generator's resources stay queued and a rebuild stays armed for the next attempt.
                changed = true;
                continue;
            }
            changed = true;
        }
    }

    /** True when a live mesh is not in the group of the builder its CURRENT material belongs to — i.e. a
     *  material swap landed while a build was awaited, so the traversal must run again. */
    function membershipDrifted(scene: SceneContext): boolean {
        for (const mesh of scene.meshes) {
            const build = mesh.material?._buildGroup;
            if (build && !scene._groups.get(build)?.includes(mesh)) {
                return true;
            }
        }
        return false;
    }

    /** Move every live mesh into the group of the builder its CURRENT material belongs to, creating groups as
     *  needed and leaving empty ones behind (the loop drops their stale output). Only used by the all-family
     *  topology rebuild: a family-scoped rebuild must not reshuffle groups it does not rebuild. */
    function reconcileGroups(scene: SceneContext): void {
        const wanted = new Map<MeshGroupBuilder, Mesh[]>();
        for (const mesh of scene.meshes) {
            const build = mesh.material?._buildGroup;
            if (!build) {
                continue;
            }
            const list = wanted.get(build);
            if (list) {
                list.push(mesh);
            } else {
                wanted.set(build, [mesh]);
            }
        }
        for (const [build, group] of scene._groups) {
            const next = wanted.get(build) ?? [];
            if (group.length !== next.length || next.some((mesh, i) => group[i] !== mesh)) {
                group.length = 0;
                group.push(...next);
            }
            wanted.delete(build);
        }
        for (const [build, next] of wanted) {
            const group = next as SceneMeshGroup;
            scene._groups.set(build, group);
        }
    }

    /** Drop a group's tracked output from the scene: used when the group has no live member left, and as the
     *  give-up path when a merged build keeps racing concurrent mutation. Drawing nothing is the only safe
     *  option once the renderable's source meshes may have had their GPU buffers freed. */
    function dropGroupOutput(builder: MeshGroupBuilder, meshes: SceneMeshGroup): void {
        const owned = meshes.o;
        if (owned?.length) {
            const ownedSet = new Set<Renderable>(owned);
            for (let i = ctx._renderables.length - 1; i >= 0; i--) {
                if (ownedSet.has(ctx._renderables[i]!)) {
                    ctx._renderables.splice(i, 1);
                }
            }
        }
        meshes.o = undefined;
        // Drop the captured rebuild closure too: it baked the light/shadow topology of the build being
        // discarded (see the `shadowLights` / light-count scans in the standard and PBR renderable builders),
        // so a mesh joining this group later must NOT be materialised through it — it would bind shadow
        // resources this rebuild is about to retire. The material-swap drain skips a mesh whose group has no
        // `r`, so a rebuild is armed here: `buildScene` runs it on the scene's next registration, AFTER the
        // swap drain, and rebuilds every group from `scene.meshes` — which is what makes such a mesh appear.
        meshes.r = undefined;
        // The runtime mesh-build machinery caches its own closures derived from that one (per scene, and per
        // mesh); they carry the same stale topology, so they must go with it.
        ctx._runtimeBuilds?.dropBase(builder);
        ctx._rebuildHook = rearmRebuild;
        rearmed = true;
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
