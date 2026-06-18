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
    /** @internal Compat meshes surfaced through `scene.meshes` (e.g. Gaussian-Splatting). */
    protected readonly _trackedMeshes: TransformNode[] = [];
    /** @internal Cameras constructed against this scene (`scene.cameras`). */
    protected readonly _cameras: Camera[] = [];
    /** @internal Lights constructed against this scene (`scene.lights`). */
    protected readonly _lights: Light[] = [];
    /** @internal Materials constructed against this scene (`scene.materials`). */
    protected readonly _materials: Material[] = [];

    /**
     * Babylon.js `scene.meshes`. Babylon Lite does not expose a public scene-mesh
     * registry, so this tracks the meshes the compat layer creates against a scene
     * which need lookup (currently Gaussian-Splatting meshes surfaced through the
     * loader). Other primitives register with the Lite scene directly.
     */
    public get meshes(): TransformNode[] {
        return this._trackedMeshes;
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

    /** @internal Track a compat mesh so it appears in `scene.meshes`. */
    public _registerMesh(mesh: TransformNode): void {
        if (!this._trackedMeshes.includes(mesh)) {
            this._trackedMeshes.push(mesh);
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
        const mi = this._trackedMeshes.indexOf(node as unknown as TransformNode);
        if (mi !== -1) {
            this._trackedMeshes.splice(mi, 1);
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

    /** Babylon.js `scene.getLightByName(name)` — first light with a matching name, else `null`. */
    public getLightByName(name: string): Light | null {
        return this._lights.find((l) => l.name === name) ?? null;
    }

    /** Babylon.js `scene.getMaterialByName(name)` — first material with a matching name, else `null`. */
    public getMaterialByName(name: string): Material | null {
        return this._materials.find((m) => m.name === name) ?? null;
    }

    /**
     * Babylon.js `scene.getMeshByName(name)`. Babylon Lite has no public scene-mesh
     * registry, so this searches the compat meshes tracked through `scene.meshes`
     * (currently meshes the loader surfaces, e.g. Gaussian-Splatting). Returns `null`
     * when not found, matching Babylon.js.
     */
    public getMeshByName(name: string): TransformNode | null {
        return this._trackedMeshes.find((m) => m.name === name) ?? null;
    }

    /** Babylon.js `scene.getMeshById(id)` — first tracked mesh whose `id` matches, else `null`. */
    public getMeshById(id: string): TransformNode | null {
        return this._trackedMeshes.find((m) => (m as unknown as { id?: string }).id === id) ?? null;
    }

    /** Babylon.js legacy `scene.getMeshByID(id)` — alias of {@link getMeshById}. */
    public getMeshByID(id: string): TransformNode | null {
        return this.getMeshById(id);
    }

    /** Babylon.js `scene.getNodeByName(name)` — searches tracked meshes, cameras, and lights. */
    public getNodeByName(name: string): Node | null {
        return this._trackedMeshes.find((m) => m.name === name) ?? this._cameras.find((c) => c.name === name) ?? this._lights.find((l) => l.name === name) ?? null;
    }
}
