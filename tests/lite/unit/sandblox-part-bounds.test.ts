import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { getThinInstanceWorldBounds } from "../../../packages/babylon-lite/src/shadow/thin-instance-shadow-bounds";
import { allocInstance, createPartRenderer, freeInstance, writeInstance } from "../../../lab/lite/src/demos/sandblox/part-renderer";

vi.mock("../../../lab/lite/src/demos/sandblox/stud-texture", () => ({
    createStudTextures: async () => ({ baseColor: {}, normalMap: {} }),
}));

describe("Sandblox prototype bounds", () => {
    it.each(["caster", "receiver", "wedge"] as const)("preserves %s geometry bounds through instance edits and swap-removal", async (pool) => {
        const engine = {
            _device: {
                createBuffer: ({ size }: GPUBufferDescriptor) => ({
                    getMappedRange: () => new ArrayBuffer(size),
                    unmap: vi.fn(),
                    destroy: vi.fn(),
                }),
            },
        } as unknown as EngineContext;
        const renderer = await createPartRenderer(engine, {} as SceneContext);
        const mesh = pool === "caster" ? renderer.mesh : pool === "receiver" ? renderer.receiverMesh : renderer.wedgeMesh;
        const min = mesh.boundMin!;
        const max = mesh.boundMax!;
        const originalMin = [...min];
        const originalMax = [...max];
        const options = { receiverOnly: pool === "receiver", shape: pool === "wedge" ? ("wedge" as const) : ("block" as const) };
        const first = allocInstance(renderer, options);
        const second = allocInstance(renderer, options);
        const rotation = { x: 0, y: 0, z: 0, w: 1 };
        const firstPosition = { x: 200, y: 0, z: 0 };
        const secondPosition = { x: 210, y: 0, z: 0 };
        const firstScale = [0.01, 2, 4] as const;
        const secondScale = [1, 1, 1] as const;
        writeInstance(renderer, first, firstPosition, rotation, firstScale);
        writeInstance(renderer, second, secondPosition, rotation, secondScale);

        expect(mesh.boundMin).toBe(min);
        expect(mesh.boundMax).toBe(max);
        expect(mesh.boundMin).toEqual(originalMin);
        expect(mesh.boundMax).toEqual(originalMax);
        expect(getThinInstanceWorldBounds(mesh)!.min[0]).toBeCloseTo(
            Math.min(firstPosition.x + originalMin[0]! * firstScale[0], secondPosition.x + originalMin[0]! * secondScale[0])
        );
        expect(getThinInstanceWorldBounds(mesh)!.max[0]).toBeCloseTo(
            Math.max(firstPosition.x + originalMax[0]! * firstScale[0], secondPosition.x + originalMax[0]! * secondScale[0])
        );

        freeInstance(renderer, first);
        const movedPosition = { x: 100, y: 0, z: 0 };
        writeInstance(renderer, second, movedPosition, rotation, secondScale);
        expect(getThinInstanceWorldBounds(mesh)!.min[0]).toBeCloseTo(movedPosition.x + originalMin[0]! * secondScale[0]);
        expect(getThinInstanceWorldBounds(mesh)!.max[0]).toBeCloseTo(movedPosition.x + originalMax[0]! * secondScale[0]);
        freeInstance(renderer, second);
        expect(getThinInstanceWorldBounds(mesh)).toBeNull();
        expect(mesh.boundMin).toBe(min);
        expect(mesh.boundMax).toBe(max);
        expect(mesh.boundMin).toEqual(originalMin);
        expect(mesh.boundMax).toEqual(originalMax);
    });
});
