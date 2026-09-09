import { describe, expect, it, vi } from "vitest";
import { addToScene, createBox as createLiteBox, pickMeshesWithRay as litePickMeshesWithRay } from "babylon-lite";

import { ArcRotateCamera, LiteCompatError, Matrix, MeshBuilder, NullEngine, Ray, Scene, Vector3, Viewport } from "../src/index";

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

describe("Scene.createPickingRay", () => {
    function createRayScene(): { engine: NullEngine; scene: Scene; camera: ArcRotateCamera } {
        const engine = new NullEngine();
        const canvas = engine.getRenderingCanvas() as { width: number; height: number };
        canvas.width = 800;
        canvas.height = 600;
        const scene = new Scene(engine);
        const camera = new ArcRotateCamera("camera", 0, Math.PI / 2, 10, Vector3.Zero(), scene);
        vi.spyOn(camera, "getViewMatrix").mockReturnValue(Matrix.Identity());
        vi.spyOn(camera, "getProjectionMatrix").mockReturnValue(Matrix.Identity());
        return { engine, scene, camera };
    }

    it("returns Babylon.js's zero ray when no camera is available", () => {
        const scene = new Scene(new NullEngine());

        const ray = scene.createPickingRay(10, 20);

        expect(ray).toBeInstanceOf(Ray);
        expect(ray.origin).toBeInstanceOf(Vector3);
        expect(ray.origin.asArray()).toEqual([0, 0, 0]);
        expect(ray.direction.asArray()).toEqual([0, 0, 0]);
        expect(ray.length).toBe(Number.MAX_VALUE);
    });

    it("applies hardware scaling and the camera viewport before forwarding to Lite", () => {
        const { engine, scene, camera } = createRayScene();
        engine.setHardwareScalingLevel(2);
        camera.viewport = new Viewport(0.25, 0.1, 0.5, 0.5);

        const ray = scene.createPickingRay(300, 300);

        expect(ray).toBeInstanceOf(Ray);
        expect(ray.origin).toBeInstanceOf(Vector3);
        expect(ray.origin.asArray()).toEqual([-1.25, 1.6, 1]);
        expect(ray.direction.asArray()).toEqual([0, 0, -1]);
        expect(ray.length).toBe(Number.MAX_VALUE);
        expect(camera._lite.viewport).toBe(camera.viewport);
    });

    it("uses the camera viewport aspect ratio for projection", () => {
        const { camera } = createRayScene();
        vi.restoreAllMocks();
        const fullWidthScale = camera.getProjectionMatrix().m[0]!;

        camera.viewport = new Viewport(0, 0, 0.5, 1);

        expect(camera.getProjectionMatrix().m[0]).toBeCloseTo(fullWidthScale * 2);
    });

    it("uses the explicit camera, active-camera fallback, and pointer-camera fallback", () => {
        const { scene, camera } = createRayScene();
        const explicit = new ArcRotateCamera("explicit", 0, Math.PI / 2, 10, Vector3.Zero(), scene);
        vi.spyOn(explicit, "getViewMatrix").mockReturnValue(Matrix.Identity());
        vi.spyOn(explicit, "getProjectionMatrix").mockReturnValue(Matrix.Translation(1, 0, 0));

        expect(scene.createPickingRay(400, 300, null, explicit).origin.x).toBe(-1);
        expect(scene.createPickingRay(400, 300).origin.x).toBe(0);

        scene.activeCamera = null;
        scene.cameraToUseForPointers = explicit;
        expect(scene.createPickingRay(400, 300).origin.x).toBe(-1);
        expect(camera).not.toBe(explicit);
    });

    it("composes world and camera transforms and supports camera-view space", () => {
        const { scene, camera } = createRayScene();
        vi.spyOn(camera, "getViewMatrix").mockReturnValue(Matrix.Translation(0, 2, 0));

        const worldRay = scene.createPickingRay(400, 300, Matrix.Translation(1, 0, 0));
        const cameraSpaceRay = scene.createPickingRay(400, 300, Matrix.Translation(1, 0, 0), camera, true);

        expect(worldRay.origin.asArray()).toEqual([-1, -2, 1]);
        expect(cameraSpaceRay.origin.asArray()).toEqual([-1, 0, 1]);
    });

    it("returns Babylon.js's zero ray for a singular transform", () => {
        const { scene, camera } = createRayScene();
        vi.spyOn(camera, "getProjectionMatrix").mockReturnValue(Matrix.Zero());

        expect(scene.createPickingRay(400, 300).direction.asArray()).toEqual([0, 0, 0]);
    });

    it("unprojects through a real Lite camera", () => {
        const { scene, camera } = createRayScene();
        vi.restoreAllMocks();

        const ray = scene.createPickingRay(400, 300);
        const towardTarget = Vector3.Zero().subtract(ray.origin);

        expect(ray.origin.x).toBeGreaterThan(9);
        expect(ray.direction.x).toBeLessThan(-0.9);
        expect(Vector3.Dot(ray.direction, towardTarget)).toBeGreaterThan(0);
        expect(ray.direction.length()).toBeCloseTo(1);
        expect(camera).toBe(scene.activeCamera);
    });

    it("keeps large-world picking rays in absolute space for transformed meshes", () => {
        const { engine, scene, box } = createPickScene();
        const canvas = engine.getRenderingCanvas() as { width: number; height: number };
        canvas.width = 800;
        canvas.height = 600;
        const target = new Vector3(10_000, 0, 0);
        const camera = new ArcRotateCamera("camera", 0, Math.PI / 2, 10, target, scene);

        // This is the camera/engine state established after useLargeWorldRendering
        // enables Lite's floating-origin render path.
        engine._lite.useFloatingOrigin = true;
        camera._lite._useFloatingOrigin = true;
        box.position = target;
        box.rotation.y = Math.PI / 4;

        const ray = scene.createPickingRay(400, 300);
        const cameraSpaceRay = scene.createPickingRay(400, 300, null, camera, true);
        const hit = scene.pickWithRay(ray);

        expect(ray.origin.x).toBeGreaterThan(10_009);
        expect(cameraSpaceRay.origin.x).toBe(0);
        expect(hit.hit).toBe(true);
        expect(hit.pickedMesh).toBe(box);
    });
});

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
        expect(scene.pickWithRay(ray, () => true).pickedMesh).toBe(box);
        box.isPickable = true;
        box.isVisible = false;
        expect(scene.pickWithRay(ray).hit).toBe(false);
        expect(scene.pickWithRay(ray, () => true).pickedMesh).toBe(box);
        box.isVisible = true;
        box.setEnabled(false);
        expect(scene.pickWithRay(ray).hit).toBe(false);
        expect(scene.pickWithRay(ray, () => true).pickedMesh).toBe(box);
    });

    it("preserves native Lite visibility and pickable eligibility", () => {
        const { engine } = createPickScene();
        const native = createLiteBox(engine._lite, 2);
        native.visible = false;
        const ray = {
            origin: [0, 0, -5] as [number, number, number],
            direction: [0, 0, 1] as [number, number, number],
            length: Number.MAX_VALUE,
        };

        expect(litePickMeshesWithRay([native], ray).hit).toBe(true);
        native.pickable = false;
        expect(litePickMeshesWithRay([native], ray, { predicate: () => true }).hit).toBe(false);
        expect(litePickMeshesWithRay([native], ray, { predicate: () => true, skipPickableCheck: true }).pickedMesh).toBe(native);
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
            if (mesh.name === "native") {
                predicateMesh = mesh;
            }
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
