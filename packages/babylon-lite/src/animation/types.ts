// Animation data types — flat structs, no classes.
// Designed for zero-allocation per-frame evaluation.

import type { Mat4 } from "../math/types.js";

// Interpolation modes (numeric for fast comparison in hot path)
export const INTERP_LINEAR = 0;
export const INTERP_STEP = 1;
export const INTERP_CUBICSPLINE = 2;

// Target paths (numeric)
export const PATH_TRANSLATION = 0;
export const PATH_ROTATION = 1;
export const PATH_SCALE = 2;
export const PATH_WEIGHTS = 3;
/** KHR_animation_pointer target — value is dispatched to an arbitrary writer
 *  resolved from the JSON pointer at load time. */
export const PATH_POINTER = 4;

export type InterpMode = 0 | 1 | 2;
export type TargetPath = 0 | 1 | 2 | 3 | 4;

/** Parsed keyframe sampler — times + values + interpolation. */
export interface AnimationSampler {
    /** Keyframe timestamps in seconds (monotonically increasing). */
    readonly input: Float32Array;
    /** Keyframe output values (vec3/quat/scalar packed sequentially).
     *  For CUBICSPLINE: [inTangent, value, outTangent] per keyframe. */
    readonly output: Float32Array;
    readonly interpolation: InterpMode;
}

/** Single animation channel — targets one node property, or an arbitrary
 *  KHR_animation_pointer target resolved at load time to a writer function. */
export interface AnimationChannel {
    readonly samplerIdx: number;
    /** For standard channels: glTF node index. For `PATH_POINTER`: unused (-1). */
    readonly nodeIdx: number;
    readonly path: TargetPath;
    /** PATH_POINTER only: invoked per-frame with the interpolated sampler output.
     *  The writer is responsible for applying the value to the runtime target
     *  (node.visible, material factor, camera fov, light color, ...). */
    readonly pointerWriter?: (output: Float32Array, offset: number) => void;
    /** PATH_POINTER only: number of floats per keyframe (1, 3, 4, ...). */
    readonly pointerArity?: number;
    /** PATH_POINTER only: true when LINEAR interpolation should use quaternion slerp. */
    readonly pointerQuaternion?: boolean;
    /** @internal PATH_POINTER stable identity used by optional weighted manual-property mixing. */
    readonly _mk?: object;
}

/** One glTF animation clip (may animate many nodes). */
export interface AnimationClip {
    readonly name: string;
    readonly channels: readonly AnimationChannel[];
    readonly samplers: readonly AnimationSampler[];
    /** Total duration in seconds (max of all sampler input times). */
    readonly duration: number;
    /** Frame rate used by AnimationGroup goToFrame(); defaults to 60. */
    readonly frameRate?: number;
}

/** Per-node rest pose TRS + parent link for hierarchy traversal. */
export interface NodeRest {
    readonly parentIdx: number; // -1 for root nodes
    readonly _matrix?: Mat4;
    tx: number;
    ty: number;
    tz: number;
    rx: number;
    ry: number;
    rz: number;
    rw: number;
    sx: number;
    sy: number;
    sz: number;
}

/** Connects a skeleton to its GPU bone texture for per-frame updates. */
export interface SkeletonBinding {
    readonly jointNodes: readonly number[];
    readonly inverseBindMatrices: Float32Array;
    readonly invMeshWorld: Mat4;
    readonly boneTexture: GPUTexture;
    readonly boneCount: number;
    readonly boneMatrices: Float32Array;
    readonly runtimeSkeleton?: SkeletonData;
}

/** Connects a morph-target mesh to its GPU weight buffer for per-frame updates. */
export interface MorphBinding {
    /** Node index that owns the morph targets. */
    readonly nodeIdx: number;
    /** GPU uniform buffer written each frame with current weights. */
    readonly weightsBuffer: GPUBuffer;
    /** CPU mirror of the first four current weights, used by deformation-aware picking. */
    readonly weights: Float32Array;
    /** Number of morph targets (max 4 supported). */
    readonly targetCount: number;
    readonly runtimeMorphTargets?: MorphTargetData;
}

/** Everything the animation system needs, parsed from a glTF file. */
export interface GltfAnimationData {
    readonly clips: readonly AnimationClip[];
    readonly nodes: readonly NodeRest[];
    readonly skeletons: readonly SkeletonBinding[];
    readonly morphBindings: readonly MorphBinding[];
}

// ─── GPU-side data objects attached to Mesh ─────────────────────────────────

/** Skeleton GPU data — bone texture + vertex buffers for skinning.
 *  Created by createSkeleton() in skeleton/create-skeleton.ts.
 *  Attached to mesh.skeleton. */
export interface SkeletonData {
    readonly boneTexture: GPUTexture;
    readonly boneCount: number;
    readonly jointsBuffer: GPUBuffer;
    readonly weightsBuffer: GPUBuffer;
    readonly joints: Uint16Array | Uint8Array;
    readonly weights: Float32Array;
    readonly boneMatrices: Float32Array;
    /** Extra joints/weights for 8-bone skinning (JOINTS_1/WEIGHTS_1). */
    readonly joints1Buffer: GPUBuffer | null;
    readonly weights1Buffer: GPUBuffer | null;
    readonly joints1: Uint16Array | Uint8Array | null;
    readonly weights1: Float32Array | null;
}

/** Morph target GPU data — delta texture + weights UBO.
 *  Created by createMorphTargets() in morph/create-morph-targets.ts.
 *  Attached to mesh.morphTargets. */
export interface MorphTargetData {
    readonly texture: GPUTexture;
    readonly count: number;
    readonly weightsBuffer: GPUBuffer;
    readonly targets: readonly { positions: Float32Array; normals: Float32Array | null }[];
    readonly weights: Float32Array;
}
