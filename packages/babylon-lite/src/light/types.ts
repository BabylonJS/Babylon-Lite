/** Light extension types and registry.
 *
 *  Each light type provides pipeline integration through these interfaces.
 *  The render pipeline never checks light type — it calls the registered
 *  extension, which the light's factory sets up via _registerExtension. */

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
    /** Lazily install this light's WGSL+UBO extension into the global light extension
     *  registry. Called by render pipelines on first use. */
    readonly _registerExtension: () => Promise<void>;
    readonly _writeStandardLightUbo?: ((data: Float32Array, offset: number) => void) | undefined;
    /** Monotonically increasing version — bumped when any UBO-relevant property changes. */
    readonly _lightVersion: number;
}

/** Check whether a light affects a given mesh (by mesh ID).
 *  Returns true when the mesh should receive this light's contribution. */
// Removed: lightAffectsMesh was unused — inline the logic at call sites if needed.

/** Maximum simultaneous lights for standard material shading. */
export const MAX_LIGHTS = 4;

/** Bytes per light entry in the lights UBO (4 × vec4 = 64 bytes). */
export const LIGHT_ENTRY_FLOATS = 16;

/** Light pipeline-integration extension — provides WGSL shader snippets + UBO writer.
 *  Registered globally via `_setLightExtension`. One active at a time.
 *
 *  WGSL emit hooks (`emitLightVector`, `emitDirectDiffuse`, `emitGeometricAA`) are
 *  consumed by PBR templates. The data written by `writeSceneUbo` lands in
 *  material-orthogonal slots of the scene UBO (`lightDirection`, `lightDiffuseColor`,
 *  `lightGroundColor`, `lightPosition`, `lightRange`) — any material may read them. */
export interface LightExtension {
    /** Human-readable tag for pipeline cache key differentiation. */
    readonly tag: string;
    /** WGSL: compute L vector + NdotL. Assumes N, scene are in scope. */
    emitLightVector(): string;
    /** WGSL: compute direct diffuse. Assumes NdotL, surfaceAlbedo, lightColor, mesh in scope. */
    emitDirectDiffuse(): string;
    /** WGSL: geometric AA for specular roughness. Empty string if not needed. */
    emitGeometricAA(): string;
    /** Write light data into the unified scene UBO at the hard-coded float
     *  indices that match shaders/scene-uniforms.wgsl (lightDirection @ 36,
     *  lightIntensity @ 39, lightDiffuseColor @ 40, lightGroundColor @ 44,
     *  lightPosition @ 48, lightRange @ 51). */
    writeSceneUbo(data: Float32Array, light: LightBase): void;
}
