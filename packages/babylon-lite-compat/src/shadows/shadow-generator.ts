/**
 * Babylon.js-compatible `ShadowGenerator` over the Babylon Lite shadow factories.
 *
 * Babylon.js constructs a `ShadowGenerator(mapSize, light)`, toggles technique
 * flags (`usePercentageCloserFiltering`, `useBlurExponentialShadowMap`, …), and
 * registers casters via `addShadowCaster(mesh)`. Babylon Lite instead has
 * dedicated factories (`createEsmDirectionalShadowGenerator`,
 * `createPcfDirectionalShadowGenerator`, `createPcfSpotlightShadowGenerator`) and
 * requires the scene to be registered with `registerSceneWithShadowSupport`.
 *
 * This wrapper records the BJS-style configuration up front and defers the actual
 * Lite generator creation to engine start (when the GPU device and all caster
 * meshes exist), then wires `light.shadowGenerator` + caster meshes. The owning
 * scene flips to shadow-aware registration when any generator is present.
 */

import {
    createCsmDirectionalShadowGenerator,
    createEsmDirectionalShadowGenerator,
    createPcfDirectionalShadowGenerator,
    createPcfSpotlightShadowGenerator,
    setShadowTaskCasterMeshes,
} from "babylon-lite";
import type { EngineContext, Mesh as LiteMesh } from "babylon-lite";

import { DirectionalLight, type Light } from "../lights/lights.js";
import type { AbstractMesh } from "../meshes/meshes.js";

type LiteShadowGenerator = ReturnType<typeof createEsmDirectionalShadowGenerator>;

export class ShadowGenerator {
    private readonly _mapSize: number;
    private readonly _light: Light;
    private readonly _casters: AbstractMesh[] = [];
    private _casterSyncScheduled = false;
    private _casterSyncDirty = false;
    /** @internal The built Lite shadow generator (set in `_build`). Used to wire NME receivers. */
    public _liteGen: LiteShadowGenerator | undefined;

    public getClassName(): string {
        return "ShadowGenerator";
    }

    // ── BJS technique flags / tunables (read at build time) ──
    /** Percentage-closer filtering. */
    public usePercentageCloserFiltering = false;
    /** Contact-hardening (treated as PCF here). */
    public useContactHardeningShadow = false;
    /** Blurred exponential shadow map (the Babylon.js default soft-shadow path for directional lights). */
    public useBlurExponentialShadowMap = false;
    public useExponentialShadowMap = false;
    public useBlurCloseExponentialShadowMap = false;
    public useCloseExponentialShadowMap = false;
    public usePoissonSampling = false;
    public useKernelBlur = false;
    public blurKernel = 1;
    public blurScale = 2;
    public bias = 0.00005;
    public normalBias = 0;
    public darkness = 0;
    public depthScale = 50;
    public frustumEdgeFalloff = 0;
    public forceBackFacesOnly = false;
    /** Babylon.js ortho projection bounds (directional). */
    public orthoMinZ: number | undefined;
    public orthoMaxZ: number | undefined;

    public constructor(mapSize: number, light: Light) {
        this._mapSize = mapSize;
        this._light = light;
        const scene = light.getScene();
        if (scene) {
            scene._registerShadowGenerator(this);
            scene._registerBeforeRenderFlush(() => this._flushCasterSync());
        }
    }

    /** Babylon.js `addShadowCaster(mesh, includeDescendants?)`. */
    public addShadowCaster(mesh: AbstractMesh, includeDescendants = true): ShadowGenerator {
        let changed = false;
        for (const caster of this._casterTree(mesh, includeDescendants)) {
            if (!this._casters.some((existing) => existing._lite === caster._lite)) {
                this._casters.push(caster);
                changed = true;
            }
        }
        if (changed) {
            this._scheduleCasterSync();
        }
        return this;
    }

    /** Babylon.js `removeShadowCaster(mesh, includeDescendants?)`. */
    public removeShadowCaster(mesh: AbstractMesh, includeDescendants = true): ShadowGenerator {
        let changed = false;
        for (const caster of this._casterTree(mesh, includeDescendants)) {
            const index = this._casters.findIndex((existing) => existing._lite === caster._lite);
            if (index !== -1) {
                this._casters.splice(index, 1);
                changed = true;
            }
        }
        if (changed) {
            this._scheduleCasterSync();
        }
        return this;
    }

    private _casterTree(mesh: AbstractMesh, includeDescendants: boolean): AbstractMesh[] {
        return includeDescendants ? [mesh, ...(mesh.getChildMeshes() as AbstractMesh[])] : [mesh];
    }

    private _scheduleCasterSync(): void {
        if (!this._liteGen) {
            return;
        }
        this._casterSyncDirty = true;
        if (this._casterSyncScheduled) {
            return;
        }
        this._casterSyncScheduled = true;
        queueMicrotask(() => {
            this._casterSyncScheduled = false;
            this._flushCasterSync();
        });
    }

    private _flushCasterSync(): void {
        if (!this._casterSyncDirty || !this._liteGen) {
            return;
        }
        this._casterSyncDirty = false;
        setShadowTaskCasterMeshes(
            this._liteGen,
            this._casters.map((caster) => caster._lite as LiteMesh)
        );
    }

    /** Babylon.js `getShadowMap()` — returns a minimal render-list holder for parity. */
    public getShadowMap(): { renderList: AbstractMesh[] } {
        return { renderList: this._casters };
    }

    public getDarkness(): number {
        return this.darkness;
    }
    public setDarkness(value: number): ShadowGenerator {
        this.darkness = value;
        return this;
    }

    public getLight(): Light {
        return this._light;
    }

    public dispose(): void {
        this._liteGen = undefined;
        this._light._lite.shadowGenerator = undefined;
    }

    /**
     * @internal Build the underlying Lite shadow generator and wire casters. Called
     * by the engine at start, after meshes are added and before the scene registers.
     */
    public _build(engine: EngineContext): void {
        const liteLight = this._light._lite as never;
        const className = this._light.getClassName();
        const usePcf = this.usePercentageCloserFiltering || this.useContactHardeningShadow || this.usePoissonSampling;

        let liteGen;
        if (this instanceof CascadedShadowGenerator) {
            liteGen = createCsmDirectionalShadowGenerator(engine, liteLight, {
                mapSize: this._mapSize,
                numCascades: this.numCascades,
                lambda: this.lambda,
                cascadeBlendPercentage: this.cascadeBlendPercentage,
                stabilizeCascades: this.stabilizeCascades,
                shadowMaxZ: this.shadowMaxZ,
                bias: this.bias,
                darkness: this.darkness,
                frustumEdgeFalloff: this.frustumEdgeFalloff,
            });
        } else if (className === "SpotLight") {
            // Lite has only a PCF spot generator.
            liteGen = createPcfSpotlightShadowGenerator(engine, liteLight, {
                mapSize: this._mapSize,
                bias: this.bias,
                darkness: this.darkness,
                normalBias: this.normalBias,
            });
        } else if (usePcf) {
            liteGen = createPcfDirectionalShadowGenerator(engine, liteLight, {
                mapSize: this._mapSize,
                bias: this.bias,
                darkness: this.darkness,
                normalBias: this.normalBias,
                ...(this.orthoMinZ !== undefined ? { orthoMinZ: this.orthoMinZ } : {}),
                ...(this.orthoMaxZ !== undefined ? { orthoMaxZ: this.orthoMaxZ } : {}),
            });
        } else {
            // Default directional soft shadow: ESM (Babylon.js default + blur variants).
            liteGen = createEsmDirectionalShadowGenerator(engine, liteLight, {
                mapSize: this._mapSize,
                depthScale: this.depthScale,
                bias: this.bias,
                blurKernel: this.useKernelBlur || this.useBlurExponentialShadowMap ? this.blurKernel : 1,
                blurScale: this.blurScale,
                darkness: this.darkness,
                frustumEdgeFalloff: this.frustumEdgeFalloff,
                ...(this.orthoMinZ !== undefined ? { orthoMinZ: this.orthoMinZ } : {}),
                ...(this.orthoMaxZ !== undefined ? { orthoMaxZ: this.orthoMaxZ } : {}),
            });
        }

        (liteLight as { shadowGenerator?: unknown }).shadowGenerator = liteGen;
        this._liteGen = liteGen;
        this._casterSyncDirty = false;
        const casterMeshes = this._casters.map((m) => m._lite as LiteMesh);
        setShadowTaskCasterMeshes(liteGen, casterMeshes);
    }
}

/** Babylon.js `CascadedShadowGenerator` backed by Lite's native CSM generator. */
export class CascadedShadowGenerator extends ShadowGenerator {
    private _numCascades = 4;
    public lambda = 0.5;
    public cascadeBlendPercentage = 0.1;
    public stabilizeCascades = false;
    public shadowMaxZ: number | undefined;
    public depthClamp = true;
    public autoCalcDepthBounds = false;

    public constructor(mapSize: number, light: DirectionalLight) {
        if (!(light instanceof DirectionalLight)) {
            throw new TypeError("CascadedShadowGenerator requires a DirectionalLight");
        }
        super(mapSize, light);
    }

    public get numCascades(): number {
        return this._numCascades;
    }

    public set numCascades(value: number) {
        this._numCascades = Math.min(Math.max(value, 2), 4);
    }

    public override getClassName(): string {
        return "CascadedShadowGenerator";
    }
}
