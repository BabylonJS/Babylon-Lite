import { describe, expect, it } from "vitest";
import { createCameraControlSwitcher, updateFollowCamera } from "../../../lab/lite/src/demos/playroom/camera.js";
import type { PlayroomState } from "../../../lab/lite/src/demos/playroom/types.js";
import type { ArcRotateCamera, FreeCamera, SceneContext } from "../../../packages/babylon-lite/src/index.js";

describe("The Playroom camera input lifetime", () => {
    it("attaches only the active controller and detaches it on every mode change", () => {
        const controls = { orbitAttached: 0, orbitDisposed: 0, freeAttached: 0, freeDisposed: 0 };
        const scene = { camera: null } as unknown as SceneContext;
        const orbit = { kind: "orbit" } as unknown as ArcRotateCamera;
        const free = { kind: "free" } as unknown as FreeCamera;
        const cameras = createCameraControlSwitcher(
            scene,
            {} as HTMLCanvasElement,
            orbit,
            free,
            () => {
                controls.orbitAttached++;
                return () => controls.orbitDisposed++;
            },
            () => {
                controls.freeAttached++;
                return () => controls.freeDisposed++;
            }
        );
        expect(controls.orbitAttached).toBe(0);
        expect(controls.freeAttached).toBe(0);

        cameras.setMode("orbit");
        expect(controls.orbitAttached).toBe(1);
        expect(scene.camera).toBe(orbit);

        cameras.setMode("free");
        expect(controls.orbitDisposed).toBe(1);
        expect(controls.freeAttached).toBe(1);
        expect(scene.camera).toBe(free);

        cameras.setMode("orbit");
        expect(controls.freeDisposed).toBe(1);
        expect(controls.orbitAttached).toBe(2);

        cameras.dispose();
        expect(controls.orbitDisposed).toBe(2);
    });

    it("keeps the aiming camera parent offset centered on the launch root", () => {
        const alpha = -1.25;
        const target = { x: 0, y: 0.3, z: 0 };
        const root = { x: 0.2, y: 1.1, z: -0.4 };
        const state = {
            phase: "aiming",
            camera: { alpha, target },
            ragdoll: { root: { mesh: { position: root } } },
        } as unknown as PlayroomState;

        updateFollowCamera(state);

        expect(target.x).toBeCloseTo(root.x + Math.sin(alpha) * 0.4, 7);
        expect(target.y).toBeCloseTo(root.y + 0.3, 7);
        expect(target.z).toBeCloseTo(root.z - Math.cos(alpha) * 0.4, 7);
    });
});
