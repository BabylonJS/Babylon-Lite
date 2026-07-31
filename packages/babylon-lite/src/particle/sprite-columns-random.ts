import { column, type ParticleBuffer } from "./particle-buffer.js";
import type { SpriteSheet, SpriteSheetConfig } from "./sprite-columns.js";

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Attach the random-start sprite variant. Loaded only when the graph enables random start cells. */
export function useRandomSpriteSheet(buffer: ParticleBuffer, config: SpriteSheetConfig): SpriteSheet {
    const randomOffset = column(buffer, "sprite.randomOffset", Float32Array);
    const cellIndex = column(buffer, "sprite.cellIndex", Uint16Array);
    const age = buffer.age;
    const lifeTime = buffer.lifeTime;
    const start = config.startCellID;
    const distance = config.endCellID - start + 1;

    return {
        cellIndex,
        birth(i: number): void {
            randomOffset[i] = -1;
            cellIndex[i] = start;
        },
        update(i: number): void {
            const life = lifeTime[i]!;
            if (randomOffset[i]! < 0) {
                randomOffset[i] = Math.random() * life;
            }
            let progress: number;
            if (config.changeSpeed === 0) {
                progress = randomOffset[i]!;
            } else {
                progress = (age[i]! + randomOffset[i]!) * config.changeSpeed;
            }
            const ratio = config.loop ? clamp01((progress % life) / life) : clamp01(progress / life);
            cellIndex[i] = (start + ratio * distance) | 0;
        },
    };
}
