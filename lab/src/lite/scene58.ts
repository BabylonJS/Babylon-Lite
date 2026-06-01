import {
    addSprite2D,
    attachSpriteAnimationsToRenderer,
    createEngine,
    createSprite2DLayer,
    createSpriteAnimationManager,
    createSpriteRenderer,
    loadSpriteAtlas,
    playSprite2DAnimation,
    registerSpriteRenderer,
    startEngine,
} from "babylon-lite";
import { seekSpriteAnimationManager } from "../_shared/player-lite-sprite";
import { PLAYER_SPRITE_INFO, PLAYER_SPRITE_URL } from "../_shared/player-sprite";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const atlas = await loadSpriteAtlas(engine, PLAYER_SPRITE_URL, {
        gridSize: [PLAYER_SPRITE_INFO.frameWidthPx, PLAYER_SPRITE_INFO.frameHeightPx],
        sampling: "linear",
    });

    const layer = createSprite2DLayer(atlas, { capacity: 4, blendMode: "alpha", depth: "none" });
    const manager = createSpriteAnimationManager();
    const centerX = canvas.width * 0.5;

    const mainRunner = addSprite2D(layer, {
        positionPx: [centerX, 410],
        sizePx: [192, 192],
        frame: 0,
        color: [1, 1, 1, 1],
    });
    const reverseRunner = addSprite2D(layer, {
        positionPx: [centerX - 235, 430],
        sizePx: [128, 128],
        frame: 10,
        flipX: true,
        color: [0.65, 0.85, 1, 0.82],
    });
    const finishRunner = addSprite2D(layer, {
        positionPx: [centerX + 235, 430],
        sizePx: [128, 128],
        frame: 0,
        color: [1, 0.85, 0.7, 0.78],
    });

    playSprite2DAnimation(manager, mainRunner, PLAYER_SPRITE_INFO.runStartFrame, PLAYER_SPRITE_INFO.runEndFrame, true, PLAYER_SPRITE_INFO.delayMs);
    playSprite2DAnimation(manager, reverseRunner, PLAYER_SPRITE_INFO.runEndFrame, PLAYER_SPRITE_INFO.runStartFrame, true, PLAYER_SPRITE_INFO.delayMs);
    playSprite2DAnimation(manager, finishRunner, 0, 6, false, PLAYER_SPRITE_INFO.delayMs, { removeWhenFinished: true });

    const renderer = createSpriteRenderer(engine, {
        layers: [layer],
        clearValue: { r: 0.07, g: 0.09, b: 0.12, a: 1 },
    });
    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        seekSpriteAnimationManager(manager, seekTime);
        canvas.dataset.animationFrozen = "true";
    } else {
        attachSpriteAnimationsToRenderer(renderer, manager);
    }
    registerSpriteRenderer(renderer);

    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    console.error(error);
});
