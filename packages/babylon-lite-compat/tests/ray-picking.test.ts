import { describe, expect, it } from "vitest";
import { addToScene } from "babylon-lite";

import { LiteCompatError, MeshBuilder, NullEngine, Ray, Scene, Vector3 } from "../src/index";

function createPickScene(): { scene: Scene; box: ReturnType<typeof MeshBuilder.CreateBox> } {
    const engine = new NullEngine();
    (engine._lite as unknown as { _device: GPUDevice })._device = {
        createBuffer: ({ size }: GPUBufferDescriptor) => {
            const mapped = new ArrayBuffer(Number(size));
            return {
                getMappedRange: () => mapped,
                unmap: () => undefined,
                destroy: () => undefined,
            } as unknown as GPUBuffer;
        },
    } as unknown as GPUDevice;
    const scene = new Scene(engine);
    const box = MeshBuilder.CreateBox("box", { size: 2 }, scene);
    addToScene(scene._lite, box._lite);
    return { scene, box };
}

describe("Scene.pickWithRay", () => {
    it("maps Lite CPU hits back to Babylon.js mesh and vector wrappers", () => {
        const { scene, box } = createPickScene();
        const ray = new Ray(new Vector3(0, 0, -5), new Vector3(0, 0, 1));

        const hit = scene.pickWithRay(ray);

        expect(hit.hit).toBe(true);
        expect(hit.pickedMesh).toBe(box);
        expect(hit.distance).toBe(4);
        expect(hit.pickedPoint?.asArray()).toEqual([0, 0, -1]);
        expect(hit.getNormal()?.asArray()).toEqual([0, 0, -1]);
        expect(hit.getNormal(true)?.asArray()).toEqual([0, 0, -1]);
        expect(hit.ray).toBe(ray);
    });

    it("forwards predicates and rejects unsupported picking modes", () => {
        const { scene } = createPickScene();
        const ray = new Ray(new Vector3(0, 0, -5), new Vector3(0, 0, 1));

        expect(scene.pickWithRay(ray, () => false).hit).toBe(false);
        expect(() => scene.pickWithRay(ray, undefined, true)).toThrow(LiteCompatError);
        expect(() => scene.pickWithRay(ray, undefined, false, () => true)).toThrow(LiteCompatError);
    });
});
