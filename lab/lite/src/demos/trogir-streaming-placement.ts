import type { GaussianSplatStream } from "babylon-lite";

export interface TrogirOrbitTarget {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** Applies the scene orientation authored by the published Trogir viewer. */
export function placeTrogirStream(stream: GaussianSplatStream): TrogirOrbitTarget {
    // This is viewer-authored placement, not part of the generic SOG coordinate conversion.
    stream.rotation.z = Math.PI;
    const centerX = (stream.boundMin[0] + stream.boundMax[0]) * 0.5;
    const centerY = (stream.boundMin[1] + stream.boundMax[1]) * 0.5;
    const centerZ = (stream.boundMin[2] + stream.boundMax[2]) * 0.5;
    const world = stream.worldMatrix;
    return {
        x: world[0]! * centerX + world[4]! * centerY + world[8]! * centerZ + world[12]!,
        y: world[1]! * centerX + world[5]! * centerY + world[9]! * centerZ + world[13]!,
        z: world[2]! * centerX + world[6]! * centerY + world[10]! * centerZ + world[14]!,
    };
}
