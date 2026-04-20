// Scene 33 — Sprites Animated (Family 1: animated 2D clip).
//
// 4×3 = 12 spinner sprites all playing the same 8-frame "spin" clip at 12 fps.
// Each sprite is offset in time so the grid shows every frame of the loop
// simultaneously. Honours `?seekTime=` for deterministic golden capture
// (per GUIDANCE.md §2c).

import {
    addSprite2DIndex,
    addToScene2D,
    createEngine,
    createScene2DContext,
    createSprite2DLayer,
    loadSpriteAtlas,
    onBeforeRender2D,
    playSprite2DClipIndex,
    startEngine2D,
    stopSprite2DClipIndex,
} from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const seekParam = new URLSearchParams(location.search).get("seekTime");
    const seekTime = seekParam !== null ? parseFloat(seekParam) : null;

    const scene = createScene2DContext(engine, { clearColor: { r: 0.04, g: 0.04, b: 0.04, a: 1 } });
    if (seekTime !== null) {
        scene.fixedDeltaMs = 16.667;
    }

    const clips = [SPRITE_ATLAS_INFO.spinnerClip];
    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        cellWidthPx: SPRITE_ATLAS_INFO.cellWidthPx,
        cellHeightPx: SPRITE_ATLAS_INFO.cellHeightPx,
        columns: SPRITE_ATLAS_INFO.columns,
        rows: SPRITE_ATLAS_INFO.rows,
        sampling: "nearest",
        clips,
    });

    const layer = createSprite2DLayer(atlas, { capacity: 16 });
    const cols = 4;
    const rows = 3;
    const spacing = 140;
    const ox = (canvas.width - (cols - 1) * spacing) / 2;
    const oy = (canvas.height - (rows - 1) * spacing) / 2;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            const i = addSprite2DIndex(layer, {
                positionPx: [ox + c * spacing, oy + r * spacing],
                sizePx: [96, 96],
                frame: idx % 8,
            });
            playSprite2DClipIndex(layer, i, "spin", true);
            // Offset each sprite's clip phase so we see all 8 frames at once.
            const state = layer._clips.get(i)!;
            state.elapsedMs = (idx % 8) * (1000 / SPRITE_ATLAS_INFO.spinnerClip.fps);
        }
    }
    addToScene2D(scene, layer);

    if (seekTime !== null) {
        // Freeze at the requested time: count rAF frames; once we have advanced
        // clips by `seekTime * 60` full ticks, stop every clip so subsequent
        // frames don't advance them.  The first frame's delta is 0 (per render-loop
        // contract), so we need (target + 1) total frames to land on `target`
        // advances of `fixedDeltaMs`.
        let elapsedFrames = 0;
        const targetFrames = Math.round(seekTime * 60);
        onBeforeRender2D(scene, (_dt) => {
            elapsedFrames++;
            if (elapsedFrames === targetFrames + 1) {
                for (let i = 0; i < layer.count; i++) {
                    stopSprite2DClipIndex(layer, i);
                }
                canvas.dataset.animationFrozen = "true";
            }
        });
    }

    await startEngine2D(engine, scene);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
