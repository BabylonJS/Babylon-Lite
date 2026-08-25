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
    cloneTransformNode,
    setParent,
    setThinInstances,
    setThinInstanceColors,
    createMeshFromData,
    resizeMeshGeometry,
    updateMeshUvs,
    createGroundFromHeightMap,
    computeAabb,
    createLineSystem,
    createDashedLines,
    updateDashedLines,
    updateLineSystem,
    createLineMaterial,
    setLineMaterialColor,
} from "babylon-lite";
import type { Mesh as LiteMesh, SceneNode, EngineContext, AssetContainer as LiteAssetContainer, LineMaterial as LiteLineMaterial } from "babylon-lite";

import { Vector3, liteBackedVector3 } from "../math/vector.js";
import { Quaternion } from "../math/quaternion.js";
import { Matrix } from "../math/matrix.js";
import { Color3, Color4 } from "../math/color.js";
import { BoundingInfo } from "../culling/bounding.js";
import { unsupported } from "../error.js";
import { Node } from "../node/node.js";
import type { Scene } from "../scene/scene.js";
import { Material as CompatMaterialBase } from "../materials/materials.js";
import type { StandardMaterial, PBRMaterial } from "../materials/materials.js";
import type { NodeMaterial } from "../materials/node-material.js";
import { mergeMeshGeometry } from "./merge-mesh-geometry.js";
import type { GridMaterial } from "../materials/grid-material.js";
import type { MorphTargetManager } from "../morph/morph.js";

type CompatMaterial = StandardMaterial | PBRMaterial | NodeMaterial | GridMaterial | LinesMaterial;

class LinesMaterial extends CompatMaterialBase {
    public readonly _lite: LiteLineMaterial;

    public constructor(name: string, lite: LiteLineMaterial, scene?: Scene) {
        super(name, scene);
        this._lite = lite;
    }

    public override getClassName(): string {
        return "ShaderMaterial";
    }

    public override clone(name: string): LinesMaterial {
        return new LinesMaterial(
            name,
            createLineMaterial({
                name,
                color: this._lite.color,
                useVertexColor: this._lite.useVertexColor,
                useVertexAlpha: this._lite.useVertexAlpha,
                useThinInstances: this._lite.useThinInstances,
                useThinInstanceColors: this._lite.useThinInstanceColors,
                depthWrite: this._lite.depthWrite,
                depthCompare: this._lite.depthCompare,
            }),
            this.getScene()
        );
    }
}

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

/** @internal Return an attribute only when it has exactly one value tuple per vertex. */
function matchingVertexAttribute(data: Float32Array | null | undefined, vertexCount: number, components: number): Float32Array | undefined {
    return data?.length === vertexCount * components ? data : undefined;
}

/**
 * Babylon.js `TransformNode` — a positioned, rotated, scaled scene-graph node.
 * Wraps a Lite scene node (`_node`): either a standalone Lite transform node, or
 * (for meshes) the Lite mesh itself, which also carries the transform.
 */
export class TransformNode extends Node {
    /** @internal The Lite scene node that carries this transform. */
    public readonly _node: SceneNode;

    /**
     * @internal The Lite asset container this node was loaded from, when produced
     * by a loader. Used by the `KHR_materials_variants` helpers (which key off the
     * loaded root node) and to keep loaded meshes tied to their source asset.
     */
    public _container?: LiteAssetContainer;

    /**
     * @internal Bind a loader-produced wrapper to the scene the container was added
     * to. The loader already inserted the underlying Lite node (via
     * `addToScene(container)`), so this only wires the compat-side scene reference
     * and lists the wrapper in `scene.meshes` — it never re-inserts into Lite.
     */
    public _bindLoadedScene(scene: Scene): void {
        if (this._scene === scene) {
            return;
        }
        this._scene = scene;
        scene._registerMesh(this, this._node);
    }

    /** @internal Link an already-parented Lite node without mutating its Lite hierarchy. */
    public _adoptLoadedParent(parent: TransformNode | null): void {
        this._linkParent(parent);
    }

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
        this._linkParent(parent);
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
    protected _visible = true;

    public constructor(name: string, lite: LiteMesh, scene?: Scene) {
        super(name, scene, lite);
        this._lite = lite;
        this._lite.name = name;
        // Babylon Lite requires every mesh to carry a material to render, whereas
        // Babylon.js falls back to a shared `scene.defaultMaterial`. Mirror BJS by
        // assigning that default now; an explicit `mesh.material = …` overrides it.
        if (scene) {
            this.material = scene.defaultMaterial;
            // Canonical-registry entry keyed by the Lite mesh so `scene.meshes` (and the
            // scene by-name/-id lookups) enumerate this primitive — reconciled against the
            // Lite-core-owned list, which holds the same `_lite` object once it is added.
            scene._registerMesh(this, this._lite);
        }
    }

    public override getClassName(): string {
        return "AbstractMesh";
    }

    /** @internal An `AbstractMesh` counts as a mesh node for `getChildMeshes`. */
    protected override _isMeshNode(): boolean {
        return true;
    }

    public get material(): CompatMaterial | null {
        return this._material;
    }
    public set material(value: CompatMaterial | null) {
        this._material = value;
        const scene = this._scene;
        const renderMaterial = value ?? scene?.defaultMaterial;
        if (renderMaterial && scene?._hasStarted) {
            // The mesh already entered the scene, so the boot-time build (which
            // normally calls `_ensureRenderable` via `addPrimitive`) has run. Finalize
            // the material's GPU-facing resources now — PBR solid textures and any
            // resolved texture handles — before rebinding, so Lite's material-swap
            // rebuild (enqueued by the `_lite.material` reassignment below) sees
            // complete props. Adopt the scene so a still-loading texture assigned to
            // this material can reconcile itself on readiness.
            (renderMaterial as { _adoptScene?: (s: Scene) => void })._adoptScene?.(scene);
            renderMaterial._ensureRenderable(engineOf(scene));
        }
        if (renderMaterial?._lite) {
            this._lite.material = renderMaterial._lite as never;
        }
        if (value && "_bindMesh" in value) {
            value._bindMesh(this._lite, () => this._material === value);
        }
    }

    public get isVisible(): boolean {
        return this._visible;
    }
    public set isVisible(value: boolean) {
        this._visible = value;
        this._syncVisibility(this.isEnabled());
    }

    public get isPickable(): boolean {
        return this._lite.pickable !== false;
    }
    public set isPickable(value: boolean) {
        this._lite.pickable = value;
    }

    public get receiveShadows(): boolean {
        return this._lite.receiveShadows;
    }
    public set receiveShadows(value: boolean) {
        this._lite.receiveShadows = value;
    }

    protected override _onEffectiveEnabledStateChanged(enabled: boolean): void {
        this._syncVisibility(enabled);
    }

    /** @internal Apply local visibility and effective enabled state to Lite. */
    private _syncVisibility(enabled: boolean): void {
        const visible = this._visible && enabled;
        if (this._lite.visible !== visible) {
            setMeshVisible(this._lite, visible);
        }
    }

    /**
     * Babylon.js `mesh.getBoundingInfo()` — the mesh's AABB. `minimum`/`maximum`
     * are the local-space bounds; the returned `BoundingInfo`'s world members
     * (`minimumWorld`/`maximumWorld`/`centerWorld`/…) are derived by transforming
     * the eight local corners by the mesh's world matrix, so a mesh at (1,2,3)
     * reports correctly-offset world bounds. Babylon Lite stores `boundMin`/
     * `boundMax` (local space) on factory- and loader-built meshes; when absent
     * (e.g. a placeholder mesh whose bounds were never computed) we fold the
     * retained CPU positions through Lite's `computeAabb`. A mesh with no geometry
     * returns a degenerate zero-size box.
     */
    public getBoundingInfo(): BoundingInfo {
        const world = this._worldMatrixForBounds();
        const lo = this._lite.boundMin;
        const hi = this._lite.boundMax;
        if (lo && hi) {
            return new BoundingInfo(new Vector3(lo[0], lo[1], lo[2]), new Vector3(hi[0], hi[1], hi[2]), world);
        }
        const positions = this._lite._cpuPositions;
        if (positions && positions.length >= 3 && positions.length % 3 === 0) {
            const [min, max] = computeAabb(positions);
            if (Number.isFinite(min[0]) && Number.isFinite(min[1]) && Number.isFinite(min[2]) && Number.isFinite(max[0]) && Number.isFinite(max[1]) && Number.isFinite(max[2])) {
                return new BoundingInfo(new Vector3(min[0], min[1], min[2]), new Vector3(max[0], max[1], max[2]), world);
            }
        }
        return new BoundingInfo(new Vector3(0, 0, 0), new Vector3(0, 0, 0), world);
    }

    /** Compat handle over Babylon Lite's world matrix for bounds derivation. Returns
     *  `undefined` when the Lite node hasn't computed one (world bounds fall back to
     *  local). */
    private _worldMatrixForBounds(): Matrix | undefined {
        const wm = this._lite.worldMatrix;
        return wm ? Matrix.FromArray(wm) : undefined;
    }

    /**
     * Babylon.js `mesh.getVerticesData(kind)` — read back the CPU geometry buffer.
     * `position` / `normal` / `uv` come from the buffers Babylon Lite retains on the
     * mesh (for picking + device-loss recovery). Prefer the last compat-side value
     * for `uv2` / `tangent` / `color`, falling back to attributes retained by Lite
     * for loader- and factory-created meshes.
     */
    public getVerticesData(kind: string): Float32Array | null {
        switch (kind) {
            case "position":
                return this._lite._cpuPositions ?? null;
            case "normal":
                return this._lite._cpuNormals ?? null;
            case "uv":
                return this._lite._cpuUvs ?? null;
            case "uv2":
                return this._lastUv2 ?? this._lite._cpuUv2s ?? null;
            case "tangent":
                return this._lastTangents ?? this._lite._cpuTangents ?? null;
            case "color":
                return this._lastColors ?? this._lite._cpuColors ?? null;
            default:
                return null;
        }
    }

    /**
     * Babylon.js `mesh.setVerticesData(kind, data)` — replace a vertex attribute.
     * `position` / `normal` / `uv` / `color` / `tangent` re-upload the geometry in
     * place; the last-set `color`/`tangent` buffers are retained so successive calls
     * (e.g. set tangent then set color) keep both. Skinning/morph attributes
     * (`matricesIndices`, etc.) are accepted but not applied (Babylon Lite drives
     * skinning through its own loaded-skeleton path).
     */
    public setVerticesData(kind: string, data: number[] | Float32Array, _updatable?: boolean): void {
        const engine = this._scene?.getEngine()._lite;
        const lite = this._lite;
        if (!engine || !lite._cpuPositions || !lite._cpuIndices) {
            return;
        }
        if (kind !== "position" && kind !== "normal" && kind !== "uv" && kind !== "uv2" && kind !== "color" && kind !== "tangent") {
            return;
        }
        const f32 = data instanceof Float32Array ? data : Float32Array.from(data);
        if (kind === "uv2") {
            this._lastUv2 = f32;
        }
        if (kind === "color") {
            this._lastColors = f32;
        }
        if (kind === "tangent") {
            this._lastTangents = f32;
        }
        const positions = kind === "position" ? f32 : lite._cpuPositions;
        const vertexCount = positions.length / 3;
        const existingNormals = matchingVertexAttribute(lite._cpuNormals, vertexCount, 3);
        const normals = kind === "normal" ? f32 : (existingNormals ?? computeFlatNormals(positions, lite._cpuIndices));
        if (kind === "position") {
            this._normalsFollowIndices = !existingNormals;
        } else if (kind === "normal") {
            this._normalsFollowIndices = false;
        }
        const existingUvs = matchingVertexAttribute(lite._cpuUvs, vertexCount, 2);
        const uvs = kind === "uv" ? f32 : (existingUvs ?? (kind === "position" ? new Float32Array(vertexCount * 2) : undefined));
        const uvs2 = kind === "uv2" ? f32 : matchingVertexAttribute(this._lastUv2 ?? lite._cpuUv2s, vertexCount, 2);
        const tangents = matchingVertexAttribute(this._lastTangents ?? lite._cpuTangents, vertexCount, 4);
        const colors = matchingVertexAttribute(this._lastColors ?? lite._cpuColors, vertexCount, 4);
        resizeMeshGeometry(engine, this._lite, positions, normals, lite._cpuIndices, uvs, uvs2, tangents, colors);
    }

    /**
     * Babylon.js `mesh.getIndices()` — read back the mesh's index (topology) buffer.
     * Babylon Lite retains the indices on the mesh as a `Uint32Array` (for picking +
     * device-loss recovery), so we return that directly; a mesh with no geometry
     * returns `null`.
     */
    public getIndices(_copyWhenShared?: boolean, forceCopy?: boolean): Uint32Array | null {
        const indices = this._lite._cpuIndices;
        return indices ? (forceCopy ? indices.slice() : indices) : null;
    }

    /**
     * Babylon.js `mesh.setIndices(indices)` — replace the mesh's index (topology)
     * buffer. Babylon Lite re-uploads the geometry in place via `resizeMeshGeometry`,
     * keeping the existing position/normal/uv/tangent/color attributes and swapping
     * only the indices. Returns the mesh for chaining.
     */
    public setIndices(indices: number[] | Uint16Array | Uint32Array | Int32Array, _totalVertices?: number | null, _updatable?: boolean): this {
        const engine = this._scene?.getEngine()._lite;
        const lite = this._lite;
        if (!engine || !lite._cpuPositions) {
            return this;
        }
        const u32 = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
        const positions = lite._cpuPositions;
        const vertexCount = positions.length / 3;
        const normals = this._normalsFollowIndices
            ? computeFlatNormals(positions, u32)
            : (matchingVertexAttribute(lite._cpuNormals, vertexCount, 3) ?? computeFlatNormals(positions, u32));
        resizeMeshGeometry(
            engine,
            this._lite,
            positions,
            normals,
            u32,
            matchingVertexAttribute(lite._cpuUvs, vertexCount, 2),
            matchingVertexAttribute(this._lastUv2 ?? lite._cpuUv2s, vertexCount, 2),
            matchingVertexAttribute(this._lastTangents ?? lite._cpuTangents, vertexCount, 4),
            matchingVertexAttribute(this._lastColors ?? lite._cpuColors, vertexCount, 4)
        );
        return this;
    }

    /** @internal Retained uv2/tangent/color buffers so successive `setVerticesData` (and a bake) keep them all. */
    private _lastUv2: Float32Array | undefined;
    private _lastTangents: Float32Array | undefined;
    private _lastColors: Float32Array | undefined;
    /** @internal Position resizing generated normals from the old topology; regenerate after the next index update. */
    private _normalsFollowIndices = false;

    /** Babylon.js `mesh.getTotalVertices()` — vertex count from the position buffer. */
    public getTotalVertices(): number {
        const positions = this._lite._cpuPositions;
        return positions ? positions.length / 3 : 0;
    }

    /**
     * Babylon.js `mesh.refreshBoundingInfo()` — Babylon Lite recomputes a mesh's
     * bounds from its CPU geometry on demand (and on geometry upload), so this is a
     * no-op that returns the mesh for chaining. The deformed-pick options
     * (`applySkeleton` / `applyMorph`) are accepted for parity but not used.
     */
    public refreshBoundingInfo(_options?: unknown): this {
        return this;
    }

    /**
     * @internal Shared bake: fold `matrix` into the retained CPU geometry and
     * re-upload it. Positions transform by the full matrix; **normals by the
     * inverse-transpose of the upper 3×3** (so they stay perpendicular to the baked
     * surface under non-uniform / sheared transforms, unlike a raw 3×3 multiply) and
     * are renormalized. The retained `uv` / `uv2` / `tangent` / `color` attributes are
     * forwarded unchanged so they survive the geometry reupload rather than being
     * dropped. Returns `false` when there is no geometry to bake.
     */
    private _bakeMatrix(matrix: Matrix): boolean {
        const engine = this._scene?.getEngine()._lite;
        const lite = this._lite as {
            _cpuPositions?: Float32Array;
            _cpuNormals?: Float32Array;
            _cpuIndices?: Uint32Array;
            _cpuUvs?: Float32Array;
            _cpuUv2s?: Float32Array | null;
            _cpuTangents?: Float32Array | null;
            _cpuColors?: Float32Array | null;
        };
        const positions = lite._cpuPositions;
        const indices = lite._cpuIndices;
        if (!engine || !positions || !indices) {
            return false;
        }
        const m = matrix.m;

        const newPositions = new Float32Array(positions.length);
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i]!,
                y = positions[i + 1]!,
                z = positions[i + 2]!;
            newPositions[i] = x * m[0]! + y * m[4]! + z * m[8]! + m[12]!;
            newPositions[i + 1] = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!;
            newPositions[i + 2] = x * m[2]! + y * m[6]! + z * m[10]! + m[14]!;
        }

        let bakedIndices = indices;
        if (matrix.determinant() < 0) {
            bakedIndices = new Uint32Array(indices);
            for (let i = 0; i + 2 < bakedIndices.length; i += 3) {
                const second = bakedIndices[i + 1]!;
                bakedIndices[i + 1] = bakedIndices[i + 2]!;
                bakedIndices[i + 2] = second;
            }
        }

        let newNormals: Float32Array;
        const normals = lite._cpuNormals;
        if (normals) {
            // Transform normals by the inverse-transpose upper 3×3 so they stay
            // correct under non-uniform scale/shear, then renormalize.
            const nm = matrix.invert().transpose().m;
            newNormals = new Float32Array(normals.length);
            for (let i = 0; i < normals.length; i += 3) {
                const x = normals[i]!,
                    y = normals[i + 1]!,
                    z = normals[i + 2]!;
                let nx = x * nm[0]! + y * nm[4]! + z * nm[8]!;
                let ny = x * nm[1]! + y * nm[5]! + z * nm[9]!;
                let nz = x * nm[2]! + y * nm[6]! + z * nm[10]!;
                const len = Math.hypot(nx, ny, nz) || 1;
                nx /= len;
                ny /= len;
                nz /= len;
                newNormals[i] = nx;
                newNormals[i + 1] = ny;
                newNormals[i + 2] = nz;
            }
        } else {
            newNormals = computeFlatNormals(newPositions, bakedIndices);
        }

        const tangents = this._lastTangents ?? lite._cpuTangents ?? undefined;
        let newTangents: Float32Array | undefined;
        if (tangents) {
            newTangents = new Float32Array(tangents.length);
            for (let i = 0; i < tangents.length; i += 4) {
                const x = tangents[i]!,
                    y = tangents[i + 1]!,
                    z = tangents[i + 2]!;
                let tx = x * m[0]! + y * m[4]! + z * m[8]!;
                let ty = x * m[1]! + y * m[5]! + z * m[9]!;
                let tz = x * m[2]! + y * m[6]! + z * m[10]!;
                const len = Math.hypot(tx, ty, tz) || 1;
                tx /= len;
                ty /= len;
                tz /= len;
                newTangents[i] = tx;
                newTangents[i + 1] = ty;
                newTangents[i + 2] = tz;
                newTangents[i + 3] = tangents[i + 3]!;
            }
        }

        resizeMeshGeometry(
            engine,
            this._lite,
            newPositions,
            newNormals,
            bakedIndices,
            lite._cpuUvs,
            this._lastUv2 ?? lite._cpuUv2s ?? undefined,
            newTangents,
            this._lastColors ?? lite._cpuColors ?? undefined
        );
        return true;
    }

    /**
     * Babylon.js `mesh.bakeCurrentTransformIntoVertices()` — fold the node's local
     * transform (position / rotation / scaling) into the CPU geometry via the shared
     * {@link _bakeMatrix} helper, then reset the node transform to identity (the
     * geometry now carries it).
     */
    public bakeCurrentTransformIntoVertices(): this {
        const node = this._node;
        const q = node.rotationQuaternion;
        const matrix = Matrix.Compose(liteBackedVector3(node.scaling), { x: q.x, y: q.y, z: q.z, w: q.w }, liteBackedVector3(node.position));
        if (!this._bakeMatrix(matrix)) {
            return this;
        }
        // Reset the node transform to identity (the geometry now carries it).
        node.position.set(0, 0, 0);
        node.rotation.set(0, 0, 0);
        node.scaling.set(1, 1, 1);
        return this;
    }

    /**
     * Babylon.js `mesh.bakeTransformIntoVertices(transform)` — fold an **arbitrary**
     * matrix into the CPU geometry via the shared {@link _bakeMatrix} helper. Unlike
     * {@link bakeCurrentTransformIntoVertices}, the node's own transform is **not**
     * reset: the supplied matrix is independent of the node transform.
     */
    public bakeTransformIntoVertices(transform: Matrix): this {
        this._bakeMatrix(transform);
        return this;
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

    /**
     * @internal Wrap an already-loaded Lite mesh (or the loader's synthetic root
     * node) as a canonical compat `Mesh`. Unlike the public constructor it does
     * **not** re-insert the node into the scene (the loader already added the whole
     * container) and does **not** override the natively-loaded material — it only
     * adopts the existing Lite node. Used by the loader to give
     * `AssetContainer.meshes` real, stable-identity mesh handles.
     */
    public static _fromLite(lite: LiteMesh, container?: LiteAssetContainer, scene?: Scene): Mesh {
        const mesh = new Mesh(lite.name ?? "", lite);
        mesh._container = container;
        mesh._visible = lite.visible !== false;
        if (scene) {
            mesh._bindLoadedScene(scene);
        }
        return mesh;
    }

    /** @internal Wrap and link a complete Lite hierarchy, registering every wrapper. */
    public static _fromLiteHierarchy(
        lite: LiteMesh,
        container?: LiteAssetContainer,
        scene?: Scene,
        registry: Map<unknown, Mesh> = new Map(),
        parent: TransformNode | null = null
    ): Mesh {
        let wrapper = registry.get(lite) as Mesh | undefined;
        if (!wrapper) {
            wrapper = Mesh._fromLite(lite, container, scene);
            registry.set(lite, wrapper);
        } else if (scene) {
            wrapper._bindLoadedScene(scene);
        }
        wrapper._adoptLoadedParent(parent);
        const children = (lite as unknown as { children?: LiteMesh[] }).children;
        if (children) {
            for (const child of children) {
                Mesh._fromLiteHierarchy(child, container, scene, registry, wrapper);
            }
        }
        return wrapper;
    }

    private _morphTargetManager: MorphTargetManager | null = null;

    /**
     * Babylon.js `mesh.morphTargetManager`. Babylon Lite builds morph GPU data via
     * `createMorphTargets` and stores it on the Lite mesh; the compat manager is
     * registered with the scene so the engine builds it at start (once the base
     * CPU geometry exists) and assigns it onto the Lite mesh before registration.
     */
    public get morphTargetManager(): MorphTargetManager | null {
        return this._morphTargetManager;
    }
    public set morphTargetManager(value: MorphTargetManager | null) {
        this._morphTargetManager = value;
        if (value && this._scene) {
            this._scene._registerMorphTargetManager(this, value);
        }
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

    /**
     * Babylon.js `mesh.clone(name, newParent?, doNotCloneChildren?)` — a new mesh
     * that shares this mesh's geometry. Forwards to Lite's `cloneTransformNode`,
     * which shares the `_gpu`/skeleton/morph/thin-instance resources with the clone
     * under ref-counting (so both meshes own the buffers and they survive until the
     * last is disposed). Babylon.js uses the requested name verbatim, derives clone
     * IDs from that name plus the source ID, and prefixes descendant names with the
     * root clone name. The source material is kept (BJS shares it by reference), and
     * the clone is registered with the same compat scene through its own wrapper.
     * An omitted or `null` `newParent` keeps the source parent.
     * `doNotCloneChildren` drops the descendants Lite always clones.
     */
    public clone(name = "", newParent: Node | null = null, doNotCloneChildren?: boolean): Mesh {
        const scene = this._scene;
        const liteClone = cloneTransformNode(this._lite) as LiteMesh;
        const wrappedClone = Mesh._wrapCloneHierarchy(this, liteClone, scene, null, doNotCloneChildren === true, name);
        if (!(wrappedClone instanceof Mesh)) {
            throw new Error("Mesh.clone produced a non-mesh root.");
        }
        const clone = wrappedClone;
        if (scene) {
            addPrimitive(clone, scene, doNotCloneChildren ? () => pruneClonedDescendants(scene, liteClone) : undefined);
        }
        const parent = newParent ?? this.parent;
        if (parent) {
            clone.parent = parent;
        }
        return clone;
    }

    private static _wrapCloneHierarchy(
        source: Node | undefined,
        lite: SceneNode,
        scene: Scene | undefined,
        parent: TransformNode | null,
        skipChildren: boolean,
        cloneName?: string
    ): TransformNode {
        if (cloneName !== undefined) {
            lite.name = cloneName;
        }
        const isMesh = source instanceof Mesh || ("_gpu" in lite && "material" in lite);
        const wrapper = isMesh ? new Mesh(lite.name ?? "", lite as LiteMesh) : new TransformNode(lite.name ?? "", scene, lite);
        wrapper._container = (source as TransformNode | undefined)?._container;
        if (wrapper instanceof Mesh) {
            wrapper._scene = scene;
            if (scene) {
                scene._registerMesh(wrapper, lite);
            }
        }
        wrapper.parent = parent;
        if (source) {
            wrapper.id = wrapper instanceof Mesh ? `${wrapper.name}.${source.id}` : wrapper.name;
            wrapper.metadata = source.metadata;
            wrapper.setEnabled(source.isEnabled(false));
            if (wrapper instanceof Mesh && source instanceof Mesh) {
                wrapper.material = source.material;
                wrapper.isVisible = source.isVisible;
            }
        }
        if (!skipChildren) {
            const sourceLiteChildren = liteNodeOf(source ?? null)?.children ?? [];
            const sourceChildren = source?.getChildren(undefined, true) ?? [];
            for (let i = 0; i < lite.children.length; i++) {
                const sourceLiteChild = sourceLiteChildren[i];
                const sourceChild = sourceChildren.find((child) => liteNodeOf(child) === sourceLiteChild);
                const childName = sourceChild ? `${wrapper.name}.${sourceChild.name}` : undefined;
                Mesh._wrapCloneHierarchy(sourceChild, lite.children[i]!, scene, wrapper, false, childName);
            }
        }
        return wrapper;
    }

    /** Level-of-detail — unsupported (no LOD system in Babylon Lite). */
    public addLODLevel(): never {
        return unsupported("Mesh.addLODLevel", "Level-of-detail is not implemented in Babylon Lite.");
    }

    /**
     * Babylon.js `Mesh.MergeMeshes` — bake several meshes into one, transforming
     * each source's geometry by its world matrix. Signature:
     * `MergeMeshes(meshes, disposeSource?, allow32BitsIndices?, meshSubclass?, subdivideWithSubMeshes?, multiMultiMaterials?)`.
     * Uses the compat-local `mergeMeshGeometry`; the merged mesh lives at
     * identity (world transforms are baked in) and takes the first mesh's material.
     *
     * **Supported semantics** (everything else is rejected, never silently dropped):
     * - `disposeSource` (default `true`) — source meshes are disposed after merge.
     * - `allow32BitsIndices` — Lite indices are always uint32, so 32-bit is always
     *   available. When `allow32BitsIndices` is falsy and the merged vertex count
     *   reaches 65536, this returns `null`, exactly like Babylon.js.
     * - Positions, normals (world-transformed) and one UV set are carried.
     *
     * **Rejected** (throws `LiteCompatError`): `multiMultiMaterials` /
     * `subdivideWithSubMeshes` (Lite has no submesh / multi-material partitioning),
     * a supplied `meshSubclass` target, and sources carrying vertex colours,
     * tangents or a second UV set, or sources carrying skeleton, morph-target, or
     * vertex-animation data (Lite would have to drop them).
     */
    public static MergeMeshes(
        meshes: (Mesh | null | undefined)[],
        disposeSource = true,
        allow32BitsIndices?: boolean,
        meshSubclass?: Mesh,
        subdivideWithSubMeshes?: boolean,
        multiMultiMaterials?: boolean
    ): Mesh | null {
        const sources = meshes.filter((m): m is Mesh => !!m);
        if (sources.length === 0) {
            return null;
        }

        if (multiMultiMaterials || subdivideWithSubMeshes) {
            return unsupported(
                "Mesh.MergeMeshes(multiMultiMaterials/subdivideWithSubMeshes)",
                "Babylon Lite renders one material per mesh with no submesh partitioning, so multi-material / subdivided merges cannot be produced. Merge per-material groups into separate meshes instead."
            );
        }
        if (meshSubclass) {
            return unsupported(
                "Mesh.MergeMeshes(meshSubclass)",
                "Merging into an existing target mesh is not wrapped; the merge always returns a fresh mesh. Merge without a meshSubclass and use the result."
            );
        }

        // Babylon.js: with 16-bit indices requested, a >= 65536-vertex result cannot
        // be represented, so it returns null. Mirror that (Lite otherwise emits uint32).
        if (!allow32BitsIndices) {
            let totalVertices = 0;
            for (const mesh of sources) {
                totalVertices += mesh.getTotalVertices();
                if (totalVertices >= 65536) {
                    return null;
                }
            }
        }

        for (const mesh of sources) {
            const lite = mesh._lite as {
                _cpuColors?: unknown;
                _cpuTangents?: unknown;
                _cpuUv2s?: unknown;
                skeleton?: unknown;
                morphTargets?: unknown;
                vat?: unknown;
            };
            if (lite._cpuColors || lite._cpuTangents || lite._cpuUv2s) {
                return unsupported(
                    "Mesh.MergeMeshes(colors/tangents/uv2)",
                    `Mesh "${mesh.name}" carries vertex colours, tangents or a second UV set, which the merge does not carry. Strip those attributes before merging, or keep the meshes separate.`
                );
            }
            if (lite.skeleton || lite.morphTargets || lite.vat) {
                return unsupported(
                    "Mesh.MergeMeshes(animation)",
                    `Mesh "${mesh.name}" carries skeleton, morph-target, or vertex-animation data, which the merge does not carry. Bake the deformation before merging, or keep the meshes separate.`
                );
            }
        }

        const scene = sources[0]!.getScene();
        if (!scene) {
            return null;
        }
        const lite = mergeMeshGeometry(
            scene.getEngine()._lite,
            sources[0]!.name,
            sources.map((m) => m._lite)
        );
        const merged = new Mesh(sources[0]!.name, lite, scene);
        merged.material = sources[0]!.material;
        addPrimitive(merged, scene);

        if (disposeSource) {
            for (const mesh of sources) {
                mesh.dispose();
            }
        }
        return merged;
    }
}

function createObservableLineColor(onChange: (color: Color3) => void): Color3 {
    const color = new Color3(1, 1, 1);
    let r = color.r;
    let g = color.g;
    let b = color.b;
    Object.defineProperties(color, {
        r: {
            get: () => r,
            set: (value: number) => {
                r = value;
                onChange(color);
            },
            enumerable: true,
            configurable: true,
        },
        g: {
            get: () => g,
            set: (value: number) => {
                g = value;
                onChange(color);
            },
            enumerable: true,
            configurable: true,
        },
        b: {
            get: () => b,
            set: (value: number) => {
                b = value;
                onChange(color);
            },
            enumerable: true,
            configurable: true,
        },
    });
    return color;
}

/** Babylon.js `LinesMesh` backed by a Babylon Lite line-system mesh. */
export class LinesMesh extends Mesh {
    public readonly useVertexColor: boolean;
    public readonly useVertexAlpha: boolean;
    public intersectionThreshold = 0.1;
    private _lineMaterial: LinesMaterial;
    private readonly _color: Color3;
    private _alpha = 1;
    private _suspendLineColorSync = false;

    public constructor(name: string, sceneOrLite: Scene | LiteMesh, scene?: Scene, useVertexColor = false, useVertexAlpha = true) {
        const realScene = isCompatScene(sceneOrLite) ? sceneOrLite : scene;
        const lite = isCompatScene(sceneOrLite)
            ? createLineSystem(engineOf(sceneOrLite), {
                  name,
                  lines: [[new Vector3(0, 0, 0)]],
                  ...(useVertexColor ? { colors: [[new Color4(1, 1, 1, 1)]] } : {}),
                  useVertexAlpha,
              })
            : sceneOrLite;
        const lineMaterial = lite.material as LiteLineMaterial;
        super(name, lite, realScene);
        this.useVertexColor = useVertexColor;
        this.useVertexAlpha = useVertexAlpha;
        this._lineMaterial = new LinesMaterial("colorShader", lineMaterial, realScene);
        this.material = this._lineMaterial;
        this._color = createObservableLineColor(() => {
            if (!this._suspendLineColorSync) {
                this._syncLineColor();
            }
        });
        if (isCompatScene(sceneOrLite)) {
            addPrimitive(this, sceneOrLite);
        }
    }

    public override getClassName(): string {
        return "LinesMesh";
    }

    public get color(): Color3 {
        return this._color;
    }
    public set color(value: Color3) {
        this._suspendLineColorSync = true;
        try {
            this._color.copyFrom(value);
        } finally {
            this._suspendLineColorSync = false;
        }
        this._syncLineColor();
    }

    public get alpha(): number {
        return this._alpha;
    }
    public set alpha(value: number) {
        this._alpha = value;
        this._syncLineColor();
    }

    public override thinInstanceSetBuffer(kind: string, buffer: Float32Array | null, stride = 16): void {
        super.thinInstanceSetBuffer(kind, buffer, stride);
        if (buffer && (kind === "matrix" || kind === "color")) {
            this._enableThinLineMaterial(kind === "color" || this._lineMaterial._lite.useThinInstanceColors);
        }
    }

    private _enableThinLineMaterial(useThinInstanceColors: boolean): void {
        if (this._lineMaterial._lite.useThinInstances && this._lineMaterial._lite.useThinInstanceColors === useThinInstanceColors) {
            return;
        }
        const lite = createLineMaterial({
            name: this._lineMaterial.name,
            color: { r: this._color.r, g: this._color.g, b: this._color.b, a: this._alpha },
            useVertexColor: this.useVertexColor,
            useVertexAlpha: this.useVertexAlpha,
            useThinInstances: true,
            useThinInstanceColors,
            depthWrite: this._lineMaterial._lite.depthWrite,
            depthCompare: this._lineMaterial._lite.depthCompare,
        });
        this._lineMaterial = new LinesMaterial(this._lineMaterial.name, lite, this.getScene());
        this.material = this._lineMaterial;
    }

    private _syncLineColor(): void {
        setLineMaterialColor(this._lineMaterial._lite, { r: this._color.r, g: this._color.g, b: this._color.b, a: this._alpha });
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
    height?: number;
    depth?: number;
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
interface LineSystemBuilderOptions {
    lines: Vector3[][];
    updatable?: boolean;
    instance?: LinesMesh | null;
    colors?: Color4[][] | null;
    useVertexAlpha?: boolean;
    material?: unknown;
}
interface LinesBuilderOptions {
    points: Vector3[];
    updatable?: boolean;
    instance?: LinesMesh | null;
    colors?: Color4[];
    useVertexAlpha?: boolean;
    material?: unknown;
}
interface DashedLinesBuilderOptions {
    points: Vector3[];
    dashSize?: number;
    gapSize?: number;
    dashNb?: number;
    updatable?: boolean;
    instance?: LinesMesh | null;
    useVertexAlpha?: boolean;
    material?: unknown;
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
function addPrimitive(mesh: Mesh, scene: Scene, afterAdd?: () => void): Mesh {
    scene._deferAdd(() => {
        if (mesh.isDisposed()) {
            return;
        }
        const mat = mesh.material;
        mat?._ensureRenderable(engineOf(scene));
        // Re-bind in case the material's Lite handle resolved late (async-parsed
        // NodeMaterial, or a texture map that loaded after `mesh.material = …`).
        if (mat?._lite) {
            mesh._lite.material = mat._lite as never;
        }
        addToScene(scene._lite, mesh._lite);
        afterAdd?.();
    });
    return mesh;
}

/**
 * Drop the descendants Lite's `cloneTransformNode` always clones, for
 * `mesh.clone(..., doNotCloneChildren = true)`. `addToScene` already registered
 * them (it recurses into `children`), so `removeFromScene` here releases their
 * shared, ref-counted GPU claims — the source keeps its buffers — and detaches
 * them, leaving the clone a lone node with no leak.
 */
function pruneClonedDescendants(scene: Scene, liteClone: LiteMesh): void {
    for (const child of [...liteClone.children]) {
        removeFromScene(scene._lite, child as never);
    }
    liteClone.children.length = 0;
}

/** Babylon.js `MeshBuilder` — factory namespace for primitive meshes. */
export const MeshBuilder = {
    CreateBox(name: string, options: BoxOptions, scene: Scene): Mesh {
        const lite = createBox(engineOf(scene), options);
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

    CreateLines(name: string, options: LinesBuilderOptions, scene?: Scene | null): LinesMesh {
        return CreateLineSystem(
            name,
            {
                lines: [options.points],
                updatable: options.updatable,
                instance: options.instance,
                colors: options.colors ? [options.colors] : undefined,
                useVertexAlpha: options.useVertexAlpha,
                material: options.material,
            },
            scene
        );
    },

    CreateLineSystem(name: string, options: LineSystemBuilderOptions, scene?: Scene | null): LinesMesh {
        if (options.instance) {
            const instanceScene = options.instance.getScene() ?? scene;
            if (!instanceScene) {
                throw new Error("MeshBuilder.CreateLineSystem requires the instance to belong to a scene");
            }
            updateLineSystem(engineOf(instanceScene), options.instance._lite, {
                lines: options.lines,
                ...(options.colors ? { colors: options.colors } : {}),
            });
            return options.instance;
        }
        if (options.material) {
            return unsupported("MeshBuilder.CreateLineSystem.material", "Custom line materials are not implemented in Babylon Lite compatibility mode.");
        }
        if (!scene) {
            throw new Error("MeshBuilder.CreateLineSystem requires a scene when creating a line system");
        }
        const lite = createLineSystem(engineOf(scene), {
            name,
            lines: options.lines,
            ...(options.colors ? { colors: options.colors } : {}),
            useVertexAlpha: options.useVertexAlpha,
        });
        return addPrimitive(new LinesMesh(name, lite, scene, !!options.colors, options.useVertexAlpha ?? true), scene) as LinesMesh;
    },

    // ── Known but unsupported (not present in Babylon Lite) ────────────────
    CreateDashedLines(name: string, options: DashedLinesBuilderOptions, scene?: Scene | null): LinesMesh {
        if (options.instance) {
            const instanceScene = options.instance.getScene() ?? scene;
            if (!instanceScene) {
                throw new Error("MeshBuilder.CreateDashedLines requires the instance to belong to a scene");
            }
            updateDashedLines(engineOf(instanceScene), options.instance._lite, { points: options.points });
            return options.instance;
        }
        if (options.material) {
            return unsupported("MeshBuilder.CreateDashedLines.material", "Custom line materials are not implemented in Babylon Lite compatibility mode.");
        }
        if (!scene) {
            throw new Error("MeshBuilder.CreateDashedLines requires a scene");
        }
        const lite = createDashedLines(engineOf(scene), {
            name,
            points: options.points,
            ...(options.dashSize !== undefined ? { dashSize: options.dashSize } : {}),
            ...(options.gapSize !== undefined ? { gapSize: options.gapSize } : {}),
            ...(options.dashNb !== undefined ? { dashNb: options.dashNb } : {}),
            useVertexAlpha: options.useVertexAlpha,
        });
        return addPrimitive(new LinesMesh(name, lite, scene, false, options.useVertexAlpha ?? true), scene) as LinesMesh;
    },

    CreateDecal(): never {
        return unsupported("MeshBuilder.CreateDecal", "Decal projection is not implemented in Babylon Lite.");
    },

    CreateText(): never {
        return unsupported("MeshBuilder.CreateText", "Extruded font meshes are not implemented in Babylon Lite. For 2D/SDF text use the native `createTextRenderable` API.");
    },

    CreateTiledBox(_name?: string, _options?: object, _scene?: Scene): never {
        return unsupported(
            "MeshBuilder.CreateTiledBox",
            "Tiled box geometry is not implemented in Babylon Lite. Its per-face tile-pattern UV layout (tile size, alignment, per-tile flip/rotate patterns) is a non-trivial vertex-data generator with pattern design choices — not a mechanical addition — so it needs a Lite core mesh-builder decision."
        );
    },

    CreateTiledPlane(_name?: string, _options?: object, _scene?: Scene): never {
        return unsupported(
            "MeshBuilder.CreateTiledPlane",
            "Tiled plane geometry is not implemented in Babylon Lite. Its per-tile UV layout (tile size, alignment, per-tile flip/rotate patterns) is a non-trivial vertex-data generator with pattern design choices — not a mechanical addition — so it needs a Lite core mesh-builder decision."
        );
    },
};

// ── Standalone builder functions (Babylon.js `@babylonjs/core/Meshes/Builders/*`) ──
// Babylon.js also exports each builder as a free function (`CreateBox(name, options, scene)`,
// etc.) alongside the `MeshBuilder` namespace. These are thin aliases so ported code that
// imports the standalone functions resolves identically.

/** Babylon.js `CreateBox(name, options, scene)` (boxBuilder). */
export function CreateBox(name: string, options: BoxOptions, scene: Scene): Mesh {
    return MeshBuilder.CreateBox(name, options, scene);
}

/** Babylon.js `CreateSphere(name, options, scene)` (sphereBuilder). */
export function CreateSphere(name: string, options: SphereOptions, scene: Scene): Mesh {
    return MeshBuilder.CreateSphere(name, options, scene);
}

/** Babylon.js `CreateGround(name, options, scene)` (groundBuilder). */
export function CreateGround(name: string, options: GroundOptions, scene: Scene): Mesh {
    return MeshBuilder.CreateGround(name, options, scene);
}

/** Babylon.js `CreatePlane(name, options, scene)` (planeBuilder). */
export function CreatePlane(name: string, options: PlaneOptions, scene: Scene): Mesh {
    return MeshBuilder.CreatePlane(name, options, scene);
}

/** Babylon.js `CreateCylinder(name, options, scene)` (cylinderBuilder). */
export function CreateCylinder(name: string, options: CylinderOptions, scene: Scene): Mesh {
    return MeshBuilder.CreateCylinder(name, options, scene);
}

/** Babylon.js `CreateTorus(name, options, scene)` (torusBuilder). */
export function CreateTorus(name: string, options: object, scene: Scene): Mesh {
    return MeshBuilder.CreateTorus(name, options, scene);
}

/** Babylon.js `CreateDisc(name, options, scene)` (discBuilder). */
export function CreateDisc(name: string, options: object, scene: Scene): Mesh {
    return MeshBuilder.CreateDisc(name, options, scene);
}

/** Babylon.js `CreateLines(name, options, scene)` (linesBuilder). */
export function CreateLines(name: string, options: LinesBuilderOptions, scene?: Scene | null): LinesMesh {
    return MeshBuilder.CreateLines(name, options, scene);
}

/** Babylon.js `CreateLineSystem(name, options, scene)` (linesBuilder). */
export function CreateLineSystem(name: string, options: LineSystemBuilderOptions, scene?: Scene | null): LinesMesh {
    return MeshBuilder.CreateLineSystem(name, options, scene);
}

/** Babylon.js `CreateDashedLines(name, options, scene)` (linesBuilder). */
export function CreateDashedLines(name: string, options: DashedLinesBuilderOptions, scene?: Scene | null): LinesMesh {
    return MeshBuilder.CreateDashedLines(name, options, scene);
}

/** Babylon.js `CreateTiledBox(name, options, scene)` (tiledBoxBuilder) — throwing stub (see `MeshBuilder.CreateTiledBox`). */
export function CreateTiledBox(name?: string, options?: object, scene?: Scene): never {
    return MeshBuilder.CreateTiledBox(name, options, scene);
}

/** Babylon.js `CreateTiledPlane(name, options, scene)` (tiledPlaneBuilder) — throwing stub (see `MeshBuilder.CreateTiledPlane`). */
export function CreateTiledPlane(name?: string, options?: object, scene?: Scene): never {
    return MeshBuilder.CreateTiledPlane(name, options, scene);
}
