import { describe, expect, it } from "vitest";

import { attachTrogirCameraMode, createTrogirFirstPersonCamera, createTrogirOrbitCamera, type TrogirCameraModeBindings } from "../../../lab/lite/src/demos/trogir-camera-mode";
import { formatTrogirCameraPose, readTrogirCameraPose } from "../../../lab/lite/src/demos/trogir-camera-pose";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import type { ArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import type { FreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

describe("Trogir camera modes", () => {
    it("reports stable world-space poses for known, orbit, and first-person cameras", () => {
        const roll = Math.PI / 6;
        const known = new Float32Array([Math.cos(roll), Math.sin(roll), 0, 0, -Math.sin(roll), Math.cos(roll), 0, 0, 0, 0, 1, 0, -0, 2, -3, 1]);
        const pose = readTrogirCameraPose(known);
        expect([pose.x, pose.y, pose.z, pose.yaw, pose.pitch]).toEqual([-0, 2, -3, 0, 0]);
        expect(pose.roll).toBeCloseTo(30, 5);
        expect(formatTrogirCameraPose(known)).toEqual({ x: "0.00", y: "2.00", z: "-3.00", yaw: "0.00", pitch: "0.00", roll: "30.00" });

        const orbit = createArcRotateCamera(-0.75, 1.1, 25, { x: 3, y: -4, z: 5 });
        const firstPerson = createTrogirFirstPersonCamera(orbit);
        const orbitPose = readTrogirCameraPose(orbit.worldMatrix);
        const firstPersonPose = readTrogirCameraPose(firstPerson.worldMatrix);
        for (const key of ["x", "y", "z", "yaw", "pitch", "roll"] as const) {
            expect(firstPersonPose[key]).toBeCloseTo(orbitPose[key], 5);
            expect(Number.isFinite(firstPersonPose[key])).toBe(true);
        }

        firstPerson.target.set(firstPerson.position.x + 1e-9, firstPerson.position.y + 1, firstPerson.position.z - 1e-9);
        const pole = readTrogirCameraPose(firstPerson.worldMatrix);
        expect(Object.values(pole).every(Number.isFinite)).toBe(true);
        expect(pole.pitch).toBeCloseTo(90, 5);

        expect(() => readTrogirCameraPose(new Float32Array(16))).toThrowError(RangeError);
        const nonfinite = new Float32Array(known);
        nonfinite[12] = Number.NaN;
        expect(() => formatTrogirCameraPose(nonfinite)).toThrowError(RangeError);
    });

    it("preserves eye, look direction, and projection through a moved first-person round trip", () => {
        const orbit = createArcRotateCamera(-1.1, 1.22, 37, { x: -3, y: 8, z: 12 });
        orbit.fov = 0.93;
        orbit.nearPlane = 0.125;
        orbit.farPlane = 2345;
        const firstPerson = createTrogirFirstPersonCamera(orbit);
        const initialOrbit = Array.from(orbit.worldMatrix);
        const initialFirstPerson = Array.from(firstPerson.worldMatrix);
        for (const index of [8, 9, 10, 12, 13, 14]) {
            expect(initialFirstPerson[index]).toBeCloseTo(initialOrbit[index]!, 5);
        }
        expect([firstPerson.fov, firstPerson.nearPlane, firstPerson.farPlane]).toEqual([0.93, 0.125, 2345]);

        firstPerson.position.set(firstPerson.position.x + 4, firstPerson.position.y - 2, firstPerson.position.z + 7);
        firstPerson.target.set(firstPerson.position.x - 0.3, firstPerson.position.y + 0.4, firstPerson.position.z + 0.5);
        firstPerson.fov = 0.71;
        firstPerson.nearPlane = 0.2;
        firstPerson.farPlane = 900;
        const before = Array.from(firstPerson.worldMatrix);
        const restored = createTrogirOrbitCamera(firstPerson, orbit.radius);
        const after = Array.from(restored.worldMatrix);
        for (const index of [8, 9, 10, 12, 13, 14]) {
            expect(after[index]).toBeCloseTo(before[index]!, 5);
        }
        expect([restored.fov, restored.nearPlane, restored.farPlane]).toEqual([0.71, 0.2, 900]);

        firstPerson.target.set(firstPerson.position.x + 0.001, firstPerson.position.y + 1, firstPerson.position.z + 0.001);
        const nearPoleBefore = Array.from(firstPerson.worldMatrix);
        const nearPoleOrbit = createTrogirOrbitCamera(firstPerson, orbit.radius);
        const nearPoleAfter = Array.from(nearPoleOrbit.worldMatrix);
        for (const index of [8, 9, 10, 12, 13, 14]) {
            expect(nearPoleAfter[index]).toBeCloseTo(nearPoleBefore[index]!, 5);
        }
        expect(Math.min(nearPoleOrbit.beta, Math.PI - nearPoleOrbit.beta)).toBeLessThan(0.08);
    });

    it("keeps exactly one controls attachment and removes the button listener on disposal", () => {
        const orbit = createArcRotateCamera(-Math.PI / 2, 1.16, 260, { x: -3.25, y: 12, z: -81.5 });
        const scene = { camera: orbit } as unknown as SceneContext;
        const canvas = { dataset: {} } as HTMLCanvasElement;
        const button = new EventTarget() as unknown as HTMLButtonElement;
        Object.defineProperty(button, "dataset", { value: {} });
        button.setAttribute = () => undefined;
        const hint = { textContent: "" } as HTMLElement;
        let activeAttachments = 0;
        let totalAttachments = 0;
        const attach = (): (() => void) => {
            activeAttachments++;
            totalAttachments++;
            let detached = false;
            return () => {
                if (!detached) {
                    detached = true;
                    activeAttachments--;
                }
            };
        };
        const bindings: TrogirCameraModeBindings = {
            attachOrbit: attach,
            attachFirstPerson: attach,
        };

        const detachCameraMode = attachTrogirCameraMode(scene, canvas, button, hint, orbit, bindings);
        expect([button.dataset.cameraMode, activeAttachments, totalAttachments]).toEqual(["orbit", 1, 1]);
        button.dispatchEvent(new Event("click"));
        expect([button.dataset.cameraMode, activeAttachments, totalAttachments]).toEqual(["firstPerson", 1, 2]);
        expect(canvas.dataset.cameraMode).toBe("firstPerson");
        const firstPerson = scene.camera as FreeCamera;
        const firstPersonPosition = firstPerson.worldMatrix;
        firstPerson.target.set(firstPerson.position.x + 0.001, firstPerson.position.y + 1, firstPerson.position.z + 0.001);
        button.dispatchEvent(new Event("click"));
        expect([button.dataset.cameraMode, activeAttachments, totalAttachments]).toEqual(["orbit", 1, 3]);
        expect(scene.camera!.worldMatrix[12]).toBeCloseTo(firstPersonPosition[12]!, 5);
        const restoredBeta = (scene.camera as ArcRotateCamera).beta;
        expect(Math.min(restoredBeta, Math.PI - restoredBeta)).toBeLessThan(0.08);

        detachCameraMode();
        expect(activeAttachments).toBe(0);
        button.dispatchEvent(new Event("click"));
        expect([button.dataset.cameraMode, activeAttachments, totalAttachments]).toEqual(["orbit", 0, 3]);
    });
});
