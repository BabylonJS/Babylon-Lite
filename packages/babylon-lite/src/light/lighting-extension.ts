import type { StandardSceneShaderContext } from "../material/standard/standard-material.js";
import type { ShaderFragment } from "../shader/fragment-types.js";

/** @internal Material-owned single-light shader contribution. */
export interface SingleLightShaderSource {
    SINGLE_LIGHT_STRUCTS: string;
    getSingleLightBlock(): string;
}

/** @internal Material-owned multi-light shader contribution. */
export interface MultiLightShaderSource {
    /** @internal */
    _helpers: string;
    /** @internal */
    _loop: string;
}

/** @internal Optional, scene-owned material lighting extension. */
export interface SceneLightingExtension {
    /** @internal Opaque scalar used by material-owned binding extensions. */
    _bindingId?: number;
    /** @internal */
    _prepare(): Promise<void>;
    /** @internal */
    _single?(type: string): SingleLightShaderSource | undefined;
    /** @internal */
    _multi?(): MultiLightShaderSource;
    /** @internal */
    _pbrFeatures?(meshId: string | undefined): number;
    /** @internal */
    _standard?(fog: ShaderFragment | null): StandardSceneShaderContext;
    /** @internal */
    _validateNode?(usesLights: boolean): void;
}
