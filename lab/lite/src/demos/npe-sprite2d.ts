/**
 * Demo - an authored NPE graph rendered by the pure-2D SpriteRenderer.
 *
 * A SceneContext is used only while the NPE graph resolves its build-time inputs.
 * It is never registered or rendered. The live ParticleSystem is mapped into a
 * Sprite2DLayer by createParticleSprite2DBridge, and SpriteRenderer is the only
 * registered rendering context.
 */
import {
    buildNodeParticleSet,
    createEngine,
    createSceneContext,
    createSpriteRenderer,
    parseNodeParticleSource,
    registerNodeParticleSet2D,
    registerSpriteRenderer,
    startEngine,
} from "babylon-lite";
import { createNpeSprite2DFlareUrl, createNpeSprite2DGraph } from "../shared/npe-sprite2d-fixture.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    // Build context only. Rendering below is exclusively SpriteRenderer.
    const buildScene = createSceneContext(engine);
    const flareUrl = await createNpeSprite2DFlareUrl();
    let set;
    try {
        set = await buildNodeParticleSet(engine, buildScene, parseNodeParticleSource(createNpeSprite2DGraph(flareUrl)));
    } finally {
        URL.revokeObjectURL(flareUrl);
    }
    const renderer = createSpriteRenderer(engine, {
        layers: [],
        clearValue: { r: 0.015, g: 0.007, b: 0.035, a: 1 },
    });
    const binding = registerNodeParticleSet2D(renderer, set, {
        pixelsPerUnit: 190,
        layer: { order: 1 },
    });
    const bridge = binding.bridges[0]!;
    registerSpriteRenderer(renderer);

    let targetX = canvas.width * 0.5;
    let targetY = canvas.height * 0.72;
    let originX = targetX;
    let originY = targetY;
    const moveTarget = (clientX: number, clientY: number): void => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / Math.max(1, rect.width);
        const scaleY = canvas.height / Math.max(1, rect.height);
        targetX = (clientX - rect.left) * scaleX;
        targetY = (clientY - rect.top) * scaleY;
    };
    canvas.addEventListener("pointermove", (event) => moveTarget(event.clientX, event.clientY));
    canvas.addEventListener(
        "touchmove",
        (event) => {
            const touch = event.touches[0];
            if (touch) {
                moveTarget(touch.clientX, touch.clientY);
            }
        },
        { passive: true }
    );

    await startEngine(engine);

    const tick = (): void => {
        originX += (targetX - originX) * 0.08;
        originY += (targetY - originY) * 0.08;
        bridge.originPx[0] = originX;
        bridge.originPx[1] = originY;
        canvas.dataset.particles = String(bridge.system.buffer.alive);
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error instanceof Error ? error.message : error);
    }
});
