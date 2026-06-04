interface ShadowGeneratorRuntimeConfig {
    _mapSize: number;
    _bias: number;
    _orthoMinZ?: number;
    _orthoMaxZ?: number;
    _forceRefreshEveryFrame: boolean;
}

export interface ShadowTaskInternalState {
    /** @internal */
    _task: {
        record(): void;
        execute?(): number;
        dispose(): void;
    };
    /** @internal */
    _casterMeshes: readonly import("../mesh/mesh.js").Mesh[];
}

/** Runtime state for a light's shadow generator: shadow technique, map textures, light matrix, and per-frame task hooks. */
export interface ShadowGenerator {
    /** @internal Shadow technique: 'esm' (exponential, default) or 'pcf' (percentage closer filtering). */
    _shadowType: "esm" | "pcf";
    /** @internal The light that owns this shadow generator. */
    _light: import("../light/types.js").LightBase;
    /** @internal Receiver-facing shadow map texture. PCF uses the depth texture; ESM uses the final blurred ESM texture. */
    _depthTexture: GPUTexture;
    /** @internal Receiver-facing shadow map sampler. */
    _depthSampler: GPUSampler;
    /** @internal */
    _lightMatrix: Float32Array;
    /** @internal */
    _shadowsInfo: Float32Array;
    /** @internal */
    _depthValues: Float32Array;
    /** @internal */
    _shadowParamsUBO: GPUBuffer;
    /** @internal Shared shadow UBO (96 bytes) for receiver meshes: _lightMatrix(16) + _depthValues(4) + _shadowsInfo(4).
     *  Updated once per version bump; all receivers bind this same buffer. */
    _shadowUBO: GPUBuffer;
    /** @internal */
    _config: ShadowGeneratorRuntimeConfig;
    /** @internal Monotonically increasing version — bumped each time _lightMatrix/_shadowsInfo/_depthValues changes.
     *  Consumers compare against a stashed version to skip redundant UBO uploads. */
    _version: number;
    /** @internal */
    _shadowTaskState?: ShadowTaskInternalState;
    /** @internal Dynamically imports and prepares the shadow-map render task for the given caster meshes. */
    _preloadShadowTask?(casterMeshes: readonly import("../mesh/mesh.js").Mesh[]): Promise<void>;
    /** @internal Lazily creates (or returns the cached) shadow-task state for rendering the shadow map this frame. */
    _ensureShadowTaskState?(
        engine: import("../engine/engine.js").EngineContext,
        scene: import("../scene/scene-core.js").SceneContext,
        casterMeshes: readonly import("../mesh/mesh.js").Mesh[]
    ): ShadowTaskInternalState;
    /** @internal Records the shadow-map render pass for the given task state and returns the number of draw calls issued. */
    _renderShadowMap?(engine: import("../engine/engine.js").EngineContext, state: ShadowTaskInternalState): number;
}
