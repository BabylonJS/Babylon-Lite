import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createDashedLines, updateDashedLines } from "../../../packages/babylon-lite/src/mesh/create-dashed-lines";

function point(x: number, y: number, z: number) {
    return { x, y, z };
}

function createEngine(): EngineContext {
    return {
        _device: {
            createBuffer: ({ size }: GPUBufferDescriptor) => {
                const mapped = new ArrayBuffer(Number(size));
                return {
                    size: Number(size),
                    getMappedRange: () => mapped,
                    unmap: () => undefined,
                    destroy: () => undefined,
                } as unknown as GPUBuffer;
            },
            queue: { writeBuffer: vi.fn() },
        } as unknown as GPUDevice,
    } as EngineContext;
}

describe("createDashedLines", () => {
    it("creates BJS-spaced dash segments and retains their update ratio", () => {
        const mesh = createDashedLines(createEngine(), {
            points: [point(0, 0, 0), point(10, 0, 0)],
            dashSize: 3,
            gapSize: 1,
            dashNb: 5,
        });

        expect(Array.from(mesh._cpuPositions!.slice(0, 12))).toEqual([0, 0, 0, 1.5, 0, 0, 2, 0, 0, 3.5, 0, 0]);
        expect(mesh._linePointCounts).toEqual(new Uint32Array([2, 2, 2, 2, 2]));
        expect(mesh._dashedLineOptions).toEqual([3, 1]);
    });

    it("updates positions without changing the dash count", () => {
        const engine = createEngine();
        const mesh = createDashedLines(engine, {
            points: [point(0, 0, 0), point(10, 0, 0)],
            dashNb: 5,
        });

        updateDashedLines(engine, mesh, { points: [point(0, 0, 0), point(20, 0, 0)] });

        expect(mesh._cpuPositions).toHaveLength(5 * 2 * 3);
        expect(Array.from(mesh._cpuPositions!.slice(0, 12))).toEqual([0, 0, 0, 3, 0, 0, 4, 0, 0, 7, 0, 0]);
    });

    it("rejects meshes that were not created as dashed lines", () => {
        expect(() => updateDashedLines(createEngine(), {} as never, { points: [point(0, 0, 0), point(1, 0, 0)] })).toThrow("requires a mesh created by createDashedLines");
    });
});
