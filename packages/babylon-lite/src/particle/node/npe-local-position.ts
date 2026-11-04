import { transformCoordinatesToRef } from "../../math/mat4-transform.js";
import type { Mat4, Vec3 } from "../../math/types.js";
import type { ParticleSystem } from "../particle-system.js";
import type { ParticleBuffer } from "../particle-buffer.js";

/** Finish a local shape's position slot: seed optional local columns, then write the world render position. */
export function finishLocalPosition(system: ParticleSystem, buffer: ParticleBuffer, i: number, emitterWorldMatrix: Mat4, scratch: Vec3): void {
    system._seedLocalPosition?.(i);
    transformCoordinatesToRef(buffer.posX[i]!, buffer.posY[i]!, buffer.posZ[i]!, emitterWorldMatrix, scratch);
    buffer.posX[i] = scratch.x;
    buffer.posY[i] = scratch.y;
    buffer.posZ[i] = scratch.z;
}
