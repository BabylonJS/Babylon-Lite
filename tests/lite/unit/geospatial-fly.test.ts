import { describe, expect, it } from "vitest";

import { flyGeospatialCameraToAsync } from "../../../packages/babylon-lite/src/camera/geospatial-camera-fly";
import { createGeospatialCamera, setGeospatialOrientation } from "../../../packages/babylon-lite/src/camera/geospatial-camera";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

function makeScene(): SceneContext {
    return { _beforeRender: [] } as unknown as SceneContext;
}

function tick(scene: SceneContext, dt: number): void {
    for (const cb of [...(scene as unknown as { _beforeRender: Array<(d: number) => void> })._beforeRender]) {
        cb(dt);
    }
}

describe("flyGeospatialCameraToAsync", () => {
    it("lands exactly on the target even when the easing curve has ease(1) !== 1", async () => {
        const camera = createGeospatialCamera({ planetRadius: 100 });
        setGeospatialOrientation(camera, { radius: 150 });
        const scene = makeScene();
        const targetRadius = 180;

        // A degenerate easing curve that never returns 1. Without the endpoint guard the
        // final frame would resolve at lerp(150, 180, 0.5) = 165 instead of the target.
        const promise = flyGeospatialCameraToAsync(camera, scene, {
            radius: targetRadius,
            durationMs: 100,
            ease: () => 0.5,
        });

        // A single tick whose delta exceeds the duration drives g to 1 and finishes the flight.
        tick(scene, 1000);
        await promise;

        expect(camera.radius).toBeCloseTo(targetRadius, 6);
    });

    it("uses the easing curve for intermediate frames", async () => {
        const camera = createGeospatialCamera({ planetRadius: 100 });
        setGeospatialOrientation(camera, { radius: 100 });
        const scene = makeScene();

        // Linear easing: halfway through the duration the radius is halfway to the target.
        const promise = flyGeospatialCameraToAsync(camera, scene, {
            radius: 200,
            durationMs: 100,
            ease: (g) => g,
        });

        tick(scene, 50); // g = 0.5 → radius = 150
        expect(camera.radius).toBeCloseTo(150, 6);

        tick(scene, 1000); // finish
        await promise;
        expect(camera.radius).toBeCloseTo(200, 6);
    });
});
