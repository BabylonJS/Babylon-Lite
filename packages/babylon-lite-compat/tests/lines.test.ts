import { describe, expect, it, vi } from "vitest";

import { NullEngine } from "../src/engine/engine";
import { Color3, Color4 } from "../src/math/color";
import { Vector3 } from "../src/math/vector";
import { CreateLineSystem, LinesMesh, MeshBuilder } from "../src/meshes/meshes";
import { Scene } from "../src/scene/scene";

function createScene(): { engine: NullEngine; scene: Scene; writeBuffer: ReturnType<typeof vi.fn> } {
    const engine = new NullEngine();
    const writeBuffer = vi.fn();
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
        queue: { writeBuffer },
    } as unknown as GPUDevice;
    return { engine, scene: new Scene(engine), writeBuffer };
}

describe("LinesMesh compatibility", () => {
    it("creates independent line-list geometry with Babylon color and alpha properties", () => {
        const { scene } = createScene();
        const mesh = MeshBuilder.CreateLineSystem(
            "lines",
            {
                lines: [
                    [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(1, 1, 0)],
                    [new Vector3(3, 0, 0), new Vector3(3, 1, 0)],
                ],
                useVertexAlpha: false,
            },
            scene
        );

        expect(mesh).toBeInstanceOf(LinesMesh);
        expect(Array.from(mesh._lite._cpuIndices!)).toEqual([0, 1, 1, 2, 3, 4]);
        const materialBefore = mesh._lite.material as unknown as { _uniformVersion: number };
        const uniformVersion = materialBefore._uniformVersion;
        mesh.color = new Color3(0.2, 0.4, 0.8);
        expect(materialBefore._uniformVersion).toBe(uniformVersion + 1);
        mesh.alpha = 0.6;
        const material = mesh._lite.material as unknown as { color: { r: number; g: number; b: number; a: number } };
        expect(material.color).toEqual({ r: 0.2, g: 0.4, b: 0.8, a: 0.6 });
    });

    it("updates an existing line system and enables the thin-instance color shader", () => {
        const { scene, writeBuffer } = createScene();
        const colors = [[new Color4(1, 0, 0, 1), new Color4(0, 1, 0, 0.5)]];
        const mesh = CreateLineSystem(
            "lines",
            {
                lines: [[new Vector3(0, 0, 0), new Vector3(1, 0, 0)]],
                colors,
                updatable: true,
            },
            scene
        );

        const updated = CreateLineSystem(
            "lines",
            {
                lines: [[new Vector3(-1, 0, 0), new Vector3(2, 1, 0)]],
                colors,
                instance: mesh,
            },
            scene
        );
        expect(updated).toBe(mesh);
        expect(writeBuffer).toHaveBeenCalled();
        expect(Array.from(mesh._lite._cpuPositions!)).toEqual([-1, 0, 0, 2, 1, 0]);

        mesh.thinInstanceSetBuffer("matrix", new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 16);
        mesh.thinInstanceSetBuffer("color", new Float32Array([0.5, 0.75, 1, 0.8]), 4);
        const material = mesh._lite.material as unknown as { useThinInstances: boolean; useThinInstanceColors: boolean; _topology: string };
        expect(material).toMatchObject({ useThinInstances: true, useThinInstanceColors: true, _topology: "line-list" });
    });
});
