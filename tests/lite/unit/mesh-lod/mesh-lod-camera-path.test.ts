import { describe, expect, it } from "vitest";
import { createMeshLoDCameraPath, sampleMeshLoDCameraPath, MESH_LOD_PATH_DURATION_S, type MeshLoDPathBounds } from "../../../../lab/lite/src/demos/mesh-lod-camera-path.js";

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

describe("createMeshLoDCameraPath controller", () => {
    it("does not drive the camera until enabled", () => {
        const path = createMeshLoDCameraPath(BOUNDS);
        expect(path.enabled).toBe(false);
        expect(path.advance()).toBeNull();
    });

    it("advances a fixed 60 Hz clock while enabled and running", () => {
        const path = createMeshLoDCameraPath(BOUNDS);
        path.setEnabled(true);
        const first = path.advance();
        expect(first).not.toBeNull();
        expect(path.timeSeconds).toBeCloseTo(1 / 60, 10);
        path.advance();
        expect(path.timeSeconds).toBeCloseTo(2 / 60, 10);
    });

    it("pauses on interaction and resumes at t = 0 on reset", () => {
        const path = createMeshLoDCameraPath(BOUNDS);
        path.setEnabled(true);
        path.advance();
        path.notifyInteraction();
        expect(path.paused).toBe(true);
        expect(path.advance()).toBeNull();
        path.reset();
        expect(path.paused).toBe(false);
        expect(path.timeSeconds).toBe(0);
        expect(path.advance()).not.toBeNull();
    });

    it("freezes at a fixed time for deterministic capture", () => {
        const path = createMeshLoDCameraPath(BOUNDS);
        path.freezeAt(7);
        expect(path.enabled).toBe(true);
        expect(path.paused).toBe(true);
        expect(path.timeSeconds).toBe(7);
        expect(path.advance()).toBeNull();
        expect(path.currentPose()).toEqual(sampleMeshLoDCameraPath(BOUNDS, 7));
    });
});
