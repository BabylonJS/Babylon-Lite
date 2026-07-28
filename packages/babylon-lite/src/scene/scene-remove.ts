import type { addToScene, SceneContext } from "./scene-core.js";
import { unregisterMeshScene } from "./mesh-scene-registry.js";
import type { Mesh } from "../mesh/mesh.js";
import type { LightBase } from "../light/types.js";
import type { Camera } from "../camera/camera.js";
import type { ShadowGenerator } from "../shadow/shadow-generator.js";
import type { TransformNode } from "./transform-node.js";
import type { SceneNode } from "./scene-node.js";
import type { AssetContainer } from "../asset-container.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { removeMeshFromTask } from "../frame-graph/render-task.js";
import type { RenderTask } from "../frame-graph/render-task.js";

/** Remove an entity from the scene, undoing what `addToScene` did. Accepts the same
 *  union as {@link addToScene}: a Mesh, light, camera, shadow generator, transform node,
 *  or a whole AssetContainer. Safe to call more than once (idempotent).
 *
 *  Standalone function for tree-shaking — only included when actually used. */
export function removeFromScene(scene: SceneContext, entity: Mesh | LightBase | Camera | ShadowGenerator | TransformNode | AssetContainer): void {
    // AssetContainer — undo addToScene(scene, container) field by field.
    if ("entities" in entity) {
        const container = entity as AssetContainer;
        for (const e of container.entities) {
            removeFromScene(scene, e as Mesh | LightBase | TransformNode);
        }
        if (container.camera && scene.camera === container.camera) {
            scene.camera = null;
        }
        const groups = container.animationGroups;
        if (groups?.length) {
            for (const g of groups) {
                spliceOut(scene.animationGroups, g);
            }
        }
        const hook = container._beforeRenderHook;
        if (hook) {
            spliceOut(scene._beforeRender, hook);
            container._beforeRenderHook = undefined;
        }
        return;
    }
    // Mesh — carries GPU geometry + material. Owns the only heavy removal path.
    if ("_gpu" in entity && "material" in entity) {
        removeMeshFromScene(scene, entity as unknown as Mesh);
        removeChildren(scene, entity as unknown as SceneNode);
        return;
    }
    // Non-mesh scene nodes (light, camera, shadow generator, transform node) share a
    // detach-parent + unwind-children tail; only the scene-list bookkeeping differs.
    if ("lightType" in entity) {
        // Light — drop from the scene list and remove its shadow generator with it.
        spliceOut(scene.lights, entity as LightBase);
        const sg = (entity as LightBase).shadowGenerator;
        if (sg) {
            // `disposeShadowGenerator` marks the topology itself — marking here too would bump the light-list
            // version twice for one removal and trigger a redundant UBO reupload.
            disposeShadowGenerator(scene, sg);
        } else {
            markTopologyDirty(scene);
        }
    } else if ("fov" in entity && "nearPlane" in entity) {
        // Camera — clear the scene reference if this camera is the active one.
        if (scene.camera === (entity as Camera)) {
            scene.camera = null;
        }
    } else if ("_shadowType" in entity && "_light" in entity) {
        // Shadow generator removed on its own (not via its light).
        disposeShadowGenerator(scene, entity as ShadowGenerator);
    }
    // TransformNode / any other scene-graph node needs no bookkeeping of its own.
    detachParent(entity);
    removeChildren(scene, entity as unknown as SceneNode);
}

// Compile-time symmetry guard (zero runtime cost, not part of the public API):
// removeFromScene must accept exactly the same arguments as addToScene so the two
// stay mirror images. If either signature drifts, `_ParamsEqual` resolves to `false`,
// `_AssertTrue<false>` violates its `extends true` constraint, and the build fails.
// The `declare const` is ambient — it emits no JavaScript and is never exported.
type _ParamsEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _AssertTrue<T extends true> = T;
declare const _removeMatchesAdd: _AssertTrue<_ParamsEqual<Parameters<typeof addToScene>, Parameters<typeof removeFromScene>>>;

/** Drop a shadow generator from the scene and retire its task resources exactly once.
 *  The disposable render task lives on the lazily-created task state, not the generator
 *  itself; nulling the state afterwards keeps repeat removals a safe no-op.
 *
 *  The teardown is DEFERRED, not run inline: receiver renderables built before the removal still
 *  bind this generator's shadow resources, so they must be replaced by a rebuild first
 *  (make-before-break). `rebuildSceneRenderables` drains the queue after the new bind groups exist;
 *  `disposeScene` drains it as a fallback when the app never rebuilds. */
function disposeShadowGenerator(scene: SceneContext, sg: ShadowGenerator): void {
    spliceOut(scene.shadowGenerators, sg);
    // The shadow task discovers generators through `light.shadowGenerator`, not `scene.shadowGenerators`
    // — a generator removed on its own must be unlinked from its light or it keeps being rendered.
    const light = sg._light as LightBase | undefined;
    if (light && light.shadowGenerator === sg) {
        light.shadowGenerator = undefined;
    }
    markTopologyDirty(scene);
    const state = sg._shadowTaskState;
    if (state) {
        sg._shadowTaskState = undefined;
        queueTopologyRetirement(scene, () => state._task.dispose());
    }
}

/** Queue GPU teardown that must wait until a rebuild has replaced the bind groups still referencing it.
 *  The first queued entry also registers the scene-dispose fallback, so an app that never rebuilds does not
 *  leak the resources — and `disposeScene` itself stays free of any topology-rebuild bytes. */
function queueTopologyRetirement(scene: SceneContext, retirement: () => void): void {
    if (!scene._pendingTopologyRetirements) {
        scene._pendingTopologyRetirements = [];
        scene._disposables.push(() => drainOnDispose(scene));
    }
    scene._pendingTopologyRetirements.push(retirement);
}

/** Scene-dispose fallback for retirements no rebuild ever drained. Disposing inline would risk
 *  "used in submit while destroyed" for a frame still in flight, and the engine's per-frame retirement queue
 *  can no longer help (the scene is already unregistered, so `renderFrame` returns before draining it), so
 *  wait for the GPU to finish its submitted work first. Falls back to inline when there is no live device. */
function drainOnDispose(scene: SceneContext): void {
    const pending = scene._pendingTopologyRetirements?.splice(0);
    if (!pending?.length) {
        return;
    }
    // Every retirement must run even if one throws: a single failing disposer must not strand the rest (and
    // must not surface as an unhandled rejection), mirroring how the engine drains its own retirement queue.
    const run = (): void => {
        for (const dispose of pending) {
            try {
                dispose();
            } catch {
                // Best-effort cleanup: the resource may already be gone after device loss.
            }
        }
    };
    const device = scene.surface.engine._device;
    if (device) {
        void device.queue.onSubmittedWorkDone().then(run, run);
    } else {
        run();
    }
}

/** Flag the scene for a renderable rebuild: the baked light index list, light-count permutation and
 *  shadow bind groups no longer match the scene's lights.
 *
 *  Bumps the light-list version so the lights UBO reuploads even when a light was SWAPPED for another
 *  (same count, and the per-light version sums can match), and installs the rebuild entry point that
 *  `buildScene` calls on the scene's next registration. The hook keeps the rebuild code out of every
 *  scene that never mutates topology — `scene-core` only carries an optional call. */
function markTopologyDirty(scene: SceneContext): void {
    scene._lightListVersion = (scene._lightListVersion ?? 0) + 1;
    if (scene._built) {
        scene._rebuildHook = rebuildOnNextBuild;
    }
}

/** Rebuild entry point installed on a topology change. Lazily imported so the rebuild machinery is only
 *  fetched by apps that actually mutate a built scene's lights.
 *
 *  Clears the hook only once the rebuild has completed against the CURRENT topology: the light list is
 *  keyed by `_lightListVersion`, so a removal that lands while the rebuild is in flight (or a rebuild that
 *  throws) leaves the hook armed for the next registration instead of silently dropping the change. */
async function rebuildOnNextBuild(scene: SceneContext): Promise<void> {
    const { rebuildSceneRenderables } = await import("./scene-rebuild.js");
    // The rebuild disarms this hook itself, but only once it has fully applied against the topology it
    // started from: a rejection, a group left on its previous build, or a removal landing mid-flight all
    // leave it installed so the next registration retries.
    await rebuildSceneRenderables(scene);
}

/** Remove the first occurrence of `item` from `arr` if present. */
function spliceOut<T>(arr: T[], item: T): void {
    const i = arr.indexOf(item);
    if (i >= 0) {
        arr.splice(i, 1);
    }
}

/** Clear an entity's `parent` link when it has one, so the world-matrix child registry
 *  stops retaining/walking a removed node during parent invalidation. */
function detachParent(node: unknown): void {
    if (node && typeof node === "object" && "parent" in node) {
        (node as { parent: unknown }).parent = null;
    }
}

function removeChildren(scene: SceneContext, node: SceneNode): void {
    const kids = node.children;
    if (kids?.length) {
        for (const child of [...kids]) {
            removeFromScene(scene, child as Mesh);
        }
    }
}

/** Remove a mesh from the scene and destroy its GPU resources.
 *  Internal helper — `removeFromScene` dispatches here for the Mesh case. */
function removeMeshFromScene(scene: SceneContext, mesh: Mesh): void {
    // Notify tasks that retain their own per-mesh bindings before this mesh's
    // UBOs and shared geometry are destroyed below. The hook is optional so core
    // scene removal does not statically import any feature task module.
    for (const task of scene._frameGraph._tasks) {
        task._removeMesh?.(mesh);
    }
    const fns = scene._meshDisposables.get(mesh);
    // Whether this call actually mutated scene state — used to gate the renderable
    // version bump so a no-op removal (mesh never registered) doesn't needlessly
    // invalidate the cached opaque bundle.
    let didMutate = false;
    if (fns) {
        didMutate = true;
        for (const fn of fns) {
            fn();
        }
        scene._meshDisposables.delete(mesh);
    }
    // AUX (override) view packets — depth/SSAO no-colour views another task registered on this mesh. A material
    // swap deliberately leaves these alone (see `_meshAuxDisposables`); a real removal must still free them.
    const auxFns = scene._meshAuxDisposables.get(mesh);
    if (auxFns) {
        didMutate = true;
        for (const fn of auxFns) {
            fn();
        }
        scene._meshAuxDisposables.delete(mesh);
    }
    const mi2 = scene.meshes.indexOf(mesh);
    if (mi2 >= 0) {
        scene.meshes.splice(mi2, 1);
        didMutate = true;
    }
    const i = scene._renderables.findIndex((r) => r.mesh === mesh);
    if (i >= 0) {
        scene._renderables.splice(i, 1);
        didMutate = true;
    }
    // Invalidate any auto-mirroring render task so it rebuilds its binding lists +
    // cached opaque bundle without this mesh BEFORE its GPU buffers (vertex data +
    // per-packet system UBO) are touched again. Done whenever the mesh actually
    // belonged to the scene — NOT gated on owning a standalone renderable: meshes
    // sharing a material at the initial scene build are merged into one combined
    // renderable whose `mesh` is undefined, yet their now-destroyed buffers are
    // still referenced by that renderable's update()/draw() and the cached bundle.
    // Mirrors the version bump done on add (material-swap) and initial build.
    if (didMutate) {
        scene._renderableVersion++;
    }
    // Drop from the material group registry so a later full rebuild (e.g. device-lost
    // recovery) doesn't try to re-materialize a disposed mesh.
    for (const group of scene._groups.values()) {
        const gi = group.indexOf(mesh);
        if (gi >= 0) {
            group.splice(gi, 1);
        }
    }
    // Drop any pending swap-queue entry (mesh added then removed before the drain).
    const qi = scene._materialSwapQueue.indexOf(mesh);
    if (qi >= 0) {
        scene._materialSwapQueue.splice(qi, 1);
    }
    scene._runtimeBuilds?.remove(mesh);
    // Deregister from the world-matrix push registry so a long-lived parent stops
    // retaining/traversing this disposed child on every invalidation. (The parent→
    // child reference is new with the push model; reparent already deregisters, but
    // removal does not go through the parent setter otherwise.)
    mesh.parent = null;
    // Frame-graph eviction: the scene always has a frame graph (created in
    // createSceneContext). Walk its render-pass tasks and drop any binding whose
    // source mesh matches. RenderTasks are identified by carrying `_renderables`
    // (a `_config` field alone is NOT sufficient — post/effect tasks also have one).
    for (const task of scene._frameGraph._tasks) {
        if ("_renderables" in (task as object)) {
            removeMeshFromTask(task as RenderTask, mesh);
        }
    }
    // Free the mesh's shared GPU buffers only when this was its LAST owning scene — a single
    // `Mesh` may be added to several scenes, and `disposeMeshGpu` destroys buffers they all share.
    if (unregisterMeshScene(scene, mesh)) {
        disposeMeshGpu(mesh);
    }
}
