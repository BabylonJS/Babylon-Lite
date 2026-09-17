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

/** Pack a logical group and radius class into the geometry renderer's one-byte tag. */
export function packMeshBlendingTag(groupId: number, radiusClass: MeshBlendingRadiusClass): number {
    if (!Number.isInteger(groupId) || groupId < 0 || groupId > 63) {
        throw new RangeError("Mesh-blending group ID must be an integer between 0 and 63.");
    }
    if (groupId === 0) {
        return 0;
    }
    if (!Number.isInteger(radiusClass) || radiusClass < MeshBlendingRadiusClass.Small || radiusClass > MeshBlendingRadiusClass.ExtraLarge) {
        throw new RangeError("Mesh-blending radius class must be an integer between 0 and 3.");
    }
    return (radiusClass << 6) | groupId;
}

/** Validate and return a packed mesh-blending tag. */
export function validatePackedMeshBlendingTag(tag: number): number {
    if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) {
        throw new RangeError("Mesh-blending tag must be an integer between 0 and 255.");
    }
    if (tag !== 0 && (tag & 0x3f) === 0) {
        throw new RangeError("A nonzero mesh-blending tag must contain a group ID between 1 and 63.");
    }
    return tag;
}

/** Decode a validated packed mesh-blending tag. */
export function unpackMeshBlendingTag(tag: number): MeshBlendingTag {
    const packed = validatePackedMeshBlendingTag(tag);
    return {
        groupId: packed & 0x3f,
        radiusClass: (packed >> 6) as MeshBlendingRadiusClass,
    };
}

/** Resolve the tag owned by a mesh. Thin instances use their draw-owning mesh's tag. */
export function resolveMeshBlendingTag(mesh: Mesh): number {
    return validatePackedMeshBlendingTag(mesh.meshBlendingTag ?? 0);
}
