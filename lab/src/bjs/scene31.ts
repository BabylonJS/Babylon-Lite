// Reference scene 31 — Babylon.js SpriteManager with deterministic clip
// playback frozen at `?seekTime=`.
//
// Each sprite's `cellIndex` is set explicitly each frame from
// (frame counter * fixedDeltaMs + phase) so the freeze point matches Lite's
// fixed-tick advancement exactly (16.667 ms/frame, seekTime * 60 frames).

import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
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

    const seekParam = new URLSearchParams(location.search).get("seekTime");
    const seekTime = seekParam !== null ? parseFloat(seekParam) : null;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.04, 0.04, 1);

    // Use standard Y-up orthographic projection: a Y-down ortho (top<bottom)
    // inverts the projection matrix's Y axis, which flips sprite UVs vertically
    // within each sprite quad. Keep the projection standard and flip sprite Y
    // coordinates instead so positions still match Lite's pixel-space layout.
    const camera = new FreeCamera("ortho", new Vector3(0, 0, -10), scene);
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = 0;
    camera.orthoRight = canvas.width;
    camera.orthoTop = canvas.height;
    camera.orthoBottom = 0;
    camera.minZ = 0.1;
    camera.maxZ = 100;

    // Pass samplingMode in the constructor: calling `updateSamplingMode` after
    // construction re-uploads the texture without `invertY=true`, which breaks
    // BJS's sprite shader UV convention and produces a vertical mirror inside
    // each cell. Setting it on the constructor preserves the correct upload.
    // epsilon=0: BJS defaults to 0.01 which insets each corner by 1% of the
    // sprite size; Lite renders the full quad, so we disable the inset here.
    const mgr = new SpriteManager(
        "spin",
        getSpriteAtlasDataUrl(),
        16,
        { width: SPRITE_ATLAS_INFO.cellWidthPx, height: SPRITE_ATLAS_INFO.cellHeightPx },
        scene,
        0,
        Texture.NEAREST_NEAREST
    );

    const cols = 4;
    const rows = 3;
    const spacing = 140;
    const ox = (canvas.width - (cols - 1) * spacing) / 2;
    const oy = (canvas.height - (rows - 1) * spacing) / 2;
    const fps = SPRITE_ATLAS_INFO.spinnerClip.fps;
    const frameCount = SPRITE_ATLAS_INFO.spinnerClip.frames.length;
    const msPerFrame = 1000 / fps;

    const sprites: Sprite[] = [];
    const phases: number[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            const s = new Sprite(`s${idx}`, mgr);
            s.position.x = ox + c * spacing;
            // Flip Y: Lite places sprites in pixel-space (y down), but we now use
            // a standard Y-up ortho projection.
            s.position.y = canvas.height - (oy + r * spacing);
            s.size = 96;
            s.cellIndex = idx % frameCount;
            sprites.push(s);
            phases.push((idx % frameCount) * msPerFrame);
        }
    }

    function setCellsForElapsed(elapsedMs: number): void {
        for (let i = 0; i < sprites.length; i++) {
            const t = phases[i]! + elapsedMs;
            sprites[i]!.cellIndex = Math.floor(t / msPerFrame) % frameCount;
        }
    }

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };

    if (seekTime !== null) {
        // Lite advances by exactly 16.667 ms per rAF tick; first frame's delta is 0.
        let frameCounter = 0;
        const targetFrames = Math.round(seekTime * 60);
        scene.onBeforeRenderObservable.add(() => {
            eng._drawCalls?.fetchNewFrame();
            const advances = Math.min(frameCounter, targetFrames);
            setCellsForElapsed(advances * 16.667);
            frameCounter++;
            if (frameCounter === targetFrames + 1) {
                canvas.dataset.animationFrozen = "true";
            }
        });
    } else {
        const startT = performance.now();
        scene.onBeforeRenderObservable.add(() => {
            eng._drawCalls?.fetchNewFrame();
            setCellsForElapsed(performance.now() - startT);
        });
    }
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
