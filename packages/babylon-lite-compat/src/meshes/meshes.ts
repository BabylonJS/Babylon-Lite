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
    createRibbon,
    createTube,
    createExtrudeShape,
    createTransformNode,
    setParent,
    setThinInstances,
    setThinInstanceColors,
    createMeshFromData,
    resizeMeshGeometry,
    updateMeshUvs,
    createGroundFromHeightMap,
} from "babylon-lite";
import type { Mesh as LiteMesh, SceneNode, EngineContext } from "babylon-lite";

import type { Vector3 } from "../math/vector.js";
import { liteBackedVector3 } from "../math/vector.js";
import { Quaternion } from "../math/quaternion.js";
import { unsupported } from "../error.js";
import { Node } from "../node/node.js";
import type { Scene } from "../scene/scene.js";
import type { StandardMaterial, PBRMaterial } from "../materials/materials.js";
import type { NodeMaterial } from "../materials/node-material.js";

type CompatMaterial = StandardMaterial | PBRMaterial | NodeMaterial;

/**
 * @internal Runtime discriminator for the `Mesh` constructor's two call shapes:
 * `new Mesh(name, scene)` (empty mesh, Babylon.js) vs the internal
 * `new Mesh(name, liteMesh, scene)` (geometry-backed). A compat `Scene` exposes
 * `getEngine()`; a Lite mesh does not.
 */
function isCompatScene(value: Scene | LiteMesh): value is Scene {
    return typeof (value as Scene).getEngine === "function";
}

/**
 * @internal Resolve the backing Lite scene node for a compat node. Mesh/light/
 * camera wrappers store it as `_lite`; a plain `TransformNode` stores it as
 * `_node`. (Declared as optionals because the base `Node` exposes neither.)
 */
function liteNodeOf(node: Node | null): SceneNode | null {
    if (!node) {
        return null;
    }
    const n = node as { _node?: SceneNode; _lite?: SceneNode };
    return n._node ?? n._lite ?? null;
}

// A degenerate single-triangle placeholder so an empty `new Mesh(name, scene)`
// has a valid Lite mesh (`_lite`) immediately. Replaced in place by
// `VertexData.applyToMesh` via `resizeMeshGeometry`.
const PLACEHOLDER_POSITIONS = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PLACEHOLDER_NORMALS = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
const PLACEHOLDER_UVS = new Float32Array([0, 0, 0, 0, 0, 0]);
const PLACEHOLDER_INDICES = new Uint32Array([0, 1, 2]);

/** @internal Coerce a number list / typed array to a `Float32Array` (reusing the buffer when possible). */
function toF32(data: ArrayLike<number>): Float32Array {
    return data instanceof Float32Array ? data : Float32Array.from(data);
}

/** @internal Coerce an index list / typed array to a `Uint32Array`. */
function toU32(data: ArrayLike<number>): Uint32Array {
    return data instanceof Uint32Array ? data : Uint32Array.from(data);
}

/** @internal Flat per-face normals for vertex data that omits them (Lite requires a normals buffer). */
function computeFlatNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i]! * 3;
        const b = indices[i + 1]! * 3;
        const c = indices[i + 2]! * 3;
        const ux = positions[b]! - positions[a]!;
        const uy = positions[b + 1]! - positions[a + 1]!;
        const uz = positions[b + 2]! - positions[a + 2]!;
        const vx = positions[c]! - positions[a]!;
        const vy = positions[c + 1]! - positions[a + 1]!;
        const vz = positions[c + 2]! - positions[a + 2]!;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        for (const vi of [a, b, c]) {
            normals[vi] = nx;
            normals[vi + 1] = ny;
            normals[vi + 2] = nz;
        }
    }
    return normals;
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
            this._node = createTransformNode(name);
            if (scene) {
                addToScene(scene._lite, this._node);
            }
        }
    }

    public override getClassName(): string {
        return "TransformNode";
    }

    public get position(): Vector3 {
        return liteBackedVector3(this._node.position);
    }
    public set position(value: Vector3) {
        this._node.position.set(value.x, value.y, value.z);
    }

    public get rotation(): Vector3 {
        return liteBackedVector3(this._node.rotation);
    }
    public set rotation(value: Vector3) {
        this._node.rotation.set(value.x, value.y, value.z);
    }

    public get scaling(): Vector3 {
        return liteBackedVector3(this._node.scaling);
    }
    public set scaling(value: Vector3) {
        this._node.scaling.set(value.x, value.y, value.z);
    }

    /** @internal Whether `rotationQuaternion` was explicitly set (Babylon.js returns null otherwise). */
    private _useQuat = false;

    /**
     * Babylon.js `rotationQuaternion`. Babylon Lite always drives a node's world
     * matrix from a quaternion (its euler `rotation` is a proxy over the same
     * quaternion), so this reads/writes that quaternion. Returns `null` until
     * explicitly assigned, matching Babylon.js's euler-by-default convention.
     */
    public get rotationQuaternion(): Quaternion | null {
        if (!this._useQuat) {
            return null;
        }
        const q = this._node.rotationQuaternion;
        return new Quaternion(q.x, q.y, q.z, q.w);
    }
    public set rotationQuaternion(value: Quaternion | null) {
        if (value) {
            this._useQuat = true;
            this._node.rotationQuaternion.set(value.x, value.y, value.z, value.w);
        } else {
            this._useQuat = false;
        }
    }

    /**
     * Babylon.js `setParent(node)` — reparent while **preserving world position**
     * (the child's local transform is recomputed). Distinct from the `parent`
     * setter, which keeps the local transform and lets the world move.
     */
    public setParent(parent: Node | null): TransformNode {
        this._parent = parent;
        setParent(this._node as never, liteNodeOf(parent) as never);
        return this;
    }

    protected override _applyParent(parent: Node | null): void {
        // Babylon.js `node.parent = x` keeps the child's LOCAL transform and lets
        // its world position move under the new parent (unlike `setParent`, which
        // preserves world). Mirror that with Babylon Lite's raw parent assignment.
        this._node.parent = liteNodeOf(parent);
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
        super(name, scene, lite);
        this._lite = lite;
        this._lite.name = name;
        // Babylon Lite requires every mesh to carry a material to render, whereas
        // Babylon.js falls back to a shared `scene.defaultMaterial`. Mirror BJS by
        // assigning that default now; an explicit `mesh.material = …` overrides it.
        if (scene) {
            this.material = scene.defaultMaterial;
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

    /**
     * Babylon.js `mesh.getVerticesData(kind)` — read back the CPU geometry buffer
     * for `position` / `normal` / `uv`. Babylon Lite retains these on the mesh
     * (for picking + device-loss recovery); other kinds are not stored.
     */
    public getVerticesData(kind: string): Float32Array | null {
        switch (kind) {
            case "position":
                return this._lite._cpuPositions ?? null;
            case "normal":
                return this._lite._cpuNormals ?? null;
            case "uv":
                return this._lite._cpuUvs ?? null;
            default:
                return null;
        }
    }

    /**
     * Babylon.js `mesh.setVerticesData(kind, data)` — replace a vertex attribute.
     * `position` / `normal` / `uv` / `color` re-upload the geometry in place;
     * skinning/morph attributes (`matricesIndices`, etc.) are accepted but not
     * applied (Babylon Lite drives skinning through its own loaded-skeleton path).
     */
    public setVerticesData(kind: string, data: number[] | Float32Array, _updatable?: boolean): void {
        const engine = this._scene?.getEngine()._lite;
        const lite = this._lite;
        if (!engine || !lite._cpuPositions || !lite._cpuIndices) {
            return;
        }
        if (kind !== "position" && kind !== "normal" && kind !== "uv" && kind !== "color") {
            return;
        }
        const f32 = data instanceof Float32Array ? data : Float32Array.from(data);
        const positions = kind === "position" ? f32 : lite._cpuPositions;
        const normals = kind === "normal" ? f32 : (lite._cpuNormals ?? computeFlatNormals(positions, lite._cpuIndices));
        const uvs = kind === "uv" ? f32 : lite._cpuUvs;
        const colors = kind === "color" ? f32 : undefined;
        resizeMeshGeometry(engine, this._lite, positions, normals, lite._cpuIndices, uvs, undefined, undefined, colors);
    }

    /** Babylon.js `mesh.getTotalVertices()` — vertex count from the position buffer. */
    public getTotalVertices(): number {
        const positions = this._lite._cpuPositions;
        return positions ? positions.length / 3 : 0;
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
    public constructor(name: string, sceneOrLite?: Scene | LiteMesh, scene?: Scene) {
        if (sceneOrLite !== undefined && isCompatScene(sceneOrLite)) {
            // Babylon.js `new Mesh(name, scene)` — an empty mesh whose geometry is
            // supplied later via `VertexData.applyToMesh`. Build a degenerate
            // placeholder Lite mesh so `_lite` is valid immediately, then defer the
            // scene-add until engine start (after geometry + material settle).
            const realScene = sceneOrLite;
            const lite = createMeshFromData(realScene.getEngine()._lite, name, PLACEHOLDER_POSITIONS, PLACEHOLDER_NORMALS, PLACEHOLDER_INDICES, PLACEHOLDER_UVS);
            super(name, lite, realScene);
            addPrimitive(this, realScene);
        } else {
            super(name, sceneOrLite as LiteMesh, scene);
        }
    }

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
 * Babylon.js `VertexBuffer` — the per-attribute geometry buffer. Only the `kind`
 * string constants are surfaced (used with `mesh.getVerticesData` /
 * `setVerticesData`); the buffer-object API itself is not wrapped.
 */
export const VertexBuffer = {
    PositionKind: "position",
    NormalKind: "normal",
    TangentKind: "tangent",
    UVKind: "uv",
    UV2Kind: "uv2",
    ColorKind: "color",
    MatricesIndicesKind: "matricesIndices",
    MatricesWeightsKind: "matricesWeights",
} as const;

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

    /**
     * Babylon.js `VertexData.applyToMesh(mesh)` — upload this CPU geometry onto a
     * mesh (typically one created via `new Mesh(name, scene)`). Replaces the Lite
     * mesh's geometry in place via `resizeMeshGeometry`. Normals are computed flat
     * if omitted (Babylon Lite requires a normals buffer).
     */
    public applyToMesh(mesh: Mesh): void {
        if (!this.positions || !this.indices) {
            return;
        }
        const scene = mesh.getScene();
        if (!scene) {
            return;
        }
        const engine = scene.getEngine()._lite;
        const positions = toF32(this.positions);
        const indices = toU32(this.indices);
        const normals = this.normals ? toF32(this.normals) : computeFlatNormals(positions, indices);
        const uvs = this.uvs ? toF32(this.uvs) : undefined;
        const colors = this.colors ? toF32(this.colors) : undefined;
        resizeMeshGeometry(engine, mesh._lite, positions, normals, indices, uvs, undefined, undefined, colors);
    }

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

    /**
     * Babylon.js `MeshBuilder.CreateGroundFromHeightMap(name, url, options, scene)`.
     * Babylon.js returns the mesh synchronously and fills its geometry once the
     * heightmap image loads; we mirror that by returning a placeholder `GroundMesh`
     * immediately and swapping in the real geometry (via `resizeMeshGeometry`) when
     * the async Lite `createGroundFromHeightMap` resolves. The load is tracked so
     * the engine awaits it before the scene is registered.
     */
    CreateGroundFromHeightMap(name: string, url: string, options: object, scene: Scene): Mesh {
        const engine = engineOf(scene);
        // `new GroundMesh(name, scene)` builds a placeholder + defers its scene-add
        // (Babylon.js empty-mesh path); no extra `addPrimitive` call is needed.
        const mesh = new GroundMesh(name, scene);
        scene._trackTextureLoad(
            createGroundFromHeightMap(engine, url, options as never).then((lite) => {
                // `createGroundFromHeightMap` always populates the CPU geometry buffers.
                resizeMeshGeometry(engine, mesh._lite, lite._cpuPositions!, lite._cpuNormals!, lite._cpuIndices!, lite._cpuUvs);
                // Babylon.js tiles the ground via `albedoTexture.uScale/vScale` (a material-level
                // UV scale). Babylon Lite's PBR pipeline has no material UV scale (only
                // StandardMaterial does, applied in-shader), so — exactly like the Lite-native
                // scene, which passes `uvScale` to `createGroundFromHeightMap` — bake the PBR
                // albedo tiling into the ground geometry UVs. The material's `albedoTexture` and
                // its `uScale`/`vScale` are assigned by user code *after* this heightmap load may
                // resolve, so defer the bake to engine start (after all textures load) instead of
                // reading the material here, where it would race the material setup.
                const baseUvs = lite._cpuUvs;
                if (baseUvs) {
                    scene._registerGroundUvBake(() => {
                        const groundMat = mesh.material as { albedoTexture?: { uScale?: number; vScale?: number } | null } | null;
                        const albedo = groundMat?.albedoTexture ?? null;
                        const uScale = albedo?.uScale ?? 1;
                        const vScale = albedo?.vScale ?? 1;
                        if (uScale === 1 && vScale === 1) {
                            return;
                        }
                        const scaled = new Float32Array(baseUvs.length);
                        for (let i = 0; i < baseUvs.length; i += 2) {
                            scaled[i] = baseUvs[i]! * uScale;
                            scaled[i + 1] = baseUvs[i + 1]! * vScale;
                        }
                        updateMeshUvs(engine, mesh._lite, scaled);
                        mesh._lite._cpuUvs = scaled;
                    });
                }
            })
        );
        return mesh;
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

    CreateRibbon(name: string, options: object, scene: Scene): Mesh {
        const lite = createRibbon(engineOf(scene), options as never);
        return addPrimitive(new Mesh(name, lite, scene), scene);
    },

    CreateTube(name: string, options: object, scene: Scene): Mesh {
        const lite = createTube(engineOf(scene), options as never);
        return addPrimitive(new Mesh(name, lite, scene), scene);
    },

    ExtrudeShape(name: string, options: object, scene: Scene): Mesh {
        const lite = createExtrudeShape(engineOf(scene), options as never);
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
