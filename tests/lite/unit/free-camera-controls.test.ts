import { describe, expect, it } from "vitest";

import { attachFreeControl } from "../../../packages/babylon-lite/src/camera/free-camera-controls";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

function createCanvasFixture() {
    const listeners = new Map<string, EventListener>();
    const canvas = {
        addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
        removeEventListener: (type: string, listener: EventListener) => {
            if (listeners.get(type) === listener) {
                listeners.delete(type);
            }
        },
        hasAttribute: () => true,
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
    } as unknown as HTMLCanvasElement;
    const emitKey = (type: "keydown" | "keyup", code: string): void => {
        listeners.get(type)?.({ code } as KeyboardEvent);
    };
    return { canvas, emitKey, listeners };
}

describe("free camera controls", () => {
    it("applies custom vertical keys and a held-key speed multiplier", () => {
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        camera.speed = 1;
        camera.inertia = 0;
        const scene = { _beforeRender: [] } as unknown as SceneContext;
        const { canvas, emitKey } = createCanvasFixture();
        attachFreeControl(camera, canvas, scene, { upKeys: ["KeyE"], downKeys: ["KeyQ"], fastKeys: ["ShiftLeft"], fastMultiplier: 5 });

        emitKey("keydown", "KeyE");
        emitKey("keydown", "ShiftLeft");
        scene._beforeRender[0]!(100);

        expect(camera.position.y).toBeCloseTo(Math.sqrt(0.1) * 5);
        const boostedHeight = camera.position.y;
        emitKey("keyup", "KeyE");
        emitKey("keyup", "ShiftLeft");
        emitKey("keydown", "Space");
        scene._beforeRender[0]!(100);
        expect(camera.position.y).toBe(boostedHeight);
    });

    it("removes its frame callback and listeners during cleanup", () => {
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        const scene = { _beforeRender: [] } as unknown as SceneContext;
        const { canvas, listeners } = createCanvasFixture();
        const cleanup = attachFreeControl(camera, canvas, scene);

        cleanup();

        expect(scene._beforeRender).toHaveLength(0);
        expect(listeners.size).toBe(0);
    });
});
