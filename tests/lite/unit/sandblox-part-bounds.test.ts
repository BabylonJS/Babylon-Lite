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
        const min = mesh.boundMin;
        const max = mesh.boundMax;
        const options = { receiverOnly: pool === "receiver", shape: pool === "wedge" ? ("wedge" as const) : ("block" as const) };
        const first = allocInstance(renderer, options);
        const second = allocInstance(renderer, options);
        const rotation = { x: 0, y: 0, z: 0, w: 1 };
        writeInstance(renderer, first, { x: 200, y: 0, z: 0 }, rotation, [0.01, 2, 4]);
        writeInstance(renderer, second, { x: 210, y: 0, z: 0 }, rotation, [1, 1, 1]);

        expect(mesh.boundMin).toBe(min);
        expect(mesh.boundMax).toBe(max);
        expect(mesh.boundMin).toEqual([-0.5, -0.5, -0.5]);
        expect(mesh.boundMax).toEqual([0.5, 0.5, 0.5]);
        expect(getThinInstanceWorldBounds(mesh)!.min[0]).toBeCloseTo(199.995);
        expect(getThinInstanceWorldBounds(mesh)!.max[0]).toBeCloseTo(210.5);

        freeInstance(renderer, first);
        writeInstance(renderer, second, { x: 100, y: 0, z: 0 }, rotation, [1, 1, 1]);
        expect(getThinInstanceWorldBounds(mesh)!.min[0]).toBeCloseTo(99.5);
        expect(getThinInstanceWorldBounds(mesh)!.max[0]).toBeCloseTo(100.5);
        freeInstance(renderer, second);
        expect(getThinInstanceWorldBounds(mesh)).toBeNull();
        expect(mesh.boundMin).toBe(min);
        expect(mesh.boundMax).toBe(max);
    });
});
