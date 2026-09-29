import { describe, expect, it } from "vitest";

import { attachTrogirCameraControls, createTrogirCamera } from "../../../lab/lite/src/demos/trogir-camera";
import { formatTrogirCameraPose, readTrogirCameraPose } from "../../../lab/lite/src/demos/trogir-camera-pose";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

describe("Trogir first-person camera", () => {
    it("starts at the exact HUD pose with the retained projection and one controls attachment", () => {
        const camera = createTrogirCamera();
        expect(formatTrogirCameraPose(camera.worldMatrix)).toEqual({
            x: "-33.03",
            y: "0.24",
            z: "-65.76",
            yaw: "27.70",
            pitch: "6.62",
            roll: "0.00",
        });
        expect([camera.fov, camera.nearPlane, camera.farPlane]).toEqual([0.8, 0.1, 1500]);

        const scene = { camera } as unknown as SceneContext;
        const canvas = {} as HTMLCanvasElement;
        let attachments = 0;
        let detachments = 0;
        const detach = attachTrogirCameraControls(camera, canvas, scene, (attachedCamera, attachedCanvas, attachedScene) => {
            attachments++;
            expect([attachedCamera, attachedCanvas, attachedScene]).toEqual([camera, canvas, scene]);
            return () => {
                detachments++;
            };
        });
        expect(attachments).toBe(1);
        detach();
        detach();
        expect(detachments).toBe(1);
    });

    it("reports stable world-space poses, including a vertical first-person view", () => {
        const roll = Math.PI / 6;
        const known = new Float32Array([Math.cos(roll), Math.sin(roll), 0, 0, -Math.sin(roll), Math.cos(roll), 0, 0, 0, 0, 1, 0, -0, 2, -3, 1]);
        const pose = readTrogirCameraPose(known);
        expect([pose.x, pose.y, pose.z, pose.yaw, pose.pitch]).toEqual([-0, 2, -3, 0, 0]);
        expect(pose.roll).toBeCloseTo(30, 5);
        expect(formatTrogirCameraPose(known)).toEqual({ x: "0.00", y: "2.00", z: "-3.00", yaw: "0.00", pitch: "0.00", roll: "30.00" });

        const camera = createTrogirCamera();
        camera.target.set(camera.position.x + 1e-9, camera.position.y + 1, camera.position.z - 1e-9);
        const pole = readTrogirCameraPose(camera.worldMatrix);
        expect(Object.values(pole).every(Number.isFinite)).toBe(true);
        expect(pole.pitch).toBeCloseTo(90, 5);

        expect(() => readTrogirCameraPose(new Float32Array(16))).toThrowError(RangeError);
        const nonfinite = new Float32Array(known);
        nonfinite[12] = Number.NaN;
        expect(() => formatTrogirCameraPose(nonfinite)).toThrowError(RangeError);
    });
});
