/**
 * Recast Navigation V2 integration for Babylon Lite.
 *
 * Pure-state interfaces + standalone factory functions, matching Lite conventions.
 * The recast wasm is loaded lazily inside `createNavigationPluginAsync` so scenes
 * that do not use navigation pay zero bundle cost.
 *
 * Usage:
 *   const nav = await createNavigationPluginAsync();
 *   createNavMesh(nav, [ground, sphere, box], params);
 *   const debug = createDebugNavMeshGeometry(nav);
 *   const closest = getClosestPoint(nav, { x, y, z });
 *   const crowd = createNavCrowd(nav, 10, 0.1);
 *   const idx = addAgent(crowd, spawnPos, agentParams);
 *   updateNavCrowd(crowd, 1 / 60);
 */

import type { Vec3 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { MeshInternal } from "../mesh/mesh.js";

// ─── Public types ────────────────────────────────────────────────────

/** NavMesh build parameters (Recast solo navmesh config). */
export interface NavMeshParameters {
    cs?: number;
    ch?: number;
    walkableSlopeAngle?: number;
    walkableHeight?: number;
    walkableClimb?: number;
    walkableRadius?: number;
    maxEdgeLen?: number;
    maxSimplificationError?: number;
    minRegionArea?: number;
    mergeRegionArea?: number;
    maxVertsPerPoly?: number;
    detailSampleDist?: number;
    detailSampleMaxError?: number;
    /** Skip reversing winding when extracting positions (right-handed input). */
    doNotReverseIndices?: boolean;
}

/** Crowd agent parameters. */
export interface AgentParameters {
    radius: number;
    height: number;
    maxAcceleration: number;
    maxSpeed: number;
    collisionQueryRange: number;
    pathOptimizationRange: number;
    separationWeight: number;
    updateFlags?: number;
    obstacleAvoidanceType?: number;
    queryFilterType?: number;
    reachRadius?: number;
}

/** A single mesh source for navmesh construction. */
export interface NavMeshSource {
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
}

/** Pure-state handle for the navigation plugin. */
export interface NavigationPlugin {
    /** @internal */ readonly _recast: any;
    /** @internal */ readonly _generators: any;
    /** @internal */ _navMesh?: any;
    /** @internal */ _navMeshQuery?: any;
}

/** Pure-state handle for a crowd. */
export interface NavCrowd {
    /** @internal */ readonly _plugin: NavigationPlugin;
    /** @internal */ readonly _crowd: any;
}

// ─── Factory ─────────────────────────────────────────────────────────

let _coreModule: any = null;
let _generatorsModule: any = null;
let _initPromise: Promise<void> | null = null;

async function _ensureRecast(locateFile?: (url: string) => string): Promise<{ core: any; gens: any }> {
    if (!_coreModule || !_generatorsModule) {
        if (!_initPromise) {
            _initPromise = (async () => {
                const core = await import("@recast-navigation/core");
                const gens = await import("@recast-navigation/generators");
                if (locateFile) {
                    const wasmFactory = (await import("@recast-navigation/wasm/wasm")).default;
                    // core.init types impl as typeof Recast but calls it as impl() at runtime;
                    // bind pre-fills locateFile and cast to satisfy the declaration.
                    await core.init(wasmFactory.bind(null, { locateFile }) as typeof wasmFactory);
                } else {
                    await core.init();
                }
                _coreModule = core;
                _generatorsModule = gens;
            })();
        }
        await _initPromise;
    }
    return { core: _coreModule, gens: _generatorsModule };
}

/**
 * Create a navigation plugin. Loads the Recast wasm internally on first call;
 * subsequent calls reuse the loaded module.
 *
 * Pass `locateFile` to serve the wasm from a public path instead of bundling
 * it inline — same pattern as `HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" })`.
 *
 * @example
 *   const nav = await createNavigationPluginAsync({ locateFile: () => "/recast-navigation.wasm" });
 */
export async function createNavigationPluginAsync(options?: { locateFile?: (url: string) => string }): Promise<NavigationPlugin> {
    const { core, gens } = await _ensureRecast(options?.locateFile);
    return {
        _recast: core,
        _generators: gens,
    };
}

// ─── NavMesh ─────────────────────────────────────────────────────────

/**
 * Build a solo navmesh from one or more meshes. Each mesh's CPU positions are
 * transformed by its worldMatrix (matching BJS GetPositionsAndIndices), merged
 * into a single stream, and index winding is reversed (left-handed convention)
 * unless `doNotReverseIndices` is set.
 */
export function createNavMesh(plugin: NavigationPlugin, meshes: Mesh[], params: NavMeshParameters): void {
    const { positions, indices } = _mergeMeshes(meshes, params.doNotReverseIndices === true);

    const cfg: Record<string, number | boolean> = {};
    if (params.cs !== undefined) {
        cfg.cs = params.cs;
    }
    if (params.ch !== undefined) {
        cfg.ch = params.ch;
    }
    if (params.walkableSlopeAngle !== undefined) {
        cfg.walkableSlopeAngle = params.walkableSlopeAngle;
    }
    if (params.walkableHeight !== undefined) {
        cfg.walkableHeight = params.walkableHeight;
    }
    if (params.walkableClimb !== undefined) {
        cfg.walkableClimb = params.walkableClimb;
    }
    if (params.walkableRadius !== undefined) {
        cfg.walkableRadius = params.walkableRadius;
    }
    if (params.maxEdgeLen !== undefined) {
        cfg.maxEdgeLen = params.maxEdgeLen;
    }
    if (params.maxSimplificationError !== undefined) {
        cfg.maxSimplificationError = params.maxSimplificationError;
    }
    if (params.minRegionArea !== undefined) {
        cfg.minRegionArea = params.minRegionArea;
    }
    if (params.mergeRegionArea !== undefined) {
        cfg.mergeRegionArea = params.mergeRegionArea;
    }
    if (params.maxVertsPerPoly !== undefined) {
        cfg.maxVertsPerPoly = params.maxVertsPerPoly;
    }
    if (params.detailSampleDist !== undefined) {
        cfg.detailSampleDist = params.detailSampleDist;
    }
    if (params.detailSampleMaxError !== undefined) {
        cfg.detailSampleMaxError = params.detailSampleMaxError;
    }

    const result = plugin._generators.generateSoloNavMesh(positions, indices, cfg, false);
    if (!result.success) {
        throw new Error(`createNavMesh failed: ${result.error}`);
    }

    const internal = plugin as { _navMesh: any; _navMeshQuery: any };
    internal._navMesh = result.navMesh;
    internal._navMeshQuery = new plugin._recast.NavMeshQuery(result.navMesh);
}

function _mergeMeshes(meshes: Mesh[], doNotReverseIndices: boolean): { positions: Float32Array; indices: Uint32Array } {
    let totalVerts = 0;
    let totalIdx = 0;
    for (const mesh of meshes) {
        const mi = mesh as unknown as MeshInternal;
        if (!mi._cpuPositions || !mi._cpuIndices) {
            throw new Error(`Mesh "${mesh.name}" missing CPU geometry for navmesh`);
        }
        totalVerts += mi._cpuPositions.length;
        totalIdx += mi._cpuIndices.length;
    }
    const positions = new Float32Array(totalVerts);
    const indices = new Uint32Array(totalIdx);

    let pOff = 0;
    let iOff = 0;
    let vertBase = 0;
    for (const mesh of meshes) {
        const mi = mesh as unknown as MeshInternal;
        const src = mi._cpuPositions!;
        const wm = mesh.worldMatrix;

        for (let i = 0; i < src.length; i += 3) {
            const x = src[i]!,
                y = src[i + 1]!,
                z = src[i + 2]!;
            positions[pOff++] = x * wm[0]! + y * wm[4]! + z * wm[8]! + wm[12]!;
            positions[pOff++] = x * wm[1]! + y * wm[5]! + z * wm[9]! + wm[13]!;
            positions[pOff++] = x * wm[2]! + y * wm[6]! + z * wm[10]! + wm[14]!;
        }

        const meshIdx = mi._cpuIndices!;
        const n = meshIdx.length;
        if (doNotReverseIndices) {
            for (let i = 0; i < n; i++) {
                indices[iOff++] = meshIdx[i]! + vertBase;
            }
        } else {
            for (let i = 0; i < n; i += 3) {
                indices[iOff++] = meshIdx[i]! + vertBase;
                indices[iOff++] = meshIdx[i + 2]! + vertBase;
                indices[iOff++] = meshIdx[i + 1]! + vertBase;
            }
        }
        vertBase += src.length / 3;
    }

    return { positions, indices };
}

// ─── Debug navmesh geometry ──────────────────────────────────────────

/**
 * Extract debug visualization geometry from the generated navmesh.
 * Returns positions, indices, and a hash of the positions for cross-engine parity checks.
 */
export function createDebugNavMeshGeometry(plugin: NavigationPlugin): { positions: Float32Array; indices: Uint32Array; positionsHash: number } {
    if (!plugin._navMesh) {
        throw new Error("No navmesh generated. Call createNavMesh first.");
    }
    const [positionsArr, indicesArr] = plugin._recast.getNavMeshPositionsAndIndices(plugin._navMesh);
    const positions = new Float32Array(positionsArr);
    const indices = new Uint32Array(indicesArr);

    let hash = 0x811c9dc5;
    for (let i = 0; i < positions.length; i++) {
        hash ^= Math.round(positions[i]! * 100000);
        hash = Math.imul(hash, 0x01000193);
    }

    return { positions, indices, positionsHash: hash };
}

// ─── Queries ─────────────────────────────────────────────────────────

const _tmpHalfExtents = { x: 1, y: 1, z: 1 };

/** Snap a position to the closest point on the navmesh. */
export function getClosestPoint(plugin: NavigationPlugin, position: Vec3): Vec3 {
    _assertReady(plugin);
    const res = plugin._navMeshQuery.findClosestPoint(position, { halfExtents: _tmpHalfExtents });
    return { x: res.point.x, y: res.point.y, z: res.point.z };
}

/** Compute a path between two world positions, snapped to the navmesh. */
export function computePath(plugin: NavigationPlugin, start: Vec3, end: Vec3): Vec3[] {
    _assertReady(plugin);
    const q = plugin._navMeshQuery;
    const startSnap = q.findClosestPoint(start, { halfExtents: _tmpHalfExtents });
    const endSnap = q.findClosestPoint(end, { halfExtents: _tmpHalfExtents });
    const res = q.computePath(startSnap.point, endSnap.point);
    if (!res.success) {
        return [];
    }
    const out: Vec3[] = [];
    for (const p of res.path) {
        out.push({ x: p.x, y: p.y, z: p.z });
    }
    return out;
}

function _assertReady(plugin: NavigationPlugin): void {
    if (!plugin._navMesh || !plugin._navMeshQuery) {
        throw new Error("Navmesh not ready. Call createNavMesh first.");
    }
}

// ─── Crowd ───────────────────────────────────────────────────────────

/**
 * Create a crowd attached to the navmesh. The crowd is NOT auto-updated;
 * call `updateNavCrowd(crowd, dt)` each frame for full determinism.
 */
export function createNavCrowd(plugin: NavigationPlugin, maxAgents: number, maxAgentRadius: number): NavCrowd {
    _assertReady(plugin);
    const Crowd = plugin._recast.Crowd;
    const crowd = new Crowd(plugin._navMesh, { maxAgents, maxAgentRadius });
    return { _plugin: plugin, _crowd: crowd };
}

/** Add an agent to the crowd. Returns the agent index. */
export function addAgent(crowd: NavCrowd, position: Vec3, params: AgentParameters): number {
    const agentParams = {
        radius: params.radius,
        height: params.height,
        maxAcceleration: params.maxAcceleration,
        maxSpeed: params.maxSpeed,
        collisionQueryRange: params.collisionQueryRange,
        pathOptimizationRange: params.pathOptimizationRange,
        separationWeight: params.separationWeight,
        updateFlags: params.updateFlags ?? 7,
        obstacleAvoidanceType: params.obstacleAvoidanceType ?? 0,
        queryFilterType: params.queryFilterType ?? 0,
        userData: 0,
    };
    const agent = crowd._crowd.addAgent({ x: position.x, y: position.y, z: position.z }, agentParams);
    return agent.agentIndex;
}

/** Get the current world position of an agent. */
export function getAgentPosition(crowd: NavCrowd, index: number): Vec3 {
    const p = crowd._crowd.getAgent(index)?.position();
    return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 };
}

/** Get the current world-space velocity of an agent. */
export function getAgentVelocity(crowd: NavCrowd, index: number): Vec3 {
    const v = crowd._crowd.getAgent(index)?.velocity();
    return v ? { x: v.x, y: v.y, z: v.z } : { x: 0, y: 0, z: 0 };
}

/** Request the agent to move toward a world target (constrained by navmesh). */
export function agentGoto(crowd: NavCrowd, index: number, destination: Vec3): void {
    crowd._crowd.getAgent(index)?.requestMoveTarget(destination);
}

/** Advance the crowd simulation by `dt` seconds. */
export function updateNavCrowd(crowd: NavCrowd, dt: number): void {
    crowd._crowd.update(dt);
}
