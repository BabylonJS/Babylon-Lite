/**
 * Part Renderer — the single shared rendering path for every Part .
 *
 * Two thin-instanced unit-box meshes sharing ONE material:
 *   - caster mesh: all dynamic parts — casts + receives shadows.
 *   - receiver mesh: the baseplate (and other huge static parts) — receives
 *     only. Kept separate so its giant AABB doesn't blow up the shadow ortho
 *     auto-fit and crush shadow-map resolution (see task-board findings).
 *
 * Per-instance TRS matrix + RGBA color; two draw calls for the whole world.
 * The shared standard material carries the stud plugin (local-top faces) and
 * a white diffuse so per-instance colors supply the hue.
 *
 * Instance handles are stable across removals. The engine swap-removes
 * matrices (`removeThinInstance` moves the last instance into the freed
 * slot); this module mirrors that swap in the colors array and its
 * handle⇄slot maps so callers never see slots move.
 *
 * The engine's shadow ortho auto-fit and frustum logic read
 * `mesh.boundMin/boundMax`; for thin-instanced meshes those default to a unit
 * box at the origin, so this module maintains them over all instance AABBs.
 */

import type { EngineContext, Mesh, SceneContext } from "babylon-lite";
import {
    addThinInstance,
    mat4Compose,
    mat4Identity,
    createBox,
    createMeshFromData,
    createStandardMaterial,
    enableThinInstanceGpuCulling,
    removeThinInstance,
    setThinInstanceColors,
    setThinInstanceCount,
    setThinInstanceMatrix,
    setThinInstances,
} from "babylon-lite";

import { createStudMaterialPlugin } from "./stud-material-plugin.js";
import { createStudTextures } from "./stud-texture.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Stable instance handle. Valid until `freeInstance`. */
export type InstanceHandle = number;

type PoolId = "caster" | "receiver" | "wedge";

interface InstancePool {
    readonly mesh: Mesh;
    colors: Float32Array; // capacity * 4, mirrors engine slot order
    slotToHandle: number[];
    handleToSlot: Map<number, number>;
    handleAabbs: Map<number, [number, number, number, number, number, number]>;
}

export interface PartRenderer {
    /** Dynamic block parts — shadow caster + receiver. Register as a shadow caster. */
    readonly mesh: Mesh;
    /** Static huge parts (baseplate) — shadow receiver only. */
    readonly receiverMesh: Mesh;
    /** Wedge parts — shadow caster + receiver. Register as a shadow caster. */
    readonly wedgeMesh: Mesh;
    /** @internal */
    _state: PartRendererState;
}

interface PartRendererState {
    pools: Record<PoolId, InstancePool>;
    handlePool: Map<number, PoolId>;
    nextHandle: number;
}

export interface AllocOptions {
    /** Place the instance on the receiver-only mesh (baseplate). Default false. */
    receiverOnly?: boolean;
    /** Geometry pool. Wedges are stud-free. Default "block". */
    shape?: "block" | "wedge";
}

/** Stud-plugin alpha meaning "no studs on any face" (index 6; see plugin). */
const NO_STUDS_ALPHA = (6 + 0.5) / 8;

/** Build marker for live bundle verification. */
export const PART_RENDERER_REV = "wedge-rev-2";

// ── Wedge geometry ───────────────────────────────────────────────────────────

/**
 * Wedge shape in the unit cube: full bottom and back (+Z) faces,
 * slope from the top back edge down to the bottom front edge, triangular
 * sides. Flat per-face normals; faces wound CCW viewed from outside (the
 * engine's front-face convention — verified visually).
 */
function createWedgeMesh(engine: EngineContext): Mesh {
    const c = Math.SQRT1_2;
    // prettier-ignore
    const faces: { v: [number, number, number][]; n: [number, number, number] }[] = [
        { v: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5]], n: [0, -1, 0] },   // bottom
        { v: [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]], n: [0, 0, 1] },        // back
        { v: [[-0.5, 0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, 0.5]], n: [0, c, -c] },     // slope
        { v: [[-0.5, -0.5, -0.5], [-0.5, 0.5, 0.5], [-0.5, -0.5, 0.5]], n: [-1, 0, 0] },                      // left tri
        { v: [[0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5]], n: [1, 0, 0] },                          // right tri
    ];
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (const f of faces) {
        const base = positions.length / 3;
        for (const v of f.v) {
            positions.push(...v);
            normals.push(...f.n);
            uvs.push(0, 0);
        }
        if (f.v.length === 4) {
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        } else {
            indices.push(base, base + 1, base + 2);
        }
    }
    return createMeshFromData(engine, "wedge", new Float32Array(positions), new Float32Array(normals), new Uint32Array(indices), new Float32Array(uvs));
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the shared Part renderer. Async because the stud textures are
 * generated and mip-mapped via the image pipeline.
 *
 * Caller wiring: `addToScene` both meshes, register `mesh` (only) as a shadow
 * caster, and call `enableMaterialPlugins(scene)` before `registerScene*`.
 */
export async function createPartRenderer(engine: EngineContext, _scene: SceneContext): Promise<PartRenderer> {
    const studs = await createStudTextures(engine);

    const mat = createStandardMaterial();
    mat.diffuseColor = [1, 1, 1]; // hue comes from per-instance colors
    mat.specularPower = 16;
    mat.specularColor = [0.08, 0.08, 0.08];
    mat.plugins = [createStudMaterialPlugin(studs)];

    const makePool = (geometry?: Mesh): InstancePool => {
        const mesh = geometry ?? createBox(engine);
        mesh.material = mat;
        mesh.receiveShadows = true;
        // Pre-size the instance buffer, then OPT INTO GPU CULLING. Crucial side
        // effect (see task-board findings): culling marks the renderable
        // `_direct`, which takes it out of the cached opaque render bundle —
        // the ONLY public-API route that gives per-frame thin-instance buffer
        // sync on standard materials. Without it, runtime moves/resizes/clones
        // update CPU state but never render (bundles bake the record-time data).
        setThinInstances(mesh, new Float32Array(16 * 16), 16);
        setThinInstanceCount(mesh, 0);
        enableThinInstanceGpuCulling(mesh);
        return {
            mesh,
            colors: new Float32Array(16 * 4),
            slotToHandle: [],
            handleToSlot: new Map(),
            handleAabbs: new Map(),
        };
    };

    const caster = makePool();
    const receiver = makePool();
    const wedge = makePool(createWedgeMesh(engine));

    return {
        mesh: caster.mesh,
        receiverMesh: receiver.mesh,
        wedgeMesh: wedge.mesh,
        _state: {
            pools: { caster, receiver, wedge },
            handlePool: new Map(),
            nextHandle: 1,
        },
    };
}

// ── Instance lifecycle ───────────────────────────────────────────────────────

/** Allocate an instance (identity transform, white). Returns a stable handle. */
export function allocInstance(r: PartRenderer, opts?: AllocOptions): InstanceHandle {
    const s = r._state;
    const poolId: PoolId = opts?.shape === "wedge" ? "wedge" : opts?.receiverOnly ? "receiver" : "caster";
    const pool = s.pools[poolId];
    const slot = addThinInstance(pool.mesh, mat4Identity());

    // Grow the colors mirror alongside the engine's capacity doubling.
    if ((slot + 1) * 4 > pool.colors.length) {
        const grown = new Float32Array(pool.colors.length * 2);
        grown.set(pool.colors);
        pool.colors = grown;
    }
    pool.colors.fill(1, slot * 4, slot * 4 + 4);
    pool.colors[slot * 4 + 3] = poolId === "wedge" ? NO_STUDS_ALPHA : encodeTopFace(0, 1, 0);

    const handle = s.nextHandle++;
    pool.slotToHandle[slot] = handle;
    pool.handleToSlot.set(handle, slot);
    s.handlePool.set(handle, poolId);
    setThinInstanceColors(pool.mesh, pool.colors);
    return handle;
}

/**
 * Encode the world-axis face index of the part's local top into instance
 * alpha (see stud-material-plugin.ts): 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z as
 * (index + 0.5) / 8. Rotations are 90°-stepped, so the local +Y always lands
 * on a world axis (dominant-component pick keeps it robust to float dust).
 */
function encodeTopFace(upX: number, upY: number, upZ: number): number {
    const ax = Math.abs(upX);
    const ay = Math.abs(upY);
    const az = Math.abs(upZ);
    let index: number;
    if (ax >= ay && ax >= az) {
        index = upX >= 0 ? 0 : 1;
    } else if (ay >= az) {
        index = upY >= 0 ? 2 : 3;
    } else {
        index = upZ >= 0 ? 4 : 5;
    }
    return (index + 0.5) / 8;
}

function poolOf(r: PartRenderer, handle: InstanceHandle): InstancePool | null {
    const poolId = r._state.handlePool.get(handle);
    return poolId ? r._state.pools[poolId] : null;
}

/** Free an instance. The engine swap-removes; mirror the swap for colors/maps. */
export function freeInstance(r: PartRenderer, handle: InstanceHandle): void {
    const s = r._state;
    const pool = poolOf(r, handle);
    if (!pool) {
        return;
    }
    const slot = pool.handleToSlot.get(handle)!;
    const lastSlot = pool.mesh.thinInstances!.count - 1;

    removeThinInstance(pool.mesh, slot); // engine moves matrix[lastSlot] → matrix[slot]

    if (slot !== lastSlot) {
        pool.colors.copyWithin(slot * 4, lastSlot * 4, lastSlot * 4 + 4);
        const movedHandle = pool.slotToHandle[lastSlot]!;
        pool.slotToHandle[slot] = movedHandle;
        pool.handleToSlot.set(movedHandle, slot);
    }
    pool.slotToHandle.length = lastSlot;
    pool.handleToSlot.delete(handle);
    pool.handleAabbs.delete(handle);
    s.handlePool.delete(handle);
    setThinInstanceColors(pool.mesh, pool.colors);
    refreshBounds(pool);
}

/** Write an instance's TRS (position, 90°-step rotation quat, size in studs). */
export function writeInstance(
    r: PartRenderer,
    handle: InstanceHandle,
    pos: { readonly x: number; readonly y: number; readonly z: number },
    quat: { readonly x: number; readonly y: number; readonly z: number; readonly w: number },
    size: readonly [number, number, number]
): void {
    const pool = poolOf(r, handle);
    if (!pool) {
        return;
    }
    const slot = pool.handleToSlot.get(handle)!;
    const m = mat4Compose(pos.x, pos.y, pos.z, quat.x, quat.y, quat.z, quat.w, size[0], size[1], size[2]);
    setThinInstanceMatrix(pool.mesh, slot, m);

    // Local +Y in world space = rotation matrix basis column 1 (unscaled).
    // Wedges keep their fixed no-studs alpha.
    if (r._state.handlePool.get(handle) !== "wedge") {
        const upX = 2 * (quat.x * quat.y - quat.w * quat.z);
        const upY = 1 - 2 * (quat.x * quat.x + quat.z * quat.z);
        const upZ = 2 * (quat.y * quat.z + quat.w * quat.x);
        const encoded = encodeTopFace(upX, upY, upZ);
        if (pool.colors[slot * 4 + 3] !== encoded) {
            pool.colors[slot * 4 + 3] = encoded;
            setThinInstanceColors(pool.mesh, pool.colors);
        }
    }

    // World AABB of this instance (rotated unit box): half-extent per world
    // axis = Σ |basis row component| / 2, read off the composed matrix.
    const hx = (Math.abs(m[0]!) + Math.abs(m[4]!) + Math.abs(m[8]!)) / 2;
    const hy = (Math.abs(m[1]!) + Math.abs(m[5]!) + Math.abs(m[9]!)) / 2;
    const hz = (Math.abs(m[2]!) + Math.abs(m[6]!) + Math.abs(m[10]!)) / 2;
    pool.handleAabbs.set(handle, [pos.x - hx, pos.y - hy, pos.z - hz, pos.x + hx, pos.y + hy, pos.z + hz]);
    refreshBounds(pool);
}

/** Write an instance's color. Alpha is preserved (it encodes the stud face). */
export function writeColor(r: PartRenderer, handle: InstanceHandle, rgb: readonly [number, number, number]): void {
    const pool = poolOf(r, handle);
    if (!pool) {
        return;
    }
    const slot = pool.handleToSlot.get(handle)!;
    pool.colors[slot * 4] = rgb[0];
    pool.colors[slot * 4 + 1] = rgb[1];
    pool.colors[slot * 4 + 2] = rgb[2];
    setThinInstanceColors(pool.mesh, pool.colors);
}

/** Recompute mesh.boundMin/boundMax over all of a pool's instances. */
function refreshBounds(pool: InstancePool): void {
    if (pool.handleAabbs.size === 0) {
        pool.mesh.boundMin = [-0.5, -0.5, -0.5];
        pool.mesh.boundMax = [0.5, 0.5, 0.5];
        return;
    }
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity,
        maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (const b of pool.handleAabbs.values()) {
        minX = Math.min(minX, b[0]);
        minY = Math.min(minY, b[1]);
        minZ = Math.min(minZ, b[2]);
        maxX = Math.max(maxX, b[3]);
        maxY = Math.max(maxY, b[4]);
        maxZ = Math.max(maxZ, b[5]);
    }
    pool.mesh.boundMin = [minX, minY, minZ];
    pool.mesh.boundMax = [maxX, maxY, maxZ];
}
