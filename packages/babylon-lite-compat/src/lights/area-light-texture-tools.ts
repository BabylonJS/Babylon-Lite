import { processAreaLightTexture } from "babylon-lite";

import type { AbstractEngine } from "../engine/engine.js";
import { ShaderLanguage } from "../misc/engine-constants.js";
import { BaseTexture } from "../textures/textures.js";

class ProcessedAreaLightTexture extends BaseTexture {
    public constructor(texture: NonNullable<BaseTexture["_lite"]>) {
        super();
        this._lite = texture;
    }

    public whenReadyAsync(): Promise<void> {
        return Promise.resolve();
    }
}

/** Babylon.js `AreaLightTextureTools` forwarding to Lite's native emission-image processor. */
export class AreaLightTextureTools {
    /** @internal Underlying compat engine whose Lite handle performs the processing. */
    private readonly _engine: AbstractEngine;
    /** @internal BJS reports GLSL until the WebGPU processing effect is initialized. */
    private _shaderLanguage = ShaderLanguage.GLSL;
    /** @internal Whether the Lite processor has completed at least once. */
    private _ready = false;

    public constructor(engine: AbstractEngine) {
        this._engine = engine;
    }

    public get shaderLanguage(): ShaderLanguage {
        return this._shaderLanguage;
    }

    public isReady(): boolean {
        return this._ready;
    }

    public async processAsync(source: BaseTexture): Promise<BaseTexture | null> {
        await source.whenReadyAsync();
        if (!source._lite) {
            return null;
        }
        const processed = await processAreaLightTexture(this._engine._lite, source._lite);
        this._shaderLanguage = ShaderLanguage.WGSL;
        this._ready = true;
        return new ProcessedAreaLightTexture(processed);
    }

    public dispose(): void {
        // Lite owns processed texture lifetimes through its resource pool.
    }
}
