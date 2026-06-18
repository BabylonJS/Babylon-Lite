/**
 * Babylon.js `@babylonjs/addons/navigation` compatibility wrapper over Babylon
 * Lite's native navigation API (`createNavigationPluginAsync` / `createNavMesh` /
 * `createDebugNavMeshGeometry` / `createNavCrowd` / …).
 *
 * The Babylon.js navigation addon (`RecastNavigationJSPluginV2`, created via
 * `CreateNavigationPluginAsync`) is a thin wrapper around `recast-navigation-js`.
 * Babylon Lite ships its own Recast V2 integration with the same capabilities, so
 * this module mirrors the addon's public plugin/crowd surface and delegates to
 * Lite. The Recast instance the scene injects via `{ instance }` is ignored —
 * Lite loads its own Recast wasm (served at `/recast-navigation.wasm`).
 *
 * Only the surface exercised by ported scenes is implemented (`createNavMesh`,
 * `createDebugNavMesh`, `getClosestPoint`, `createCrowd` + `addAgent`); the rest
 * of the addon API is intentionally omitted.
 */

import {
    createNavigationPluginAsync as liteCreateNavigationPluginAsync,
    createNavMesh as liteCreateNavMesh,
    createDebugNavMeshGeometry as liteCreateDebugNavMeshGeometry,
    getClosestPoint as liteGetClosestPoint,
    computePath as liteComputePath,
    raycast as liteRaycast,
    createNavCrowd as liteCreateNavCrowd,
    addAgent as liteAddAgent,
    getAgentPosition as liteGetAgentPosition,
    agentGoto as liteAgentGoto,
    updateNavCrowd as liteUpdateNavCrowd,
    addBoxObstacle as liteAddBoxObstacle,
    addCylinderObstacle as liteAddCylinderObstacle,
    removeObstacle as liteRemoveObstacle,
    updateNavMeshObstacles as liteUpdateNavMeshObstacles,
    createMeshFromData,
    addToScene,
    type NavigationPlugin as LiteNavigationPlugin,
    type NavCrowd as LiteNavCrowd,
    type Mesh as LiteMesh,
    type ObstacleHandle as LiteObstacleHandle,
} from "babylon-lite";

import { Mesh } from "../meshes/meshes.js";
import { Vector3 } from "../math/vector.js";
import type { Scene } from "../scene/scene.js";

interface Vec3Like {
    x: number;
    y: number;
    z: number;
}

interface AgentTransform {
    position: { set(x: number, y: number, z: number): unknown };
}

/**
 * Result of {@link RecastNavigationJSPluginV2.createNavMesh}. Babylon.js's
 * tile-cache navmesh build returns `{ navMesh, tileCache }`; here both reference
 * the plugin so {@link WaitForFullTileCacheUpdate} can reach it.
 */
interface NavMeshResult {
    navMesh: RecastNavigationJSPluginV2;
    tileCache: RecastNavigationJSPluginV2;
}

/** Babylon.js `IAgentParameters` subset accepted by `RecastJSCrowd.addAgent`. */
interface AgentParameters {
    radius: number;
    height: number;
    maxAcceleration: number;
    maxSpeed: number;
    collisionQueryRange: number;
    pathOptimizationRange: number;
    separationWeight: number;
    reachRadius?: number;
}

/**
 * Babylon.js `RecastJSCrowd` (subset) — owns crowd agents and syncs each agent's
 * Babylon transform to the simulated position every frame, exactly like the addon.
 */
class RecastJSCrowd {
    /** @internal */ public readonly _lite: LiteNavCrowd;
    private readonly _transforms = new Map<number, AgentTransform>();
    private readonly _plugin: RecastNavigationJSPluginV2;

    public constructor(lite: LiteNavCrowd, plugin: RecastNavigationJSPluginV2, scene: Scene) {
        this._lite = lite;
        this._plugin = plugin;
        // Babylon.js' crowd advances the simulation and writes back agent transforms
        // on the scene's before-render tick; mirror that over Lite's manual crowd update.
        // The plugin's `timeFactor` scales the step (0 freezes the crowd — used by parity
        // tests via `?freeze=1`).
        scene.onBeforeRenderObservable.add(() => {
            liteUpdateNavCrowd(this._lite, (1 / 60) * this._plugin.timeFactor);
            for (const [index, transform] of this._transforms) {
                const p = liteGetAgentPosition(this._lite, index);
                transform.position.set(p.x, p.y, p.z);
            }
        });
    }

    /** Babylon.js `crowd.addAgent(pos, parameters, transform)` — returns the agent index. */
    public addAgent(pos: Vec3Like, parameters: AgentParameters, transform: AgentTransform): number {
        const index = liteAddAgent(this._lite, { x: pos.x, y: pos.y, z: pos.z }, parameters);
        this._transforms.set(index, transform);
        return index;
    }

    /** Babylon.js `crowd.getAgentPosition(index)`. */
    public getAgentPosition(index: number): Vector3 {
        const p = liteGetAgentPosition(this._lite, index);
        return new Vector3(p.x, p.y, p.z);
    }

    /** Babylon.js `crowd.agentGoto(index, destination)` — request the agent to move toward a target. */
    public agentGoto(index: number, destination: Vec3Like): void {
        liteAgentGoto(this._lite, index, { x: destination.x, y: destination.y, z: destination.z });
    }
}

/**
 * Babylon.js `RecastNavigationJSPluginV2` (subset) over Babylon Lite navigation.
 */
class RecastNavigationJSPluginV2 {
    /** @internal */ public readonly _lite: LiteNavigationPlugin;
    /**
     * Babylon.js `plugin.timeFactor` — multiplier applied to each crowd update step.
     * `0` pauses crowd movement (used by parity tests); default `1`.
     */
    public timeFactor = 1;

    public constructor(lite: LiteNavigationPlugin) {
        this._lite = lite;
    }

    /**
     * Babylon.js `plugin.createNavMesh(meshes, parameters)`. Returns a
     * `{ navMesh, tileCache }` handle (both reference this plugin) so scenes using
     * the tile-cache obstacle API can pass them to {@link WaitForFullTileCacheUpdate}.
     * Scenes that ignore the return (the non-obstacle navmesh scenes) are unaffected.
     */
    public createNavMesh(meshes: Array<{ _lite: LiteMesh }>, parameters: Record<string, unknown>): NavMeshResult {
        liteCreateNavMesh(
            this._lite,
            meshes.map((m) => m._lite),
            parameters as never
        );
        return { navMesh: this, tileCache: this };
    }

    /** Babylon.js `plugin.addCylinderObstacle(position, radius, height)` — tile-cache obstacle. */
    public addCylinderObstacle(position: Vec3Like, radius: number, height: number): LiteObstacleHandle | null {
        return liteAddCylinderObstacle(this._lite, { x: position.x, y: position.y, z: position.z }, radius, height);
    }

    /** Babylon.js `plugin.addBoxObstacle(position, extent, angle)` — tile-cache obstacle (`extent` = half-extents). */
    public addBoxObstacle(position: Vec3Like, extent: Vec3Like, angle: number): LiteObstacleHandle | null {
        return liteAddBoxObstacle(this._lite, { x: position.x, y: position.y, z: position.z }, { x: extent.x, y: extent.y, z: extent.z }, angle);
    }

    /** Babylon.js `plugin.removeObstacle(obstacle)` — remove a previously-added tile-cache obstacle. */
    public removeObstacle(obstacle: LiteObstacleHandle): void {
        liteRemoveObstacle(this._lite, obstacle);
    }

    /** @internal Apply pending tile-cache obstacle updates (drives {@link WaitForFullTileCacheUpdate}). */
    public _updateObstacles(): void {
        liteUpdateNavMeshObstacles(this._lite);
    }

    /** Babylon.js `plugin.createDebugNavMesh(scene)` — builds a renderable debug mesh. */
    public createDebugNavMesh(scene: Scene): Mesh {
        const geo = liteCreateDebugNavMeshGeometry(this._lite);
        const engine = scene.getEngine()._lite;
        const lite = createMeshFromData(engine, "navDebugMesh", geo.positions, geo.normals, geo.indices);
        const mesh = new Mesh("navDebugMesh", lite, scene);
        scene._deferAdd(() => {
            const mat = mesh.material;
            mat?._ensureRenderable(engine);
            if (mat?._lite) {
                mesh._lite.material = mat._lite as never;
            }
            addToScene(scene._lite, mesh._lite);
        });
        return mesh;
    }

    /** Babylon.js `plugin.getClosestPoint(position)` — snap to the navmesh. */
    public getClosestPoint(position: Vec3Like): Vector3 {
        const p = liteGetClosestPoint(this._lite, { x: position.x, y: position.y, z: position.z });
        return new Vector3(p.x, p.y, p.z);
    }

    /** Babylon.js `plugin.computePath(start, end)` — navmesh-snapped path as world points. */
    public computePath(start: Vec3Like, end: Vec3Like): Vector3[] {
        const points = liteComputePath(this._lite, { x: start.x, y: start.y, z: start.z }, { x: end.x, y: end.y, z: end.z });
        return points.map((p) => new Vector3(p.x, p.y, p.z));
    }

    /** Babylon.js `plugin.computePathSmooth(start, end)` — alias of {@link computePath} (Lite smooths internally). */
    public computePathSmooth(start: Vec3Like, end: Vec3Like): Vector3[] {
        return this.computePath(start, end);
    }

    /**
     * Babylon.js `plugin.raycast(start, end)` — walkability raycast on the navmesh.
     * Returns `{ hit, hitPoint? }` (`hitPoint` is a `Vector3` when `hit`).
     */
    public raycast(start: Vec3Like, end: Vec3Like): { hit: boolean; hitPoint?: Vector3 } {
        const r = liteRaycast(this._lite, { x: start.x, y: start.y, z: start.z }, { x: end.x, y: end.y, z: end.z });
        return r.hit && r.hitPoint ? { hit: true, hitPoint: new Vector3(r.hitPoint.x, r.hitPoint.y, r.hitPoint.z) } : { hit: false };
    }

    /** Babylon.js `plugin.createCrowd(maxAgents, maxAgentRadius, scene)`. */
    public createCrowd(maxAgents: number, maxAgentRadius: number, scene: Scene): RecastJSCrowd {
        const crowd = liteCreateNavCrowd(this._lite, maxAgents, maxAgentRadius);
        return new RecastJSCrowd(crowd, this, scene);
    }
}

/**
 * Babylon.js `@babylonjs/addons/navigation` `CreateNavigationPluginAsync`. The
 * injected Recast `instance` (if any) is ignored — Babylon Lite loads its own
 * Recast wasm from `/recast-navigation.wasm`.
 */
export async function CreateNavigationPluginAsync(_options?: { version?: string; instance?: unknown }): Promise<RecastNavigationJSPluginV2> {
    const lite = await liteCreateNavigationPluginAsync({ locateFile: () => "/recast-navigation.wasm" });
    return new RecastNavigationJSPluginV2(lite);
}

export { RecastNavigationJSPluginV2, RecastJSCrowd };

/**
 * Babylon.js `@babylonjs/addons/navigation/common/tile-cache`
 * `WaitForFullTileCacheUpdate(navMesh, tileCache)` — block until pending
 * tile-cache obstacle updates are applied. The addon takes the raw navMesh /
 * tileCache; here `navMesh` is the compat plugin (returned from `createNavMesh`),
 * so this delegates to Babylon Lite's `updateNavMeshObstacles`.
 */
export function WaitForFullTileCacheUpdate(navMesh: unknown, _tileCache?: unknown): void {
    const plugin = navMesh as RecastNavigationJSPluginV2 | undefined;
    if (plugin && typeof plugin._updateObstacles === "function") {
        plugin._updateObstacles();
    }
}
