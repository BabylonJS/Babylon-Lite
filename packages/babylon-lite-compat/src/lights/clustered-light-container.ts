/**
 * Babylon.js-compatible `ClusteredLightContainer` implemented over Babylon Lite's
 * clustered (forward+) lighting API (`createClusteredLightContainer` /
 * `createClusteredPointLight` / `addClusteredLightContainer`).
 *
 * A clustered container groups many point lights that PBR materials shade through
 * a screen-space cluster grid on the GPU. Babylon.js exposes it as a `Light`
 * subclass whose child point/spot lights are excluded from the ordinary
 * per-mesh light path; this wrapper mirrors that shape and forwards the feature
 * work to Lite — the clustering math lives entirely in Lite.
 *
 * Scope (⚡ partial): Babylon Lite clusters **point lights only**, so
 * {@link ClusteredLightContainer.IsLightSupported} accepts a compat `PointLight`
 * and rejects everything else (Babylon.js additionally clusters spot lights).
 * Each added light is snapshotted into a Lite `ClusteredPointLight` at add time;
 * later in-place mutation of the source light does not propagate. `maxRange` is a
 * clustering optimisation Babylon Lite manages internally, so the property is
 * stored for shape parity but does not re-bin lights.
 */

import { addToScene, createClusteredLightContainer, createClusteredPointLight, addClusteredLightContainer, markClusteredLightContainerDirty, removeFromScene } from "babylon-lite";
import type { ClusteredLightContainer as LiteClusteredLightContainer, ClusteredPointLight as LiteClusteredPointLight, LightBase } from "babylon-lite";

import { Light, PointLight } from "./lights.js";
import type { Scene } from "../scene/scene.js";

/** The numeric light type id Babylon.js reports for a clustered container (`LIGHTTYPEID_CLUSTERED_CONTAINER`). */
const LIGHTTYPEID_CLUSTERED_CONTAINER = 5;

/**
 * Babylon.js `ClusteredLightContainer` — a `Light` that renders a large set of
 * point lights through a clustered / forward+ system.
 */
export class ClusteredLightContainer extends Light {
    /**
     * @internal The underlying Babylon Lite clustered light container. The base
     * `Light._lite` is typed as `LightBase`, but a clustered container is a distinct
     * Lite object (not a punctual light); every base member that dereferences `_lite`
     * as a light is overridden below, so the value is only ever read back through
     * {@link _container}.
     */
    public readonly _lite: LightBase;

    /** @internal Typed handle to the Lite clustered container held in {@link _lite}. */
    private get _container(): LiteClusteredLightContainer {
        return this._lite as unknown as LiteClusteredLightContainer;
    }

    /** @internal Point lights added to this container (Babylon.js `container.lights`). */
    private readonly _childLights: PointLight[] = [];
    /** @internal Lite clustered point lights, parallel to {@link _childLights}. */
    private readonly _liteLights: LiteClusteredPointLight[] = [];
    /** @internal Whether the container has been registered on the Lite scene (engine start). */
    private _built = false;
    private _maxRange = 16383;
    private _selfIntensity = 1;

    /**
     * True if a point/spot light can be clustered by this container. Babylon Lite
     * clusters point lights only.
     */
    public static IsLightSupported(light: Light): boolean {
        return light instanceof PointLight;
    }

    /**
     * Creates a new clustered light container.
     *
     * @param name - The container's node name.
     * @param lights - Initial lights to cluster (point lights).
     * @param scene - Owning scene; when supplied the container is registered and
     * built into the Lite scene at engine start.
     */
    public constructor(name: string, lights: Light[] = [], scene?: Scene) {
        super(name, scene);
        this._lite = createClusteredLightContainer() as unknown as LightBase;
        if (scene) {
            scene._registerClusteredLightContainer(this);
        }
        for (const light of lights) {
            this.addLight(light);
        }
    }

    public override getClassName(): string {
        return "ClusteredLightContainer";
    }

    /** Babylon.js `light.getTypeID()` — `LIGHTTYPEID_CLUSTERED_CONTAINER`. */
    public getTypeID(): number {
        return LIGHTTYPEID_CLUSTERED_CONTAINER;
    }

    /** True when clustered lighting is available (Babylon Lite backs it on WebGPU). */
    public get isSupported(): boolean {
        return true;
    }

    /** The lights added to this clustering system. */
    public get lights(): readonly Light[] {
        return this._childLights;
    }

    /** Number of cluster tiles across the screen horizontally (default `64`). */
    public get horizontalTiles(): number {
        return this._container.horizontalTiles;
    }
    public set horizontalTiles(value: number) {
        this._container.horizontalTiles = value;
        this._markDirty();
    }

    /** Number of cluster tiles across the screen vertically (default `64`). */
    public get verticalTiles(): number {
        return this._container.verticalTiles;
    }
    public set verticalTiles(value: number) {
        this._container.verticalTiles = value;
        this._markDirty();
    }

    /** Number of depth slices used to bin lights along view-space Z (default `16`). */
    public get depthSlices(): number {
        return this._container.zSlices;
    }
    public set depthSlices(value: number) {
        this._container.zSlices = value;
        this._markDirty();
    }

    /**
     * Upper bound applied to clustered light ranges. Babylon Lite manages range
     * binning internally, so this is stored for API-shape parity and does not
     * re-cluster the lights.
     */
    public get maxRange(): number {
        return this._maxRange;
    }
    public set maxRange(value: number) {
        this._maxRange = value;
    }

    /** Babylon.js `container.addLight(light)`. Only point lights are clustered. */
    public addLight(light: Light): void {
        if (!ClusteredLightContainer.IsLightSupported(light) || light._clusteredContainer) {
            return;
        }
        const point = light as PointLight;
        light._clusteredContainer = this;
        const pos = point.position;
        const diffuse = point.diffuse;
        const liteLight = createClusteredPointLight(this._container, {
            position: [pos.x, pos.y, pos.z],
            diffuse: [diffuse.r, diffuse.g, diffuse.b],
            range: point.range,
            intensity: point.intensity,
        });
        this._childLights.push(point);
        this._liteLights.push(liteLight);
        // Exclude the light from the ordinary per-mesh light path (Babylon.js
        // removes it from scene.lights when it joins a cluster).
        const scene = this._scene;
        if (scene) {
            scene._unregisterNode(point);
            removeFromScene(scene._lite, point._lite);
        }
        this._markDirty();
    }

    /**
     * Babylon.js `container.removeLight(light)`. Returns the index the light held
     * in the container's light list, or `-1` if it was not present.
     */
    public removeLight(light: Light): number {
        const index = this._childLights.indexOf(light as PointLight);
        if (index === -1) {
            return -1;
        }
        this._childLights.splice(index, 1);
        const liteLight = this._liteLights.splice(index, 1)[0];
        const pool = this._container.pointLights;
        const j = liteLight ? pool.indexOf(liteLight) : -1;
        if (j !== -1) {
            pool.splice(j, 1);
        }
        light._clusteredContainer = null;
        // Return the light to the ordinary per-mesh light path.
        const scene = this._scene;
        if (scene) {
            scene._registerLight(light as PointLight);
            addToScene(scene._lite, (light as PointLight)._lite);
        }
        this._markDirty();
        return index;
    }

    /**
     * @internal Register the container on the Lite scene, wiring its clustered
     * lights into the scene's PBR materials. Deferred to engine start so meshes and
     * materials are settled; skipped on the device-less `NullEngine`.
     */
    public _build(): void {
        if (this._built) {
            return;
        }
        this._built = true;
        const scene = this._scene;
        if (!scene || scene.getEngine()._headless) {
            return;
        }
        addClusteredLightContainer(scene._lite, this._container);
    }

    /** @internal Force a GPU re-upload of the clustered light set on the next frame (post-build). */
    private _markDirty(): void {
        if (this._built) {
            markClusteredLightContainerDirty(this._container);
        }
    }

    // ─── Base `Light` members overridden: a clustered container is not a punctual
    //     Lite light, so intensity/shadow/enable/dispose must not touch `_lite`. ───

    /** Container-level intensity (Babylon.js inherits it from `Light`; each child light carries its own). */
    public override get intensity(): number {
        return this._selfIntensity;
    }
    public override set intensity(value: number) {
        this._selfIntensity = value;
    }

    /** Clustered lights do not cast shadows in Babylon.js; the toggle is a no-op. */
    public override set shadowEnabled(_enabled: boolean) {
        // no-op: clustered lighting has no shadow generator
    }

    protected override _onEffectiveEnabledStateChanged(_enabled: boolean): void {
        // no-op: the container has no single Lite intensity to zero
    }

    public override dispose(): void {
        // Babylon Lite owns the clustered GPU state via the scene and disposes it on
        // scene disposal; the base `Light.dispose` only detaches a shadow generator
        // (a harmless no-op here) before running Node cleanup.
        super.dispose();
    }
}
