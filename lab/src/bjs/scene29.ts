// Reference scene 29 — Babylon.js SpriteManager rendering of the same
// 25×10 sprite grid as the Lite scene, under an orthographic FreeCamera.
//
// This is the canonical Babylon.js way to render a pure-2D sprite grid:
// one SpriteManager backed by an atlas, one Sprite per cell, per-sprite
// `cellIndex` selecting the atlas frame, per-sprite `color` and `angle`.
// Used as the apples-to-apples reference for bundle-size and perf metrics.

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
    scene.clearColor = new Color4(0.07, 0.08, 0.12, 1);

    // Y-up ortho (top>bottom): a Y-down ortho would invert the projection's Y
    // axis, which flips sprite UVs vertically within each sprite quad. We use a
    // standard Y-up projection and flip sprite Y positions instead.
    const camera = new FreeCamera("ortho", new Vector3(0, 0, -10), scene);
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = 0;
    camera.orthoRight = canvas.width;
    camera.orthoTop = canvas.height;
    camera.orthoBottom = 0;
    camera.minZ = 0.1;
    camera.maxZ = 100;

    // epsilon=0: BJS defaults to 0.01, which insets each corner by 1% of the
    // sprite size (used for UV alignment, but also shrinks the geometry quad).
    // Lite does NOT inset, so matching parity requires disabling epsilon here.
    const mgr = new SpriteManager("grid", getSpriteAtlasDataUrl(), 256, { width: SPRITE_ATLAS_INFO.cellWidthPx, height: SPRITE_ATLAS_INFO.cellHeightPx }, scene, 0);

    const cols = 25;
    const rows = 10;
    const cellPx = 40;
    const gridW = cols * cellPx;
    const gridH = rows * cellPx;
    const ox = (canvas.width - gridW) / 2 + cellPx / 2;
    const oy = (canvas.height - gridH) / 2 + cellPx / 2;
    const sizePx = 28;

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            const frame = 8 + (idx % 16);
            const tintIdx = idx % 3;
            const sprite = new Sprite(`s${idx}`, mgr);
            sprite.position.x = ox + c * cellPx;
            sprite.position.y = canvas.height - (oy + r * cellPx);
            sprite.size = sizePx;
            sprite.cellIndex = frame;
            // Negate angle: a Y-up projection (we flipped Y to keep UVs upright)
            // also flips rotation direction (CW becomes CCW). Lite uses canvas
            // convention where positive angle is CW, so negate here to match.
            sprite.angle = idx % 5 === 0 ? -Math.PI / 6 : 0;
            if (tintIdx === 1) {
                sprite.color = new Color4(1, 0.7, 0.7, 1);
            } else if (tintIdx === 2) {
                sprite.color = new Color4(0.7, 1, 0.85, 1);
            }
        }
    }

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
