import { describe, expect, it } from "vitest";
import { addToScene, createBox as createLiteBox } from "babylon-lite";

import { LiteCompatError, MeshBuilder, NullEngine, Ray, Scene, Vector3 } from "../src/index";

function createPickScene(): { engine: NullEngine; scene: Scene; box: ReturnType<typeof MeshBuilder.CreateBox> } {
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
    return { engine, scene, box };
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

    it("honors default visibility, enabled, and pickable eligibility", () => {
        const { scene, box } = createPickScene();
        const ray = new Ray(new Vector3(0, 0, -5), new Vector3(0, 0, 1));

        expect(box.isPickable).toBe(true);
        box.isPickable = false;
        expect(scene.pickWithRay(ray).hit).toBe(false);
        box.isPickable = true;
        box.isVisible = false;
        expect(scene.pickWithRay(ray).hit).toBe(false);
        box.isVisible = true;
        box.setEnabled(false);
        expect(scene.pickWithRay(ray).hit).toBe(false);
    });

    it("canonically wraps native Lite meshes for predicates and results", () => {
        const { engine, scene } = createPickScene();
        const native = createLiteBox(engine._lite, 2);
        native.name = "native";
        native.position.x = 5;
        addToScene(scene._lite, native);
        const ray = new Ray(new Vector3(5, 0, -5), new Vector3(0, 0, 1));
        let predicateMesh: unknown;

        const hit = scene.pickWithRay(ray, (mesh) => {
            predicateMesh = mesh;
            return mesh.name === "native";
        });

        expect(hit.hit).toBe(true);
        expect(hit.pickedMesh).not.toBeNull();
        expect(hit.pickedMesh).toBe(predicateMesh);
        expect(scene.meshes).toContain(hit.pickedMesh);
    });

    it("throws for unavailable UV and thin-instance picking", () => {
        const { scene, box } = createPickScene();
        const ray = new Ray(new Vector3(0, 0, -5), new Vector3(0, 0, 1));

        expect(() => scene.pickWithRay(ray).getTextureCoordinates()).toThrow(LiteCompatError);
        box.thinInstanceSetBuffer("matrix", new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 16);
        expect(() => scene.pickWithRay(ray)).toThrow(LiteCompatError);
    });
});
