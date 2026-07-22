import { column, type ParticleBuffer } from "../particle-buffer.js";
import type { Vec2, Vec3, Color4 } from "../../../math/types.js";
import type { SoaGetter } from "../value.js";

/** Typed OncePerParticle component cache. Loaded only by graphs with vector/color once-random values. */
export function createTypedOnceRandomGetter(buffer: ParticleBuffer, blockId: number, draw: SoaGetter, valueType: string): SoaGetter {
    const cachedId = column(buffer, `random.${blockId}.id`, Uint32Array);
    const cachedValid = column(buffer, `random.${blockId}.valid`, Uint8Array);
    const components = valueType === "BABYLON.Color4" ? 4 : valueType === "BABYLON.Vector3" ? 3 : 2;
    const values = Array.from({ length: components }, (_, component) => column(buffer, `random.${blockId}.value${component}`, Float64Array));
    const vector2: Vec2 = { x: 0, y: 0 };
    const vector3: Vec3 = { x: 0, y: 0, z: 0 };
    const color4: Color4 = { r: 0, g: 0, b: 0, a: 0 };
    return (i) => {
        const id = buffer.id[i]!;
        if (cachedValid[i] === 0 || cachedId[i] !== id) {
            const drawn = draw(i);
            if (components === 2) {
                const vector = drawn as Vec2;
                values[0]![i] = vector.x;
                values[1]![i] = vector.y;
            } else if (components === 3) {
                const vector = drawn as Vec3;
                values[0]![i] = vector.x;
                values[1]![i] = vector.y;
                values[2]![i] = vector.z;
            } else {
                const color = drawn as Color4;
                values[0]![i] = color.r;
                values[1]![i] = color.g;
                values[2]![i] = color.b;
                values[3]![i] = color.a;
            }
            cachedId[i] = id;
            cachedValid[i] = 1;
        }
        if (components === 2) {
            vector2.x = values[0]![i]!;
            vector2.y = values[1]![i]!;
            return vector2;
        }
        if (components === 3) {
            vector3.x = values[0]![i]!;
            vector3.y = values[1]![i]!;
            vector3.z = values[2]![i]!;
            return vector3;
        }
        color4.r = values[0]![i]!;
        color4.g = values[1]![i]!;
        color4.b = values[2]![i]!;
        color4.a = values[3]![i]!;
        return color4;
    };
}
