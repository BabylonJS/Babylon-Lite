import { _validateGeometryMeshBlendTag } from "../frame-graph/geometry-types.js";
import type { Mesh } from "./mesh.js";

/** Radius class encoded in the high two bits of a mesh-blending tag. */
export enum MeshBlendingRadiusClass {
    Small = 0,
    Medium = 1,
    Large = 2,
    ExtraLarge = 3,
}

/** Decoded mesh-blending tag. */
export interface MeshBlendingTag {
    readonly groupId: number;
    readonly radiusClass: MeshBlendingRadiusClass;
}

/** Radius values associated with one mesh-blending radius class. */
export interface MeshBlendRadiusDefinition {
    worldRadius: number;
    minimumProjectedRadius: number;
}

/** The four radius definitions indexed by packed radius class. */
export type MeshBlendRadiusDefinitions = readonly [MeshBlendRadiusDefinition, MeshBlendRadiusDefinition, MeshBlendRadiusDefinition, MeshBlendRadiusDefinition];

/** Pack a logical group and radius class into the geometry renderer's one-byte tag. */
export function packMeshBlendingTag(groupId: number, radiusClass: MeshBlendingRadiusClass): number {
    if (!Number.isInteger(groupId) || groupId < 0 || groupId > 63) {
        throw new RangeError("Mesh-blending group ID must be an integer between 0 and 63.");
    }
    if (groupId === 0) {
        return 0;
    }
    if (!Number.isInteger(radiusClass) || radiusClass < 0 || radiusClass > 3) {
        throw new RangeError("Mesh-blending radius class must be an integer between 0 and 3.");
    }
    return (radiusClass << 6) | groupId;
}

/** Validate and return a packed mesh-blending tag. */
export function validatePackedMeshBlendingTag(tag: number): number {
    return _validateGeometryMeshBlendTag(tag);
}

/** Decode a validated packed mesh-blending tag. */
export function unpackMeshBlendingTag(tag: number): MeshBlendingTag {
    const packed = validatePackedMeshBlendingTag(tag);
    return { groupId: packed & 0x3f, radiusClass: (packed >> 6) as MeshBlendingRadiusClass };
}

function radiusDefinition(worldRadius: number, minimumProjectedRadius: number): MeshBlendRadiusDefinition {
    let currentWorldRadius = worldRadius;
    let currentMinimumProjectedRadius = minimumProjectedRadius;
    const definition = {} as MeshBlendRadiusDefinition;
    Object.defineProperties(definition, {
        worldRadius: {
            enumerable: true,
            get: () => currentWorldRadius,
            set: (value: number) => {
                if (!Number.isFinite(value) || value < 0) {
                    throw new RangeError("Mesh-blending world radii must be finite non-negative numbers.");
                }
                currentWorldRadius = value;
            },
        },
        minimumProjectedRadius: {
            enumerable: true,
            get: () => currentMinimumProjectedRadius,
            set: (value: number) => {
                if (!Number.isFinite(value) || value < 0) {
                    throw new RangeError("Mesh-blending minimum projected radii must be finite non-negative numbers.");
                }
                currentMinimumProjectedRadius = value;
            },
        },
    });
    return definition;
}

/** Create Babylon-compatible defaults for all four packed radius classes. */
export function createDefaultMeshBlendRadiusDefinitions(): MeshBlendRadiusDefinitions {
    return Object.freeze([radiusDefinition(0.06, 1.5), radiusDefinition(0.1, 3), radiusDefinition(0.2, 3), radiusDefinition(0.3, 5)]) as MeshBlendRadiusDefinitions;
}

/** Resolve the tag owned by a mesh. Thin instances use their draw-owning mesh's tag. */
export function resolveMeshBlendingTag(mesh: Mesh): number {
    return validatePackedMeshBlendingTag(mesh.meshBlendingTag ?? 0);
}
