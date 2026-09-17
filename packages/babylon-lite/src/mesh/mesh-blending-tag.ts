export interface MeshBlendingTag {
    groupId: number;
    radiusClass: number;
}

export interface MeshBlendRadiusDefinition {
    worldRadius: number;
    minimumProjectedRadius: number;
}

export type MeshBlendRadiusDefinitions = readonly [MeshBlendRadiusDefinition, MeshBlendRadiusDefinition, MeshBlendRadiusDefinition, MeshBlendRadiusDefinition];

export function packMeshBlendingTag(groupId: number, radiusClass: number): number {
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

export function unpackMeshBlendingTag(tag: number): MeshBlendingTag {
    if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) {
        throw new RangeError("Mesh-blending tag must be an integer between 0 and 255.");
    }
    const groupId = tag & 0x3f;
    if (tag !== 0 && groupId === 0) {
        throw new RangeError("A nonzero mesh-blending tag must contain a group ID between 1 and 63.");
    }
    return { groupId, radiusClass: tag >> 6 };
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

export function createDefaultMeshBlendRadiusDefinitions(): MeshBlendRadiusDefinitions {
    return Object.freeze([radiusDefinition(0.06, 1.5), radiusDefinition(0.1, 3), radiusDefinition(0.2, 3), radiusDefinition(0.3, 5)]) as MeshBlendRadiusDefinitions;
}
