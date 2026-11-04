import { describe, expect, it } from "vitest";
import { createParticleBuffer, column, spawnParticle, killParticle } from "../../../packages/babylon-lite/src/particle/particle-buffer";
import { useSpriteSheet } from "../../../packages/babylon-lite/src/particle/sprite-columns";

describe("Particle buffer", () => {
    it("allocates built-in state and no optional columns", () => {
        const buffer = createParticleBuffer(16);
        expect(buffer._columns.size).toBe(0);
        expect(buffer._all.length).toBe(21);
        expect(buffer.size).toBeInstanceOf(Float32Array);
        expect(buffer.colorStepA).toBeInstanceOf(Float32Array);
    });

    it("column() allocates once and shares by name", () => {
        const buffer = createParticleBuffer(16);
        const a = column(buffer, "sprite.cellIndex", Uint16Array);
        const b = column(buffer, "sprite.cellIndex", Uint16Array);
        expect(a).toBe(b);
        expect(a.length).toBe(16);
        expect(buffer._columns.size).toBe(1);
        expect(buffer._all.length).toBe(22);
    });

    it("spawn/kill keep a compact live range via swap-remove", () => {
        const buffer = createParticleBuffer(4);
        const i0 = spawnParticle(buffer);
        const i1 = spawnParticle(buffer);
        const i2 = spawnParticle(buffer);
        buffer.posX[i0] = 10;
        buffer.posX[i1] = 11;
        buffer.posX[i2] = 12;
        buffer.size[i0] = 20;
        buffer.size[i1] = 21;
        buffer.size[i2] = 22;
        expect(buffer.alive).toBe(3);

        // Kill the first: the last live particle (12) is swapped into slot 0.
        killParticle(buffer, i0);
        expect(buffer.alive).toBe(2);
        expect(buffer.posX[0]).toBe(12);
        expect(buffer.posX[1]).toBe(11);
        expect(buffer.size[0]).toBe(22);
        expect(buffer.size[1]).toBe(21);

        // Full buffer returns -1 rather than allocating.
        spawnParticle(buffer);
        spawnParticle(buffer);
        expect(spawnParticle(buffer)).toBe(-1);
        expect(buffer.alive).toBe(4);
    });

    it("sprite feature lives in columns and advances cellIndex over life", () => {
        const buffer = createParticleBuffer(4);
        const sheet = useSpriteSheet(buffer, { startCellID: 0, endCellID: 3, loop: true, changeSpeed: 1 });
        // Static sheet configuration stays in the closure; only the per-particle render cell is a column.
        expect(buffer._columns.size).toBe(1);

        const i = spawnParticle(buffer);
        buffer.lifeTime[i] = 1;
        sheet.birth(i);
        expect(sheet.cellIndex[i]).toBe(0);

        // dist = 3 - 0 + 1 = 4; ratio = age/life; cell = (start + ratio*dist) | 0.
        buffer.age[i] = 0.5;
        sheet.update(i);
        expect(sheet.cellIndex[i]).toBe(2); // 0.5 * 4 = 2

        buffer.age[i] = 0.99;
        sheet.update(i);
        expect(sheet.cellIndex[i]).toBe(3); // 3.96 | 0 = 3
    });
});
