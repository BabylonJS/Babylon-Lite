import { column } from "../../particle-buffer.js";
import * as C from "../../particle-columns.js";
import type { Vec2, Color4 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/**
 * `CreateParticleBlock` — creates the {@link ParticleSystem} and fills the fixed creation slots
 * (lifetime/emit-power, size/scale, angle, colour, dead colour + the derived per-step colour ramp) as
 * column writes. Mirrors the object version; the shape block fills position/direction.
 */
export const createParticleBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = state.system!;
        const buffer = system.buffer;

        const lifeTimeGetter = ctx.input(block, "lifeTime", () => 1);
        const emitPowerGetter = ctx.input(block, "emitPower", () => 1);
        const colorGetter = ctx.input(block, "color", () => ({ r: 1, g: 1, b: 1, a: 1 }));
        const colorDeadGetter = ctx.input(block, "colorDead", () => ({ r: 0, g: 0, b: 0, a: 0 }));
        const scaleGetter = ctx.input(block, "scale", () => ({ x: 1, y: 1 }));
        const angleGetter = ctx.input(block, "angle", () => 0);
        const sizeGetter = ctx.input(block, "size", () => 1);

        const lifeTime = buffer.lifeTime;
        const dirX = buffer.dirX;
        const dirY = buffer.dirY;
        const dirZ = buffer.dirZ;
        const size = column(buffer, C.COL_SIZE, Float32Array);
        const scaleX = column(buffer, C.COL_SCALE_X, Float32Array);
        const scaleY = column(buffer, C.COL_SCALE_Y, Float32Array);
        const angle = column(buffer, C.COL_ANGLE, Float32Array);
        const colR = column(buffer, C.COL_COLOR_R, Float32Array);
        const colG = column(buffer, C.COL_COLOR_G, Float32Array);
        const colB = column(buffer, C.COL_COLOR_B, Float32Array);
        const colA = column(buffer, C.COL_COLOR_A, Float32Array);
        const stepR = column(buffer, C.COL_COLOR_STEP_R, Float32Array);
        const stepG = column(buffer, C.COL_COLOR_STEP_G, Float32Array);
        const stepB = column(buffer, C.COL_COLOR_STEP_B, Float32Array);
        const stepA = column(buffer, C.COL_COLOR_STEP_A, Float32Array);

        system.createLifeTime = (i) => {
            lifeTime[i] = lifeTimeGetter(i) as number;
            system._emitPower = emitPowerGetter(i) as number;
        };

        system.createEmitPower = (i) => {
            const p = system._emitPower;
            if (p === 0) {
                dirX[i] = 0;
                dirY[i] = 0;
                dirZ[i] = 0;
            } else {
                dirX[i] = dirX[i]! * p;
                dirY[i] = dirY[i]! * p;
                dirZ[i] = dirZ[i]! * p;
            }
        };

        system.createSize = (i) => {
            const s = sizeGetter(i);
            size[i] = typeof s === "number" ? s : 1;
            const sc = scaleGetter(i);
            if (sc && typeof sc === "object") {
                const v = sc as Vec2;
                scaleX[i] = v.x;
                scaleY[i] = v.y;
            } else {
                scaleX[i] = sc as number;
                scaleY[i] = sc as number;
            }
        };

        system.createAngle = (i) => {
            angle[i] = angleGetter(i) as number;
        };

        system.createColor = (i) => {
            const c = colorGetter(i) as Color4 | null;
            if (c) {
                colR[i] = c.r;
                colG[i] = c.g;
                colB[i] = c.b;
                colA[i] = c.a;
            }
        };

        system.createColorDead = (i) => {
            const cd = colorDeadGetter(i) as Color4;
            system._writeColorDead?.(i, cd);
            const invLife = 1 / lifeTime[i]!;
            stepR[i] = (cd.r - colR[i]!) * invLife;
            stepG[i] = (cd.g - colG[i]!) * invLife;
            stepB[i] = (cd.b - colB[i]!) * invLife;
            stepA[i] = (cd.a - colA[i]!) * invLife;
        };
    },
};
