interface ShadowGeneratorRuntimeConfig {
    _mapSize: number;
    _bias: number;
    _orthoMinZ?: number;
    _orthoMaxZ?: number;
    _forceRefreshEveryFrame: boolean;
}

export interface ShadowTaskInternalState {
    _task: {
        record(): void;
        execute?(): number;
        dispose(): void;
    };
    _casterMeshes: readonly import("../mesh/mesh.js").Mesh[];
}

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
    /** @internal */
    _preloadShadowTask?(casterMeshes: readonly import("../mesh/mesh.js").Mesh[]): Promise<void>;
    /** @internal */
    _ensureShadowTaskState?(
        engine: import("../engine/engine.js").EngineContextInternal,
        scene: import("../scene/scene-core.js").SceneContextInternal,
        casterMeshes: readonly import("../mesh/mesh.js").Mesh[]
    ): ShadowTaskInternalState;
    /** @internal */
    _renderShadowMap?(engine: import("../engine/engine.js").EngineContextInternal, state: ShadowTaskInternalState): number;
}
