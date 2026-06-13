/**
 * Babylon.js-compatible mesh hierarchy and `MeshBuilder`.
 *
 * Mirrors the Babylon.js inheritance chain:
 * `Mesh → AbstractMesh → TransformNode → Node`. Geometry is built through the
 * Babylon Lite mesh factories (which take the engine, not the scene) and
 * registered with `addToScene`. Transform properties (`position`, `rotation`,
 * `scaling`) are live views over Lite's observable vectors, so
 * `mesh.position.x = 1` and `mesh.rotation.y += 0.01` propagate; reassignment
 * (`mesh.position = new Vector3(...)`) also works.
 */

import {
    addToScene,
    removeFromScene,
    setMeshVisible,
    createBox,
    createSphere,
    createGround,
    createPlane,
    createCylinder,
    createTorus,
    createTorusKnot,
    createDisc,
    createPolyhedron,
    createTransformNode,
    setParent,
    setThinInstances,
    setThinInstanceColors,
} from "babylon-lite";
import type { Mesh as LiteMesh, TransformNode as LiteTransformNode, SceneNode, EngineContext } from "babylon-lite";

import type { Vector3 } from "../math/vector.js";
import { unsupported } from "../error.js";
import { Node } from "../node/node.js";
import type { Scene } from "../scene/scene.js";
import type { StandardMaterial, PBRMaterial } from "../materials/materials.js";
import type { NodeMaterial } from "../materials/node-material.js";

type CompatMaterial = StandardMaterial | PBRMaterial | NodeMaterial;

interface LiteVec3Like {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): void;
}

/**
 * Babylon.js `TransformNode` — a positioned, rotated, scaled scene-graph node.
 * Wraps a Lite scene node (`_node`): either a standalone Lite transform node, or
 * (for meshes) the Lite mesh itself, which also carries the transform.
 */
export class TransformNode extends Node {
    /** @internal The Lite scene node that carries this transform. */
    public readonly _node: SceneNode;

    public constructor(name: string, scene?: Scene, liteNode?: SceneNode) {
        super(name, scene);
        if (liteNode) {
            // A subclass (mesh) supplied its own Lite node and owns add-to-scene.
            this._node = liteNode;
        } else {
            this._node = createTransformNode(name) as unknown as SceneNode;
            if (scene) {
                addToScene(scene._lite, this._node as unknown as LiteTransformNode);
            }
        }
    }

    public override getClassName(): string {
        return "TransformNode";
    }

    public get position(): Vector3 {
        return this._node.position as unknown as Vector3;
    }
    public set position(value: Vector3) {
        (this._node.position as unknown as LiteVec3Like).set(value.x, value.y, value.z);
    }

    public get rotation(): Vector3 {
        return this._node.rotation as unknown as Vector3;
    }
    public set rotation(value: Vector3) {
        (this._node.rotation as unknown as LiteVec3Like).set(value.x, value.y, value.z);
    }

    public get scaling(): Vector3 {
        return this._node.scaling as unknown as Vector3;
    }
    public set scaling(value: Vector3) {
        (this._node.scaling as unknown as LiteVec3Like).set(value.x, value.y, value.z);
    }

    /** Babylon.js `setParent` — set this node's parent in the scene graph. */
    public setParent(parent: Node | null): TransformNode {
        this.parent = parent;
        return this;
    }

    protected override _applyParent(parent: Node | null): void {
        if (parent instanceof TransformNode) {
            setParent(this._node as never, parent._node as never);
        }
    }
}

/**
 * Babylon.js `AbstractMesh` — a renderable transform node with a material,
 * visibility, and shadow-receipt. Concrete meshes derive from this.
 */
export class AbstractMesh extends TransformNode {
    /** @internal Underlying Babylon Lite mesh. */
    public readonly _lite: LiteMesh;

    private _material: CompatMaterial | null = null;
    private _visible = true;

    public constructor(name: string, lite: LiteMesh, scene?: Scene) {
        super(name, scene, lite as unknown as SceneNode);
        this._lite = lite;
        this._lite.name = name;
        // Babylon Lite requires every mesh to carry a material to render, whereas
        // Babylon.js falls back to a shared `scene.defaultMaterial`. Mirror BJS by
        // assigning that default now; an explicit `mesh.material = …` overrides it.
        if (scene) {
            this.material = scene.defaultMaterial as unknown as CompatMaterial;
        }
    }

    public override getClassName(): string {
        return "AbstractMesh";
    }

    public get material(): CompatMaterial | null {
        return this._material;
    }
    public set material(value: CompatMaterial | null) {
        this._material = value;
        if (value?._lite) {
            this._lite.material = value._lite as never;
        }
    }

    public get isVisible(): boolean {
        return this._visible;
    }
    public set isVisible(value: boolean) {
        this._visible = value;
        setMeshVisible(this._lite, value);
    }

    public get receiveShadows(): boolean {
        return this._lite.receiveShadows;
    }
    public set receiveShadows(value: boolean) {
        this._lite.receiveShadows = value;
    }

    public override setEnabled(enabled: boolean): void {
        super.setEnabled(enabled);
        this.isVisible = enabled;
    }

    /** Bounding info accessor — needs a public Lite bounds accessor that does not yet exist. */
    public getBoundingInfo(): never {
        return unsupported("AbstractMesh.getBoundingInfo", "Babylon Lite does not expose a public mesh bounding-info accessor yet.");
    }

    public override dispose(): void {
        if (this._scene) {
            removeFromScene(this._scene._lite, this._lite);
        }
        super.dispose();
    }
}

/** Babylon.js `Mesh` — a concrete renderable mesh with geometry. */
export class Mesh extends AbstractMesh {
    public override getClassName(): string {
        return "Mesh";
    }

    // ── Legacy pre-MeshBuilder static creators (Babylon.js `Mesh.CreateX`) ──

    /** Legacy `Mesh.CreateSphere(name, segments, diameter, scene)`. */
    public static CreateSphere(name: string, segments: number, diameter: number, scene: Scene): Mesh {
        return MeshBuilder.CreateSphere(name, { segments, diameter }, scene);
    }

    /** Legacy `Mesh.CreateBox(name, size, scene)`. */
    public static CreateBox(name: string, size: number, scene: Scene): Mesh {
        return MeshBuilder.CreateBox(name, { size }, scene);
    }

    /** Legacy `Mesh.CreateGround(name, width, height, subdivisions, scene)`. */
    public static CreateGround(name: string, width: number, height: number, subdivisions: number, scene: Scene): Mesh {
        return MeshBuilder.CreateGround(name, { width, height, subdivisions }, scene);
    }

    /** Legacy `Mesh.CreatePlane(name, size, scene)`. */
    public static CreatePlane(name: string, size: number, scene: Scene): Mesh {
        return MeshBuilder.CreatePlane(name, { size }, scene);
    }

    /** Legacy `Mesh.CreateCylinder(name, height, diameterTop, diameterBottom, tessellation, _subdivisions, scene)`. */
    public static CreateCylinder(name: string, height: number, diameterTop: number, diameterBottom: number, tessellation: number, _subdivisions: number, scene: Scene): Mesh {
        const diameter = Math.max(diameterTop, diameterBottom);
        return MeshBuilder.CreateCylinder(name, { height, diameter, tessellation }, scene);
    }

    /** Legacy `Mesh.CreateTorus(name, diameter, thickness, tessellation, scene)`. */
    public static CreateTorus(name: string, diameter: number, thickness: number, tessellation: number, scene: Scene): Mesh {
        return MeshBuilder.CreateTorus(name, { diameter, thickness, tessellation }, scene);
    }

    /** Hardware-instanced copy — unsupported. Use native thin instances instead. */
    public createInstance(): never {
        return unsupported("Mesh.createInstance", "Babylon Lite has no hardware-instance object. Use the native thin-instance API (`setThinInstances`).");
    }

    /**
     * Babylon.js `mesh.thinInstanceSetBuffer(kind, buffer, stride)`. Maps the
     * `"matrix"` and `"color"` instance buffers onto Babylon Lite's thin-instance
     * API. Applied immediately to the Lite mesh (before the scene builds).
     */
    public thinInstanceSetBuffer(kind: string, buffer: Float32Array | null, _stride = 16): void {
        if (!buffer) {
            return;
        }
        if (kind === "matrix") {
            setThinInstances(this._lite, buffer, buffer.length / 16);
        } else if (kind === "color") {
            setThinInstanceColors(this._lite, buffer);
        }
    }

    /** Deep mesh clone — not yet wrapped. */
    public clone(): never {
        return unsupported("Mesh.clone", "Mesh cloning is not yet wrapped in the compat layer.");
    }

    /** Level-of-detail — unsupported (no LOD system in Babylon Lite). */
    public addLODLevel(): never {
        return unsupported("Mesh.addLODLevel", "Level-of-detail is not implemented in Babylon Lite.");
    }
}

/** Babylon.js `GroundMesh` — a ground plane mesh. CPU height queries are not modelled. */
export class GroundMesh extends Mesh {
    public override getClassName(): string {
        return "GroundMesh";
    }

    /** CPU height-at-coordinates query — needs a CPU heightmap accessor not present in Babylon Lite. */
    public getHeightAtCoordinates(): never {
        return unsupported("GroundMesh.getHeightAtCoordinates", "CPU height queries are not implemented in Babylon Lite.");
    }
}

/** Babylon.js `InstancedMesh` — hardware instances are not modelled; use thin instances. */
export class InstancedMesh {
    public constructor() {
        unsupported("InstancedMesh", "Babylon Lite has no hardware-instance object. Use the native thin-instance API (`setThinInstances`).");
    }
}

/**
 * Babylon.js `VertexData` — CPU vertex attribute container. Pure data; apply it
 * to a Lite mesh via the native geometry-update APIs when needed.
 */
export class VertexData {
    public positions: number[] | Float32Array | null = null;
    public normals: number[] | Float32Array | null = null;
    public uvs: number[] | Float32Array | null = null;
    public colors: number[] | Float32Array | null = null;
    public indices: number[] | Uint32Array | Uint16Array | null = null;

    /** Merge another `VertexData` into this one (concatenating attributes + reindexing). */
    public merge(other: VertexData): VertexData {
        const baseVertexCount = this.positions ? this.positions.length / 3 : 0;
        this.positions = concat(this.positions, other.positions);
        this.normals = concat(this.normals, other.normals);
        this.uvs = concat(this.uvs, other.uvs);
        this.colors = concat(this.colors, other.colors);
        if (other.indices) {
            const shifted = Array.from(other.indices, (i) => i + baseVertexCount);
            this.indices = this.indices ? [...Array.from(this.indices), ...shifted] : shifted;
        }
        return this;
    }
}

function concat(a: ArrayLike<number> | null, b: ArrayLike<number> | null): number[] | null {
    if (!a && !b) {
        return null;
    }
    return [...(a ? Array.from(a) : []), ...(b ? Array.from(b) : [])];
}

interface BoxOptions {
    size?: number;
    width?: number;
}
interface SphereOptions {
    diameter?: number;
    segments?: number;
}
interface GroundOptions {
    width?: number;
    height?: number;
    subdivisions?: number;
}
interface PlaneOptions {
    size?: number;
    width?: number;
    height?: number;
}
interface CylinderOptions {
    height?: number;
    diameter?: number;
    tessellation?: number;
}

function engineOf(scene: Scene): EngineContext {
    return scene.getEngine()._lite;
}

/**
 * Add a freshly-constructed mesh to its Lite scene. The wrapper constructor has
 * already assigned the mesh's material (a real one or `scene.defaultMaterial`),
 * but Babylon.js code commonly reassigns `mesh.material` a line later. Lite locks
 * a mesh into a render group at add time, so we defer the add until engine start
 * (via `scene._deferAdd`) to let those assignments settle.
 */
function addPrimitive(mesh: Mesh, scene: Scene): Mesh {
    scene._deferAdd(() => {
        const mat = mesh.material;
        mat?._ensureRenderable(engineOf(scene));
        // Re-bind in case the material's Lite handle resolved late (async-parsed
        // NodeMaterial, or a texture map that loaded after `mesh.material = …`).
        if (mat?._lite) {
            mesh._lite.material = mat._lite as never;
        }
        addToScene(scene._lite, mesh._lite);
    });
    return mesh;
}

/** Babylon.js `MeshBuilder` — factory namespace for primitive meshes. */
export const MeshBuilder = {
    CreateBox(name: string, options: BoxOptions, scene: Scene): Mesh {
        const lite = createBox(engineOf(scene), options.size ?? options.width ?? 1);
        return addPrimitive(new Mesh(name, lite, scene), scene);
    },

    CreateSphere(name: string, options: SphereOptions, scene: Scene): Mesh {
        const lite = createSphere(engineOf(scene), options as never);
        return addPrimitive(new Mesh(name, lite, scene), scene);
    },

    CreateGround(name: string, options: GroundOptions, scene: Scene): Mesh {
        const lite = createGround(engineOf(scene), options as never);
        return addPrimitive(new Mesh(name, lite, scene), scene);
    },

    CreatePlane(name: string, options: PlaneOptions, scene: Scene): Mesh {
        const lite = createPlane(engineOf(scene), options as never);
        return addPrimitive(new Mesh(name, lite, scene), scene);
    },

    CreateCylinder(name: string, options: CylinderOptions, scene: Scene): Mesh {
        const lite = createCylinder(engineOf(scene), options as never);
        return addPrimitive(new Mesh(name, lite, scene), scene);
    },

    CreateTorus(name: string, options: object, scene: Scene): Mesh {
        const lite = createTorus(engineOf(scene), options as never);
        return addPrimitive(new Mesh(name, lite, scene), scene);
    },

    CreateTorusKnot(name: string, options: object, scene: Scene): Mesh {
        const lite = createTorusKnot(engineOf(scene), options as never);
        return addPrimitive(new Mesh(name, lite, scene), scene);
    },

    CreateDisc(name: string, options: object, scene: Scene): Mesh {
        const lite = createDisc(engineOf(scene), options as never);
        return addPrimitive(new Mesh(name, lite, scene), scene);
    },

    CreatePolyhedron(name: string, options: object, scene: Scene): Mesh {
        const lite = createPolyhedron(engineOf(scene), options as never);
        return addPrimitive(new Mesh(name, lite, scene), scene);
    },

    // ── Known but unsupported (not present in Babylon Lite) ────────────────
    CreateLines(): never {
        return unsupported("MeshBuilder.CreateLines", "Line meshes are not implemented in Babylon Lite.");
    },

    CreateLineSystem(): never {
        return unsupported("MeshBuilder.CreateLineSystem", "Line meshes are not implemented in Babylon Lite.");
    },

    CreateDashedLines(): never {
        return unsupported("MeshBuilder.CreateDashedLines", "Dashed line meshes are not implemented in Babylon Lite.");
    },

    CreateDecal(): never {
        return unsupported("MeshBuilder.CreateDecal", "Decal projection is not implemented in Babylon Lite.");
    },

    CreateText(): never {
        return unsupported("MeshBuilder.CreateText", "Extruded font meshes are not implemented in Babylon Lite. For 2D/SDF text use the native `createTextRenderable` API.");
    },
};
