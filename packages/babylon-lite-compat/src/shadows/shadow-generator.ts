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

import { createEsmDirectionalShadowGenerator, createPcfDirectionalShadowGenerator, createPcfSpotlightShadowGenerator, setShadowTaskCasterMeshes } from "babylon-lite";
import type { EngineContext, Mesh as LiteMesh } from "babylon-lite";

import type { Light } from "../lights/lights.js";
import type { AbstractMesh } from "../meshes/meshes.js";

export class ShadowGenerator {
    private readonly _mapSize: number;
    private readonly _light: Light;
    private readonly _casters: AbstractMesh[] = [];
    /** @internal The built Lite shadow generator (set in `_build`). Used to wire NME receivers. */
    public _liteGen: unknown;

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
        }
    }

    /** Babylon.js `addShadowCaster(mesh, includeDescendants?)`. */
    public addShadowCaster(mesh: AbstractMesh, _includeDescendants = true): ShadowGenerator {
        if (!this._casters.includes(mesh)) {
            this._casters.push(mesh);
        }
        return this;
    }

    /** Babylon.js `removeShadowCaster(mesh)`. */
    public removeShadowCaster(mesh: AbstractMesh): ShadowGenerator {
        const i = this._casters.indexOf(mesh);
        if (i >= 0) {
            this._casters.splice(i, 1);
        }
        return this;
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
        if (className === "SpotLight") {
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
        const casterMeshes = this._casters.map((m) => m._lite as LiteMesh);
        setShadowTaskCasterMeshes(liteGen, casterMeshes);
    }
}

/**
 * Babylon.js `CascadedShadowGenerator` — cascaded shadow maps for large directional
 * scenes. Mapped onto Babylon Lite's CSM generator is a larger task; for now this
 * extends {@link ShadowGenerator} and falls back to the standard directional path,
 * which renders (a single cascade's worth of) shadows rather than throwing.
 */
export class CascadedShadowGenerator extends ShadowGenerator {
    public numCascades = 4;
    public lambda = 0.5;
    public stabilizeCascades = false;
    public depthClamp = true;
    public autoCalcDepthBounds = false;

    public override getClassName(): string {
        return "CascadedShadowGenerator";
    }
}
