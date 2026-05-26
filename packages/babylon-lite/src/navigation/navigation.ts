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
 *
 * For obstacles (tile-cache navmesh):
 *   createNavMesh(nav, [...], { ..., maxObstacles: 32, tileSize: 32 });
 *   const ref = addBoxObstacle(nav, { x, y, z }, { x: 1, y: 1, z: 1 }, angle);
 *   removeObstacle(nav, ref);
 *
 * For off-mesh connections:
 *   createNavMesh(nav, [...], { ..., offMeshConnections: [...] });
 *
 * For raycast:
 *   const r = raycast(nav, start, end);
 *   if (r.hit) console.log(r.hitPoint);
 */

import type { Vec3 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { MeshInternal } from "../mesh/mesh.js";

// ─── Public types ────────────────────────────────────────────────────

/** NavMesh build parameters (Recast solo / tiled / tile-cache navmesh config). */
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
    /** Tile size for tiled / tile-cache navmesh. Recommended 32-64 for tile cache. */
    tileSize?: number;
    /**
     * Maximum number of obstacles. If > 0 the navmesh is built with a tile cache
     * so obstacles can be added/removed dynamically.
     */
    maxObstacles?: number;
    /** Expected layers per tile for tile-cache navmesh. Default 1. */
    expectedLayersPerTile?: number;
    /** Off-mesh connection segments (teleports) baked into the navmesh. */
    offMeshConnections?: OffMeshConnection[];
    /** Keep intermediates for debug visualization. */
    keepIntermediates?: boolean;
}

/** Off-mesh connection (teleport segment) baked into the navmesh. */
export interface OffMeshConnection {
    startPosition: Vec3;
    endPosition: Vec3;
    radius: number;
    bidirectional: boolean;
    /** @default 0 */
    area?: number;
    /** @default 1 */
    flags?: number;
    userId?: number;
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
    /** @internal */ _tileCache?: any;
}

/** Opaque handle returned by `addBoxObstacle` / `addCylinderObstacle`. */
export interface ObstacleHandle {
    /** @internal */ readonly _obstacle: any;
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
 * Build a navmesh from one or more meshes. Each mesh's CPU positions are
 * transformed by its worldMatrix (matching BJS GetPositionsAndIndices), merged
 * into a single stream, and index winding is reversed (left-handed convention)
 * unless `doNotReverseIndices` is set.
 *
 * - Solo navmesh by default.
 * - If `maxObstacles > 0`, builds a tile-cache navmesh so obstacles can be
 *   added/removed dynamically.
 * - Off-mesh connections can be supplied for either solo or tile-cache.
 */
export function createNavMesh(plugin: NavigationPlugin, meshes: Mesh[], params: NavMeshParameters): void {
    const { positions, indices } = _mergeMeshes(meshes, params.doNotReverseIndices === true);

    const cfg: Record<string, unknown> = {};
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
    if (params.offMeshConnections !== undefined && params.offMeshConnections.length > 0) {
        cfg.offMeshConnections = params.offMeshConnections;
    }

    const internal = plugin as { _navMesh: any; _navMeshQuery: any; _tileCache?: any };
    const needsTileCache = (params.maxObstacles ?? 0) > 0;
    const needsTiled = (params.tileSize ?? 0) > 0;

    if (needsTileCache) {
        // Tile cache config: requires tileSize, expectedLayersPerTile, maxObstacles,
        // and a tile cache mesh process. Mirrors BJS Addons CreateTileCacheNavMeshConfig.
        cfg.tileSize = params.tileSize ?? 32;
        cfg.expectedLayersPerTile = params.expectedLayersPerTile ?? 1;
        cfg.maxObstacles = params.maxObstacles!;

        if (params.offMeshConnections !== undefined && params.offMeshConnections.length > 0) {
            cfg.tileCacheMeshProcess = _createDefaultTileCacheMeshProcess(plugin._recast, params.offMeshConnections);
        }

        const result = plugin._generators.generateTileCache(positions, indices, cfg, params.keepIntermediates === true);
        if (!result.success) {
            throw new Error(`createNavMesh (tile cache) failed: ${result.error}`);
        }
        internal._navMesh = result.navMesh;
        internal._tileCache = result.tileCache;
        internal._navMeshQuery = new plugin._recast.NavMeshQuery(result.navMesh);
        return;
    }

    if (needsTiled) {
        cfg.tileSize = params.tileSize;
        const result = plugin._generators.generateTiledNavMesh(positions, indices, cfg, params.keepIntermediates === true);
        if (!result.success) {
            throw new Error(`createNavMesh (tiled) failed: ${result.error}`);
        }
        internal._navMesh = result.navMesh;
        internal._navMeshQuery = new plugin._recast.NavMeshQuery(result.navMesh);
        return;
    }

    const result = plugin._generators.generateSoloNavMesh(positions, indices, cfg, params.keepIntermediates === true);
    if (!result.success) {
        throw new Error(`createNavMesh failed: ${result.error}`);
    }
    internal._navMesh = result.navMesh;
    internal._navMeshQuery = new plugin._recast.NavMeshQuery(result.navMesh);
}

/**
 * Default tile-cache mesh process that copies area/flags from input polys and
 * appends off-mesh connections. Mirrors BJS Addons CreateDefaultTileCacheMeshProcess.
 */
function _createDefaultTileCacheMeshProcess(recast: any, offMeshConnections: OffMeshConnection[]): any {
    const area = 0;
    const flags = 1;
    return new recast.TileCacheMeshProcess((navMeshCreateParams: any, polyAreas: any, polyFlags: any) => {
        for (let i = 0; i < navMeshCreateParams.polyCount(); ++i) {
            polyAreas.set(i, area);
            polyFlags.set(i, flags);
        }
        if (offMeshConnections.length > 0) {
            navMeshCreateParams.setOffMeshConnections(offMeshConnections);
        }
    });
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
 * Faces are detached (each triangle gets its own 3 vertices) and per-vertex
 * normals are set to the face normal — yielding flat shading without the need
 * for a separate normal-computation pass in callers.
 * Returns positions, normals, indices, and a hash of the positions for
 * cross-engine parity checks.
 */
export function createDebugNavMeshGeometry(plugin: NavigationPlugin): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; positionsHash: number } {
    if (!plugin._navMesh) {
        throw new Error("No navmesh generated. Call createNavMesh first.");
    }
    const [positionsArr, indicesArr] = plugin._recast.getNavMeshPositionsAndIndices(plugin._navMesh);
    const triCount = (indicesArr.length / 3) | 0;
    const vertCount = triCount * 3;
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const indices = new Uint32Array(vertCount);

    for (let t = 0; t < triCount; t++) {
        // Recast outputs triangles with original winding such that the face
        // normal computed from (i0,i1,i2) order points UP. We reverse the
        // stored winding to match BJS CreateDebugNavMesh for back-face culling
        // parity (stored as i0,i2,i1) — but compute the face normal from the
        // ORIGINAL winding so it still points UP.
        const i0 = indicesArr[t * 3]! * 3;
        const i1Orig = indicesArr[t * 3 + 1]! * 3;
        const i2Orig = indicesArr[t * 3 + 2]! * 3;

        const ax = positionsArr[i0]!,
            ay = positionsArr[i0 + 1]!,
            az = positionsArr[i0 + 2]!;
        const b1x = positionsArr[i1Orig]!,
            b1y = positionsArr[i1Orig + 1]!,
            b1z = positionsArr[i1Orig + 2]!;
        const c1x = positionsArr[i2Orig]!,
            c1y = positionsArr[i2Orig + 1]!,
            c1z = positionsArr[i2Orig + 2]!;

        const e1x = b1x - ax,
            e1y = b1y - ay,
            e1z = b1z - az;
        const e2x = c1x - ax,
            e2y = c1y - ay,
            e2z = c1z - az;
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) {
            nx /= len;
            ny /= len;
            nz /= len;
        }

        // Store positions in reversed winding (i0, i2, i1) for back-face parity.
        const v = t * 9;
        positions[v] = ax;
        positions[v + 1] = ay;
        positions[v + 2] = az;
        positions[v + 3] = c1x;
        positions[v + 4] = c1y;
        positions[v + 5] = c1z;
        positions[v + 6] = b1x;
        positions[v + 7] = b1y;
        positions[v + 8] = b1z;

        normals[v] = nx;
        normals[v + 1] = ny;
        normals[v + 2] = nz;
        normals[v + 3] = nx;
        normals[v + 4] = ny;
        normals[v + 5] = nz;
        normals[v + 6] = nx;
        normals[v + 7] = ny;
        normals[v + 8] = nz;

        const idx = t * 3;
        indices[idx] = idx;
        indices[idx + 1] = idx + 1;
        indices[idx + 2] = idx + 2;
    }

    let hash = 0x811c9dc5;
    for (let i = 0; i < positions.length; i++) {
        hash ^= Math.round(positions[i]! * 100000);
        hash = Math.imul(hash, 0x01000193);
    }

    return { positions, normals, indices, positionsHash: hash };
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

// ─── Random queries ──────────────────────────────────────────────────

/**
 * Return a random point on the navmesh inside a circle of `radius` around `position`.
 * Determinism: seeded by Recast's internal RNG; call `setNavigationRandomSeed`
 * to make results reproducible across runs.
 */
export function findRandomPointAroundCircle(plugin: NavigationPlugin, position: Vec3, radius: number): Vec3 {
    _assertReady(plugin);
    const res = plugin._navMeshQuery.findRandomPointAroundCircle(position, radius, { halfExtents: _tmpHalfExtents });
    return { x: res.randomPoint.x, y: res.randomPoint.y, z: res.randomPoint.z };
}

/** Return any random point on the navmesh. */
export function findRandomPoint(plugin: NavigationPlugin): Vec3 {
    _assertReady(plugin);
    const res = plugin._navMeshQuery.findRandomPoint();
    return { x: res.randomPoint.x, y: res.randomPoint.y, z: res.randomPoint.z };
}

/** Set the seed used by Recast's randomized queries (e.g. `findRandomPointAroundCircle`). */
export function setNavigationRandomSeed(plugin: NavigationPlugin, seed: number): void {
    plugin._recast.setRandomSeed(seed);
}

/** Get the current seed used by Recast's randomized queries. */
export function getNavigationRandomSeed(plugin: NavigationPlugin): number {
    return plugin._recast.getRandomSeed();
}

// ─── Raycast ────────────────────────────────────────────────────────

/**
 * Cast a 'walkability' ray on the navmesh from `start` to `end`.
 * Matches BJS Addons semantics: `hit` is true only when `0 < t < 1` and
 * `hitPoint` is the linear interpolation between start and end at parameter t.
 *
 * Recast's raycast ignores the y component of the end position (2D check).
 */
export function raycast(plugin: NavigationPlugin, start: Vec3, end: Vec3): { hit: boolean; hitPoint?: Vec3 } {
    _assertReady(plugin);
    const q = plugin._navMeshQuery;
    const nearest = q.findNearestPoly(start, { halfExtents: _tmpHalfExtents });
    if (!nearest.success || nearest.nearestRef === 0) {
        return { hit: false };
    }
    const r = q.raycast(nearest.nearestRef, start, end);
    const t = r?.t ?? 0;
    if (!(t > 0 && t < 1)) {
        return { hit: false };
    }
    return {
        hit: true,
        hitPoint: {
            x: start.x + (end.x - start.x) * t,
            y: start.y + (end.y - start.y) * t,
            z: start.z + (end.z - start.z) * t,
        },
    };
}

// ─── Obstacles (tile-cache navmeshes only) ───────────────────────────

/**
 * Add a box obstacle to a tile-cache navmesh. The navmesh must have been
 * built with `maxObstacles > 0`. The tile cache is fully updated before
 * returning (matching BJS Addons default behavior).
 *
 * @param halfExtents box half-size on each axis
 * @param angle rotation around the Y axis, in radians
 */
export function addBoxObstacle(plugin: NavigationPlugin, position: Vec3, halfExtents: Vec3, angle: number): ObstacleHandle | null {
    _assertTileCache(plugin);
    const r = plugin._tileCache.addBoxObstacle(position, halfExtents, angle);
    if (!r.success) {
        return null;
    }
    _waitForFullTileCacheUpdate(plugin);
    return { _obstacle: r.obstacle };
}

/**
 * Add a cylinder obstacle to a tile-cache navmesh.
 *
 * @param radius cylinder radius
 * @param height cylinder height
 */
export function addCylinderObstacle(plugin: NavigationPlugin, position: Vec3, radius: number, height: number): ObstacleHandle | null {
    _assertTileCache(plugin);
    const r = plugin._tileCache.addCylinderObstacle(position, radius, height);
    if (!r.success) {
        return null;
    }
    _waitForFullTileCacheUpdate(plugin);
    return { _obstacle: r.obstacle };
}

/** Remove an obstacle previously added by `addBoxObstacle` / `addCylinderObstacle`. */
export function removeObstacle(plugin: NavigationPlugin, obstacle: ObstacleHandle): void {
    _assertTileCache(plugin);
    plugin._tileCache.removeObstacle(obstacle._obstacle);
    _waitForFullTileCacheUpdate(plugin);
}

/** Run `tileCache.update()` until all pending obstacle requests are resolved. */
export function updateNavMeshObstacles(plugin: NavigationPlugin): void {
    _assertTileCache(plugin);
    _waitForFullTileCacheUpdate(plugin);
}

function _waitForFullTileCacheUpdate(plugin: NavigationPlugin): void {
    let upToDate = false;
    while (!upToDate) {
        const r = plugin._tileCache.update(plugin._navMesh);
        upToDate = r.upToDate;
    }
}

function _assertTileCache(plugin: NavigationPlugin): void {
    _assertReady(plugin);
    if (!plugin._tileCache) {
        throw new Error("Navmesh has no tile cache. Build with `maxObstacles > 0` to enable obstacles.");
    }
}
