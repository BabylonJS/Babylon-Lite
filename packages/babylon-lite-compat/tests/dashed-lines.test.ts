import { describe, expect, it, vi } from "vitest";

import { NullEngine } from "../src/engine/engine";
import { Vector3 } from "../src/math/vector";
import { CreateDashedLines, LinesMesh, MeshBuilder } from "../src/meshes/meshes";
import { Scene } from "../src/scene/scene";

function createScene(): { engine: NullEngine; scene: Scene } {
    const engine = new NullEngine();
    (engine._lite as unknown as { _device: GPUDevice })._device = {
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
    } as unknown as GPUDevice;
    return { engine, scene: new Scene(engine) };
}

describe("MeshBuilder.CreateDashedLines compatibility", () => {
    it("builds an indexed line-list of dash segments with BJS dash spacing", () => {
        const { scene } = createScene();
        const mesh = MeshBuilder.CreateDashedLines("dashes", { points: [new Vector3(0, 0, 0), new Vector3(10, 0, 0)], dashSize: 3, gapSize: 1, dashNb: 10 }, scene);

        expect(mesh).toBeInstanceOf(LinesMesh);
        // length 10, shft = 10/10 = 1, nb = 10 dashes → 20 vertices, 20 line-list indices.
        const positions = Array.from(mesh._lite._cpuPositions!);
        expect(positions.length).toBe(20 * 3);
        // dashshft = 3*1/(3+1) = 0.75; dash 0 spans x∈[0, 0.75], dash 1 spans x∈[1, 1.75].
        expect(positions.slice(0, 6)).toEqual([0, 0, 0, 0.75, 0, 0]);
        expect(positions.slice(6, 12)).toEqual([1, 0, 0, 1.75, 0, 0]);
        expect(Array.from(mesh._lite._cpuIndices!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
        expect((mesh._lite as unknown as { _topology: number })._topology).toBe(2);
    });

    it("applies BJS defaults (dashSize 3, gapSize 1, dashNb 200) when omitted", () => {
        const { scene } = createScene();
        const mesh = MeshBuilder.CreateDashedLines("dashes", { points: [new Vector3(0, 0, 0), new Vector3(10, 0, 0)] }, scene);
        // shft = 10/200 = 0.05, nb = floor(10/0.05) = 200 dashes → 400 vertices.
        expect(mesh._lite._cpuPositions!.length).toBe(200 * 2 * 3);
    });

    it("spans dashes across multiple polyline segments", () => {
        const { scene } = createScene();
        const mesh = MeshBuilder.CreateDashedLines("dashes", { points: [new Vector3(0, 0, 0), new Vector3(4, 0, 0), new Vector3(4, 4, 0)], dashNb: 8 }, scene);
        // total length 8, shft = 1; each 4-unit segment yields 4 dashes → 8 dashes → 16 vertices.
        expect(mesh._lite._cpuPositions!.length).toBe(16 * 3);
    });

    it("supports the standalone CreateDashedLines export", () => {
        const { scene } = createScene();
        const mesh = CreateDashedLines("dashes", { points: [new Vector3(0, 0, 0), new Vector3(5, 0, 0)], dashNb: 5 }, scene);
        expect(mesh).toBeInstanceOf(LinesMesh);
    });

    it("throws for in-place instance updates (fixed-topology Lite limitation)", () => {
        const { scene } = createScene();
        const mesh = MeshBuilder.CreateDashedLines("dashes", { points: [new Vector3(0, 0, 0), new Vector3(5, 0, 0)], dashNb: 5 }, scene);
        expect(() => MeshBuilder.CreateDashedLines("dashes", { points: [new Vector3(0, 0, 0), new Vector3(6, 0, 0)], instance: mesh }, scene)).toThrow();
    });
});
