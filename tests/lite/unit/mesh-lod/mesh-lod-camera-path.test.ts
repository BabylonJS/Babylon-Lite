import { describe, expect, it } from "vitest";
import { sampleMeshLoDCameraPath, MESH_LOD_PATH_DURATION_S, type MeshLoDPathBounds } from "../../../../lab/lite/src/demos/mesh-lod-camera-path.js";

const BOUNDS: MeshLoDPathBounds = { center: { x: 1, y: 2, z: 3 }, radius: 10 };
const DEG = Math.PI / 180;

describe("sampleMeshLoDCameraPath", () => {
    it("evaluates the documented keyframes at t = 0, 5, 10, 15 s", () => {
        const p0 = sampleMeshLoDCameraPath(BOUNDS, 0);
        expect(p0.alpha).toBeCloseTo(-0.8 * Math.PI, 10);
        expect(p0.beta).toBeCloseTo((90 - 25) * DEG, 10);
        expect(p0.radius).toBeCloseTo(2.4 * 10, 10);
        expect(p0.target).toEqual({ x: 1, y: 2, z: 3 });

        // Segment midpoints: smoothstep(0.5) = 0.5, so linear-midpoint values.
        const p5 = sampleMeshLoDCameraPath(BOUNDS, 5);
        expect(p5.alpha).toBeCloseTo(-0.3 * Math.PI, 10);
        expect(p5.beta).toBeCloseTo((90 - 37.5) * DEG, 10);
        expect(p5.radius).toBeCloseTo(1.575 * 10, 10);

        const p10 = sampleMeshLoDCameraPath(BOUNDS, 10);
        expect(p10.alpha).toBeCloseTo(0.2 * Math.PI, 10);
        expect(p10.beta).toBeCloseTo((90 - 50) * DEG, 10);
        expect(p10.radius).toBeCloseTo(0.75 * 10, 10);

        const p15 = sampleMeshLoDCameraPath(BOUNDS, 15);
        expect(p15.alpha).toBeCloseTo(0.7 * Math.PI, 10);
        expect(p15.beta).toBeCloseTo((90 - 37.5) * DEG, 10);
        expect(p15.radius).toBeCloseTo(1.575 * 10, 10);
    });

    it("loops over the 20 s duration and wraps negative time", () => {
        expect(sampleMeshLoDCameraPath(BOUNDS, MESH_LOD_PATH_DURATION_S)).toEqual(sampleMeshLoDCameraPath(BOUNDS, 0));
        expect(sampleMeshLoDCameraPath(BOUNDS, 25)).toEqual(sampleMeshLoDCameraPath(BOUNDS, 5));
        expect(sampleMeshLoDCameraPath(BOUNDS, -5)).toEqual(sampleMeshLoDCameraPath(BOUNDS, 15));
    });

    it("is a pure function — identical inputs produce identical output", () => {
        expect(sampleMeshLoDCameraPath(BOUNDS, 7.3)).toEqual(sampleMeshLoDCameraPath(BOUNDS, 7.3));
    });
});
