/**
 * Sprite-sheet feature as particle columns — SPIKE.
 *
 * This is the sprite-sheet animation expressed the data-oriented way: it owns a set of columns on the
 * particle buffer and returns birth/update steps that close over them. A system that never calls
 * {@link useSpriteSheet} allocates none of these columns and never imports this module, so a non-sprite
 * particle system pays nothing for sprite animation — in bundle bytes or in per-particle memory — while
 * the update step remains allocation-free. The cell math mirrors Babylon.js `Particle.updateCellIndex`.
 */
import { column, type ParticleBuffer } from "./particle-buffer.js";

/** Sprite-sheet configuration (mirrors the object system's `SpriteSheetConfig`). */
export interface SpriteSheetConfig {
    startCellID: number;
    endCellID: number;
    loop: boolean;
    randomStartCell: boolean;
    changeSpeed: number;
}

/** Handle returned by {@link useSpriteSheet}: the render column plus the per-particle birth/update steps. */
export interface SpriteSheet {
    /** Render frame per particle (read by the billboard). */
    readonly cellIndex: Uint16Array;
    /** Seed a freshly spawned particle's sprite state (runs at creation). */
    readonly birth: (i: number) => void;
    /** Advance a particle's cell for the current frame (runs in the update loop). */
    readonly update: (i: number) => void;
}

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Attach the sprite-sheet feature to a buffer: allocate its columns (only now, on this buffer) and return
 * birth/update steps closing over them. Columns are keyed `sprite.*`, shared if attached more than once.
 */
export function useSpriteSheet(buffer: ParticleBuffer, config: SpriteSheetConfig): SpriteSheet {
    const initialStart = column(buffer, "sprite.initialStart", Uint16Array);
    const initialEnd = column(buffer, "sprite.initialEnd", Uint16Array);
    const initialLoop = column(buffer, "sprite.initialLoop", Uint8Array);
    const randomOffset = column(buffer, "sprite.randomOffset", Float32Array);
    const cellIndex = column(buffer, "sprite.cellIndex", Uint16Array);
    const age = buffer.age;
    const lifeTime = buffer.lifeTime;

    return {
        cellIndex,
        birth(i: number): void {
            initialStart[i] = config.startCellID;
            initialEnd[i] = config.endCellID;
            initialLoop[i] = config.loop ? 1 : 0;
            randomOffset[i] = -1;
            cellIndex[i] = config.startCellID;
        },
        update(i: number): void {
            const life = lifeTime[i]!;
            let offsetAge = age[i]!;
            let changeSpeed = config.changeSpeed;
            if (config.randomStartCell) {
                if (randomOffset[i]! < 0) {
                    randomOffset[i] = Math.random() * life;
                }
                if (changeSpeed === 0) {
                    // Speed 0 means "stay on the (random) start cell": use the offset as a fixed phase.
                    changeSpeed = 1;
                    offsetAge = randomOffset[i]!;
                } else {
                    offsetAge += randomOffset[i]!;
                }
            }
            const start = initialStart[i]!;
            const dist = initialEnd[i]! - start + 1;
            const t = offsetAge * changeSpeed;
            const ratio = initialLoop[i]! ? clamp01((t % life) / life) : clamp01(t / life);
            cellIndex[i] = (start + ratio * dist) | 0;
        },
    };
}
