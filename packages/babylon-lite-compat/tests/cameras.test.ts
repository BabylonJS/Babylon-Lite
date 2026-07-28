import { describe, expect, it } from "vitest";

import { NullEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";
import { ArcRotateCamera, FreeCamera, GeospatialCamera } from "../src/cameras/cameras";
import { Vector3 } from "../src/math/vector";
import type { FreeCamera as LiteFreeCamera } from "babylon-lite";

/**
 * Minimal stand-in for a Lite free camera (the shape `parseBabylonCamera` returns
 * when a `.babylon` file carries its own camera). Enough for the GPU-free adopt
 * path: `position`, plus the fields the wrapper proxies.
 */
function fakeLiteCamera(): LiteFreeCamera {
    return {
        position: { x: 1, y: 2, z: 3, set() {} },
        target: { x: 0, y: 0, z: 0, set() {} },
        fov: 0.8,
        nearPlane: 0.1,
        farPlane: 1000,
        speed: 1,
    } as unknown as LiteFreeCamera;
}

describe("Camera adoption (loaded .babylon cameras)", () => {
    it("propagates first-camera auto-activation to the Lite scene", () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const camera = new ArcRotateCamera("camera", 0, 1, 10, Vector3.Zero(), scene);

        expect(scene.activeCamera).toBe(camera);
        expect(scene._lite.camera).toBe(camera._lite);
    });

    it("FreeCamera._adopt wraps an existing Lite camera without creating a new one", () => {
        const lite = fakeLiteCamera();
        const cam = FreeCamera._adopt("Camera01", lite);

        expect(cam).toBeInstanceOf(FreeCamera);
        expect(cam.getClassName()).toBe("FreeCamera");
        // The wrapper adopts the supplied handle rather than building a fresh one.
        expect(cam._lite).toBe(lite);
        // Position is read straight off the adopted Lite camera.
        expect(cam.position.x).toBe(1);
        expect(cam.position.y).toBe(2);
        expect(cam.position.z).toBe(3);
    });

    it("a scene surfaces a loaded Lite camera as scene.activeCamera", () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        expect(scene.activeCamera).toBeNull();

        // Simulate what Lite's addToScene does for a `.babylon` asset: it sets the
        // scene's Lite camera but the compat scene has no wrapper for it yet.
        const lite = fakeLiteCamera();
        scene._lite.camera = lite;
        scene._surfaceLoadedCamera();

        expect(scene.activeCamera).toBeInstanceOf(FreeCamera);
        expect(scene.activeCamera?._lite).toBe(lite);
        expect(scene.cameras).toContain(scene.activeCamera);
    });

    it("does not overwrite an already-active camera", () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);

        const first = FreeCamera._adopt("first", fakeLiteCamera(), scene);
        expect(scene.activeCamera).toBe(first);

        // A subsequent loaded camera must not steal the active slot.
        scene._lite.camera = fakeLiteCamera();
        scene._surfaceLoadedCamera();
        expect(scene.activeCamera).toBe(first);
    });
});

describe("GeospatialCamera", () => {
    it("wraps Lite's geospatial camera and proxies orientation", () => {
        const cam = new GeospatialCamera("geo", undefined, { planetRadius: 100 });
        expect(cam.getClassName()).toBe("GeospatialCamera");

        // radius must be set before pitch (pitch is clamped against the radius-dependent
        // max), mirroring the BJS oracle's property order.
        cam.radius = 170;
        expect(cam.radius).toBeCloseTo(170, 5);

        cam.yaw = 0.6;
        expect(cam.yaw).toBeCloseTo(0.6, 5);

        cam.center = new Vector3(20, 30, 40);
        const c = cam.center;
        expect(c.x).toBeCloseTo(20, 5);
        expect(c.y).toBeCloseTo(30, 5);
        expect(c.z).toBeCloseTo(40, 5);
    });
});
