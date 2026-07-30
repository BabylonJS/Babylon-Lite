/**
 * Babylon.js-compatible `AbstractScene` — the base of the `Scene` class.
 *
 * In Babylon.js the scene class chain is `Scene extends AbstractScene`, where
 * `AbstractScene` owns the entity collections (`meshes`, `cameras`, `lights`,
 * `materials`, …) and the by-name lookups over them. The compat layer mirrors
 * that split so `instanceof AbstractScene` and the inherited collection API
 * behave as ported code expects. {@link Scene} adds the engine-backed rendering,
 * environment, animation, and lifecycle surface on top.
 */

import type { Node } from "../node/node.js";
import type { Camera } from "../cameras/cameras.js";
import type { Light } from "../lights/lights.js";
import type { TransformNode } from "../meshes/meshes.js";
import type { Material } from "../materials/materials.js";

export abstract class AbstractScene {
    /**
     * @internal Canonical compat mesh-wrapper registry, keyed by the Lite node each
     * wrapper carries. Kept in sync with the Lite-core-owned scene list: a wrapper is
     * registered when its mesh is constructed against the scene and dropped on dispose,
     * mirroring the core `addToScene` / `removeFromScene` it drives. `scene.meshes` is
     * derived from this so **every** compat mesh is enumerable — ordinary primitives
     * (which register straight with the Lite scene) as well as the loader-surfaced
     * Gaussian-Splatting meshes, which the old array only ever held.
     */
    protected readonly _meshWrappers = new Map<object, TransformNode>();
    /** @internal Stable Babylon.js-compatible array returned by `scene.meshes`. */
    protected readonly _meshes: TransformNode[] = [];
    /** @internal Reused scratch array for reconciling Lite-core mesh order. */
    protected readonly _orderedCoreMeshes: TransformNode[] = [];
    /** @internal Reused membership set for linear-time mesh-order reconciliation. */
    protected readonly _orderedCoreMeshSet = new Set<TransformNode>();
    /** @internal Cameras constructed against this scene (`scene.cameras`). */
    protected readonly _cameras: Camera[] = [];
    /** @internal Lights constructed against this scene (`scene.lights`). */
    protected readonly _lights: Light[] = [];
    /** @internal Materials constructed against this scene (`scene.materials`). */
    protected readonly _materials: Material[] = [];

    /**
     * @internal The Lite-core-owned mesh list backing `scene.meshes`. The concrete
     * {@link Scene} overrides this to return its Lite `SceneContext.meshes` (the
     * authoritative list); the abstract base owns no Lite scene, so it returns none.
     * Returning the core meshes directly is not an option (they are Lite `Mesh`
     * objects, not compat wrappers) — they only provide the authoritative membership
     * and order that {@link meshes} maps back onto canonical wrappers.
     */
    protected _coreMeshList(): readonly object[] {
        return [];
    }

    /**
     * Babylon.js `scene.meshes` — the compat mesh wrappers in the scene. Backed by the
     * canonical {@link _meshWrappers} registry and kept in sync with the Lite-core-owned
     * list: the core list ({@link _coreMeshList}) supplies authoritative membership and
     * ordering, mapped back to each mesh's canonical wrapper so the returned handles are
     * the right type and keep wrapper identity. Wrappers not yet mirrored into the core
     * list (transform-only loader roots, primitives whose scene-add is deferred to engine
     * start, and Gaussian-Splatting meshes that register their renderables outside
     * `scene.meshes`) retain their registration positions.
     */
    public get meshes(): TransformNode[] {
        const orderedCore = this._orderedCoreMeshes;
        const orderedCoreSet = this._orderedCoreMeshSet;
        orderedCore.length = 0;
        orderedCoreSet.clear();
        for (const core of this._coreMeshList()) {
            const wrapper = this._meshWrappers.get(core);
            if (wrapper && !orderedCoreSet.has(wrapper)) {
                orderedCore.push(wrapper);
                orderedCoreSet.add(wrapper);
            }
        }

        let orderedIndex = 0;
        for (let i = 0; i < this._meshes.length; i++) {
            if (orderedCoreSet.has(this._meshes[i]!)) {
                this._meshes[i] = orderedCore[orderedIndex++]!;
            }
        }
        return this._meshes;
    }

    /** Babylon.js `scene.cameras` — every camera constructed against this scene. */
    public get cameras(): Camera[] {
        return this._cameras;
    }

    /** Babylon.js `scene.lights` — every light constructed against this scene. */
    public get lights(): Light[] {
        return this._lights;
    }

    /** Babylon.js `scene.materials` — every material constructed against this scene. */
    public get materials(): Material[] {
        return this._materials;
    }

    /**
     * @internal Register a compat mesh wrapper so it appears in `scene.meshes`. Keyed
     * by the Lite node the wrapper carries (`liteKey`) so it can be reconciled with the
     * core-owned list — pass an `AbstractMesh`'s `_lite`; loader-surfaced meshes whose
     * Lite node is not a core scene mesh (Gaussian Splatting) key by the wrapper itself.
     */
    public _registerMesh(mesh: TransformNode, liteKey: object = mesh): void {
        const registered = this._meshWrappers.get(liteKey);
        if (registered && registered !== mesh) {
            return;
        }
        if (!registered) {
            this._meshWrappers.set(liteKey, mesh);
        }
        if (!this._meshes.includes(mesh)) {
            this._meshes.push(mesh);
        }
    }

    /** @internal Register a camera so it appears in `scene.cameras`. */
    public _registerCamera(camera: Camera): void {
        if (!this._cameras.includes(camera)) {
            this._cameras.push(camera);
        }
    }

    /** @internal Register a light so it appears in `scene.lights`. */
    public _registerLight(light: Light): void {
        if (!this._lights.includes(light)) {
            this._lights.push(light);
        }
    }

    /** @internal Register a material so it appears in `scene.materials`. */
    public _registerMaterial(material: Material): void {
        if (!this._materials.includes(material)) {
            this._materials.push(material);
        }
    }

    /** @internal Remove a node from the camera / light / mesh registries on dispose. */
    public _unregisterNode(node: Node): void {
        const ci = this._cameras.indexOf(node as unknown as Camera);
        if (ci !== -1) {
            this._cameras.splice(ci, 1);
        }
        const li = this._lights.indexOf(node as unknown as Light);
        if (li !== -1) {
            this._lights.splice(li, 1);
        }
        for (const [key, wrapper] of this._meshWrappers) {
            if (wrapper === (node as unknown as TransformNode)) {
                this._meshWrappers.delete(key);
            }
        }
        const mi = this._meshes.indexOf(node as unknown as TransformNode);
        if (mi !== -1) {
            this._meshes.splice(mi, 1);
        }
    }

    /** @internal Remove a material from `scene.materials` on dispose. */
    public _unregisterMaterial(material: Material): void {
        const i = this._materials.indexOf(material);
        if (i !== -1) {
            this._materials.splice(i, 1);
        }
    }

    /** Babylon.js `scene.getCameraByName(name)` — first camera with a matching name, else `null`. */
    public getCameraByName(name: string): Camera | null {
        return this._cameras.find((c) => c.name === name) ?? null;
    }

    /** Babylon.js `scene.getCameraById(id)` — first camera whose `id` matches, else `null`. */
    public getCameraById(id: string): Camera | null {
        return this._cameras.find((c) => (c as unknown as { id?: string }).id === id) ?? null;
    }

    /** Babylon.js `scene.getLightByName(name)` — first light with a matching name, else `null`. */
    public getLightByName(name: string): Light | null {
        return this._lights.find((l) => l.name === name) ?? null;
    }

    /** Babylon.js `scene.getLightById(id)` — first light whose `id` matches, else `null`. */
    public getLightById(id: string): Light | null {
        return this._lights.find((l) => (l as unknown as { id?: string }).id === id) ?? null;
    }

    /** Babylon.js `scene.getMaterialByName(name)` — first material with a matching name, else `null`. */
    public getMaterialByName(name: string): Material | null {
        return this._materials.find((m) => m.name === name) ?? null;
    }

    /** Babylon.js `scene.getMaterialById(id)` — first material whose `id` matches, else `null`. */
    public getMaterialById(id: string): Material | null {
        return this._materials.find((m) => (m as unknown as { id?: string }).id === id) ?? null;
    }

    /**
     * Babylon.js `scene.getMeshByName(name)` — first mesh in {@link meshes} with a
     * matching name, else `null`. Enumerates the full canonical mesh registry
     * (primitives + loader-surfaced meshes), not just the loader-surfaced subset.
     */
    public getMeshByName(name: string): TransformNode | null {
        return this.meshes.find((m) => m.name === name) ?? null;
    }

    /** Babylon.js `scene.getMeshById(id)` — first mesh whose `id` matches, else `null`. */
    public getMeshById(id: string): TransformNode | null {
        return this.meshes.find((m) => (m as unknown as { id?: string }).id === id) ?? null;
    }

    /** Babylon.js legacy `scene.getMeshByID(id)` — alias of {@link getMeshById}. */
    public getMeshByID(id: string): TransformNode | null {
        return this.getMeshById(id);
    }

    /** Babylon.js `scene.getNodeByName(name)` — searches meshes, cameras, and lights. */
    public getNodeByName(name: string): Node | null {
        return this.meshes.find((m) => m.name === name) ?? this._cameras.find((c) => c.name === name) ?? this._lights.find((l) => l.name === name) ?? null;
    }

    /** Babylon.js `scene.getNodeById(id)` — searches meshes, cameras, and lights by `id`. */
    public getNodeById(id: string): Node | null {
        const byId = (n: { id?: string }): boolean => n.id === id;
        return (
            this.meshes.find((m) => byId(m as unknown as { id?: string })) ??
            this._cameras.find((c) => byId(c as unknown as { id?: string })) ??
            this._lights.find((l) => byId(l as unknown as { id?: string })) ??
            null
        );
    }
}
