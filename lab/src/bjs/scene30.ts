// Reference scene 30 — Babylon.js HUD using four ordered SpriteManagers.
//
// Each Lite Sprite2DLayer maps to one BJS SpriteManager with a distinct
// `renderingGroupId` so layer order matches the Lite `order` field.
// Per-sprite size, color, and angle are set directly. This is the canonical
// BJS way to compose a sprite-based HUD.

import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);

    // Y-up ortho (top>bottom): a Y-down ortho would invert the projection's Y
    // axis, which flips sprite UVs vertically within each sprite quad.
    const camera = new FreeCamera("ortho", new Vector3(0, 0, -10), scene);
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = 0;
    camera.orthoRight = canvas.width;
    camera.orthoTop = canvas.height;
    camera.orthoBottom = 0;
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const url = getSpriteAtlasDataUrl();
    const cell = { width: SPRITE_ATLAS_INFO.cellWidthPx, height: SPRITE_ATLAS_INFO.cellHeightPx };

    // Layer 1 — backdrop (alpha 0.35).
    // epsilon=0 on every manager: BJS defaults to 0.01 (1% inset of the quad
    // for UV alignment), which Lite does not do and which produces a 1-2px
    // mismatch border in the diff map.
    const back = new SpriteManager("back", url, 32, cell, scene, 0);
    back.renderingGroupId = 0;
    for (let i = 0; i < 16; i++) {
        const s = new Sprite(`b${i}`, back);
        s.position.x = 80 + i * 76;
        s.position.y = canvas.height - 360;
        s.size = 64;
        s.cellIndex = 8 + i;
        s.color = new Color4(1, 1, 1, 0.35);
    }

    // Layer 2 — score digits.
    const score = new SpriteManager("score", url, 8, cell, scene, 0);
    score.renderingGroupId = 1;
    const digits = [3, 1, 4, 1, 5];
    for (let i = 0; i < digits.length; i++) {
        const s = new Sprite(`d${i}`, score);
        s.position.x = 60 + i * 50;
        s.position.y = canvas.height - 60;
        s.size = 40;
        s.cellIndex = 24 + digits[i]!;
    }

    // Layer 3 — health bar (10 segments, tinted).
    const health = new SpriteManager("health", url, 16, cell, scene, 0);
    health.renderingGroupId = 2;
    for (let i = 0; i < 10; i++) {
        const healthy = i < 7;
        const s = new Sprite(`h${i}`, health);
        s.position.x = 60 + i * 28;
        s.position.y = 60;
        s.size = 24;
        s.cellIndex = 8;
        s.color = healthy ? new Color4(0.2, 1.0, 0.4, 1.0) : new Color4(0.5, 0.5, 0.5, 0.6);
    }

    // Layer 4 — central rotated action icon.
    const action = new SpriteManager("action", url, 4, cell, scene, 0);
    action.renderingGroupId = 3;
    const a = new Sprite("a", action);
    a.position.x = canvas.width / 2;
    a.position.y = 100;
    a.size = 96;
    a.cellIndex = 12;
    // Negate angle: Y-up projection flips rotation direction (CW becomes CCW).
    a.angle = -Math.PI / 12;
    a.color = new Color4(1, 0.95, 0.7, 1);

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
