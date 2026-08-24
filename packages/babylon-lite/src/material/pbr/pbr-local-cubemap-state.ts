import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { EngineContext } from "../../engine/engine.js";
import type { PbrMaterialProps } from "./pbr-material.js";

interface PbrLocalEnvironmentBaseOptions {
    /** Cubemap capture position in world space. Defaults to projectionPosition. */
    readonly capturePosition?: readonly [number, number, number];
    /** Centre of the parallax-projection volume in world space. */
    readonly projectionPosition: readonly [number, number, number];
}

export type PbrLocalEnvironmentOptions = PbrLocalEnvironmentBaseOptions &
    (
        | {
              /** Box projection is the backward-compatible default. */
              readonly shape?: "box";
              /** Full extents of the parallax-projection box. */
              readonly projectionSize: readonly [number, number, number];
          }
        | {
              readonly shape: "sphere";
              /** Radius of the parallax-projection sphere. */
              readonly projectionRadius: number;
          }
    );

interface PbrLocalEnvironmentProbeBase {
    /** Prefiltered cubemap copied into the shared cube texture array. */
    readonly environment: EnvironmentTextures;
    /** Cubemap capture position in world space. */
    readonly capturePosition: readonly [number, number, number];
    /** Centre of the parallax-projection volume in world space. */
    readonly projectionPosition: readonly [number, number, number];
    /** Centre of the influence volume in world space. */
    readonly influencePosition: readonly [number, number, number];
    /** Probe yaw in radians. Defaults to zero. */
    readonly angleRadians?: number;
    /** Linear RGB used by the optional per-fragment blend-color diagnostic. */
    readonly debugColor?: readonly [number, number, number];
}

export type PbrLocalEnvironmentProbe = PbrLocalEnvironmentProbeBase &
    (
        | {
              /** Box projection and influence are the backward-compatible default. */
              readonly shape?: "box";
              /** Full extents of the parallax-projection box. */
              readonly projectionSize: readonly [number, number, number];
              /** Full extents where this probe has full influence. */
              readonly influenceInnerSize: readonly [number, number, number];
              /** Centre of the outer influence box. Defaults to influencePosition. */
              readonly influenceOuterPosition?: readonly [number, number, number];
              /** Full extents where this probe reaches zero influence. */
              readonly influenceOuterSize: readonly [number, number, number];
          }
        | {
              readonly shape: "sphere";
              /** Radius of the parallax-projection sphere. */
              readonly projectionRadius: number;
              /** Radius where this probe has full influence. */
              readonly influenceInnerRadius: number;
              /** Radius where this probe reaches zero influence. */
              readonly influenceOuterRadius: number;
          }
    );

export interface PbrLocalEnvironmentProbeSet {
    readonly probes: readonly PbrLocalEnvironmentProbe[];
    /** @internal Shared local-environment probe UBO. */
    _uniformBuffer: GPUBuffer;
    /** @internal Packed CPU mirror of {@link _uniformBuffer}. */
    readonly _uniformData: Float32Array;
    /** @internal Integer view over {@link _uniformData}. */
    readonly _uniformU32: Uint32Array;
    /** @internal Prefiltered cubemap array. */
    _texture: GPUTexture;
    /** @internal Cube-array view of {@link _texture}. */
    _textureView: GPUTextureView;
    /** @internal Shared trilinear sampler. */
    _sampler: GPUSampler;
    /** @internal Dense world-space voxel lookup buffer. */
    _gridBuffer: GPUBuffer;
    /** @internal Packed CPU mirror of {@link _gridBuffer}. */
    readonly _gridData: Uint32Array;
    /** @internal Minimum corner of the voxel grid. */
    readonly _gridMinimum: readonly [number, number, number];
    /** @internal Uniform voxel edge length. */
    readonly _gridCellSize: number;
    /** @internal Dense grid dimensions. */
    readonly _gridDimensions: readonly [number, number, number];
    /** @internal U32 values stored per voxel, including its count. */
    readonly _gridStride: number;
    /** @internal Engine that owns the probe-set resources. */
    readonly _engine: EngineContext;
    /** @internal Device that owns the current resources. */
    _device: GPUDevice;
    /** @internal Recreate resources after the engine replaces its GPU device. */
    readonly _ensureDevice: () => void;
}

export type PbrLocalEnvironmentState =
    | {
          readonly kind: "environment";
          readonly environment: EnvironmentTextures;
      }
    | {
          readonly kind: "single";
          readonly environment: EnvironmentTextures;
          readonly shape: "box" | "sphere";
          readonly capturePosition: readonly [number, number, number];
          readonly projectionPosition: readonly [number, number, number];
          readonly projectionSize: readonly [number, number, number];
      }
    | {
          readonly kind: "probes";
          readonly set: PbrLocalEnvironmentProbeSet;
      };

let _states: WeakMap<object, PbrLocalEnvironmentState> | null = null;

/** @internal */
export function _getPbrLocalEnvironment(material: unknown): PbrLocalEnvironmentState | undefined {
    return material && typeof material === "object" ? _states?.get(material) : undefined;
}

/** @internal */
export function _setPbrLocalEnvironment(material: PbrMaterialProps, state: PbrLocalEnvironmentState | null): void {
    if (state) {
        (_states ??= new WeakMap()).set(material, state);
    } else {
        _states?.delete(material);
    }
    material._renderFeatures = undefined;
}
