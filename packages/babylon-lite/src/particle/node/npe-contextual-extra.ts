import { column, type ParticleBuffer } from "../particle-buffer.js";
import type { ParticleSystem } from "../particle-system.js";
import type { NpeGetter } from "./npe-value.js";
import { color4Getter } from "./npe-contextual.js";
import type { Vec2, Vec3 } from "../../math/types.js";

const CTX_DIRECTION = 0x0002;
const CTX_SCALE = 0x0007;
const CTX_AGE_GRADIENT = 0x0008;
const CTX_ANGLE = 0x0009;
const CTX_INITIAL_COLOR = 0x0013;
const CTX_COLOR_DEAD = 0x0014;
const CTX_INITIAL_DIRECTION = 0x0015;
const CTX_COLOR_STEP = 0x0016;
const CTX_SIZE = 0x0019;
const CTX_DIRECTION_SCALE = 0x0020;

/** Build a contextual getter for sources outside the common particle-scene subset. */
export function makeExtraContextualGetter(buffer: ParticleBuffer, system: ParticleSystem, source: number): NpeGetter {
    switch (source) {
        case CTX_AGE_GRADIENT:
            return (i) => buffer.age[i]! / buffer.lifeTime[i]!;
        case CTX_DIRECTION: {
            const scratch: Vec3 = { x: 0, y: 0, z: 0 };
            return (i) => {
                scratch.x = buffer.dirX[i]!;
                scratch.y = buffer.dirY[i]!;
                scratch.z = buffer.dirZ[i]!;
                return scratch;
            };
        }
        case CTX_DIRECTION_SCALE:
            return () => system._scaledStep;
        case CTX_SIZE: {
            const size = buffer.size;
            return (i) => size[i]!;
        }
        case CTX_ANGLE: {
            const angle = buffer.angle;
            return (i) => angle[i]!;
        }
        case CTX_SCALE: {
            const scaleX = buffer.scaleX;
            const scaleY = buffer.scaleY;
            const scratch: Vec2 = { x: 0, y: 0 };
            return (i) => {
                scratch.x = scaleX[i]!;
                scratch.y = scaleY[i]!;
                return scratch;
            };
        }
        case CTX_INITIAL_COLOR: {
            const initialR = column(buffer, "initialColor.r", Float32Array);
            const initialG = column(buffer, "initialColor.g", Float32Array);
            const initialB = column(buffer, "initialColor.b", Float32Array);
            const initialA = column(buffer, "initialColor.a", Float32Array);
            const colorR = buffer.colorR;
            const colorG = buffer.colorG;
            const colorB = buffer.colorB;
            const colorA = buffer.colorA;
            const previous = system.createColorDead;
            system.createColorDead = (i) => {
                initialR[i] = colorR[i]!;
                initialG[i] = colorG[i]!;
                initialB[i] = colorB[i]!;
                initialA[i] = colorA[i]!;
                previous?.(i);
            };
            return color4Getter(initialR, initialG, initialB, initialA);
        }
        case CTX_COLOR_DEAD: {
            const deadR = column(buffer, "colorDead.r", Float32Array);
            const deadG = column(buffer, "colorDead.g", Float32Array);
            const deadB = column(buffer, "colorDead.b", Float32Array);
            const deadA = column(buffer, "colorDead.a", Float32Array);
            system._writeColorDead = (i, color) => {
                deadR[i] = color.r;
                deadG[i] = color.g;
                deadB[i] = color.b;
                deadA[i] = color.a;
            };
            return color4Getter(deadR, deadG, deadB, deadA);
        }
        case CTX_COLOR_STEP:
            return color4Getter(buffer.colorStepR, buffer.colorStepG, buffer.colorStepB, buffer.colorStepA);
        case CTX_INITIAL_DIRECTION: {
            if (system._suppressInitialDirectionCapture) {
                const zero: Vec3 = { x: 0, y: 0, z: 0 };
                return () => zero;
            }
            const x = column(buffer, "initialDir.x", Float32Array);
            const y = column(buffer, "initialDir.y", Float32Array);
            const z = column(buffer, "initialDir.z", Float32Array);
            const previous = system.createEmitPower;
            system.createEmitPower = (i) => {
                if (!system._suppressInitialDirectionCapture) {
                    x[i] = buffer.dirX[i]!;
                    y[i] = buffer.dirY[i]!;
                    z[i] = buffer.dirZ[i]!;
                }
                previous?.(i);
            };
            const scratch: Vec3 = { x: 0, y: 0, z: 0 };
            return (i) => {
                scratch.x = x[i]!;
                scratch.y = y[i]!;
                scratch.z = z[i]!;
                return scratch;
            };
        }
        default:
            throw new Error(`NodeParticle: unsupported contextual source 0x${source.toString(16)}`);
    }
}
