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
    /** @internal Shadow technique: 'esm' (exponential, default), 'pcf' (percentage closer filtering), or 'csm' (cascaded). */
    _shadowType: "esm" | "pcf" | "csm";
    /** @internal The light that owns this shadow generator. */
    _light: import("../light/types.js").LightBase;
    /** @internal Receiver-facing shadow map texture. PCF uses the depth texture; ESM uses the final blurred ESM texture; CSM uses the depth array texture. */
    _depthTexture: GPUTexture;
    /** @internal Number of cascades — set by the CSM generator, undefined otherwise. */
    _csmCascadeCount?: number;
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
    /** @internal Optional callbacks invoked each frame the receiver UBO is (re)written, after the
     *  GPU upload and before the shadow map / main pass render. Used by custom ShaderMaterial
     *  receivers (e.g. CSM) to mirror the fresh transforms into their own uniforms without a
     *  one-frame lag. Registered via the public `onCsmReceiverUpdate()`. */
    _onReceiverData?: ((data: Float32Array) => void)[];
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
