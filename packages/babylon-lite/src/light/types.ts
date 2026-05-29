/** Light extension types and registry.
 *
 *  Each light type provides pipeline integration callbacks.
 *  PBR + Standard both consume the shared lights UBO (render/lights-ubo.ts);
 *  light type is encoded in vLightData.w (1=dir, 2=spot, 3=hemi, other=point). */

import type { Mat4 } from "../math/types.js";
import type { IWorldMatrixProvider, IParentable } from "../scene/parentable.js";
import type { SceneNode } from "../scene/scene-node.js";

/** Shared base for all light types.
 *  Provides pipeline integration callbacks so render pipelines are light-agnostic. */
export interface LightBase extends IWorldMatrixProvider, IParentable {
    readonly lightType: string;
    children: SceneNode[];
    /** Mesh IDs excluded from this light. If set, these meshes are NOT lit by this light. */
    excludedMeshIds?: ReadonlySet<string>;
    /** If non-empty, ONLY these mesh IDs are lit by this light. Takes priority over excludedMeshIds. */
    includedOnlyMeshIds?: ReadonlySet<string>;
    /** Shadow generator attached to this light. Set this to make the light cast shadows. */
    shadowGenerator?: import("../shadow/shadow-generator.js").ShadowGenerator;

    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

/** @internal LightBase with internal pipeline integration callbacks. Not re-exported from index.ts. */
export interface LightBaseInternal extends LightBase {
    readonly _writeLightUbo?: ((data: Float32Array, offset: number) => void) | undefined;
    /** Monotonically increasing version — bumped when any UBO-relevant property changes. */
    readonly _lightVersion: number;
}

/** Maximum number of scene lights packed into the shared lights UBO.
 *  Babylon.js defaults to 4 lights per material; Babylon Lite's cap is scene-wide
 *  because all materials index the same group-0 lights buffer. Raise via
 *  `setMaxLights(n)` before creating any scene / loading any asset that needs
 *  more lights (e.g. the glTF loader auto-raises this when an asset declares
 *  more KHR_lights_punctual lights than the current cap). */
export let MAX_LIGHTS = 16;

/** Raise (or lower) the maximum number of scene lights in the shared lights UBO.
 *  Must be called BEFORE scene pipelines are compiled — existing pipelines
 *  and UBOs bake the cap into their WGSL/layout. */
export function setMaxLights(n: number): void {
    if (!Number.isFinite(n) || n < 1) {
        throw new Error(`setMaxLights: expected positive integer, got ${n}`);
    }
    MAX_LIGHTS = n | 0;
}

/** Bytes per light entry in the lights UBO (4 × vec4 = 64 bytes). */
export const LIGHT_ENTRY_FLOATS = 16;
