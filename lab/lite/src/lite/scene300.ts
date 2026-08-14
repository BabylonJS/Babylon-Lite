// Scene 300: an authored NPE graph rendered through the pure-2D SpriteRenderer bridge.

import {
    animateParticleSystem,
    buildNodeParticleSet,
    createEngine,
    createSceneContext,
    createSpriteRenderer,
    parseNodeParticleSource,
    registerNodeParticleSet2D,
    registerSpriteRenderer,
    startEngine,
    startParticleSystem,
} from "babylon-lite";
import { createNpeSprite2DGraph, createNpeSprite2DOrientationAtlasUrl } from "../shared/npe-sprite2d-fixture.js";

const STEPS = 200;
const PIXELS_PER_UNIT = 220;
const ORIENTATION_CENTER_PX: readonly [number, number] = [96, 96];
const ORIENTATION_SIZE_PX = 64;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    // The SceneContext exists only to resolve NPE build-time inputs. Rendering is pure Sprite2D.
    const buildScene = createSceneContext(engine);
    const flareUrl = await createNpeSprite2DOrientationAtlasUrl();
    let set;
    try {
        set = await buildNodeParticleSet(engine, buildScene, parseNodeParticleSource(createNpeSprite2DGraph(flareUrl)));
    } finally {
        URL.revokeObjectURL(flareUrl);
    }
    const system = set.systems[0];
    if (!system) {
        throw new Error("Scene 300 requires one NPE particle system");
    }

    const originalRandom = Math.random;
    let seed = 1;
    Math.random = () => {
        const value = Math.sin(seed++) * 10000;
        return value - Math.floor(value);
    };
    try {
        startParticleSystem(system);
        for (let i = 0; i < STEPS; i++) {
            animateParticleSystem(system, 1);
        }
    } finally {
        Math.random = originalRandom;
    }

    // Keep the automatic bridge hook active while freezing simulation at the seeded frame.
    system.updateSpeed = 0;
    const buffer = system.buffer;
    if (buffer.alive === 0) {
        throw new Error("Scene 300 requires a live particle for its orientation marker");
    }
    const originPx: [number, number] = [canvas.width * 0.5, canvas.height * 0.72];
    buffer.posX[0] = (ORIENTATION_CENTER_PX[0] - originPx[0]) / PIXELS_PER_UNIT;
    buffer.posY[0] = (originPx[1] - ORIENTATION_CENTER_PX[1]) / PIXELS_PER_UNIT;
    buffer.size[0] = ORIENTATION_SIZE_PX / PIXELS_PER_UNIT;
    buffer.scaleX[0] = 1;
    buffer.scaleY[0] = 1;
    buffer.angle[0] = 0;
    buffer.colorR[0] = 1;
    buffer.colorG[0] = 1;
    buffer.colorB[0] = 1;
    buffer.colorA[0] = 1;
    const cellIndex = new Uint16Array(buffer.capacity);
    cellIndex[0] = 1;
    system._spriteSheet = { cellWidth: ORIENTATION_SIZE_PX, cellHeight: ORIENTATION_SIZE_PX, cellIndex, update: () => undefined };
    const renderer = createSpriteRenderer(engine, {
        layers: [],
        clearValue: { r: 0.015, g: 0.007, b: 0.035, a: 1 },
    });
    const binding = registerNodeParticleSet2D(renderer, set, {
        autoStart: false,
        pixelsPerUnit: PIXELS_PER_UNIT,
        originPx,
    });
    const bridge = binding.bridges[0]!;
    let liveSamples = 0;
    renderer._beforeUpdate.push(() => {
        liveSamples++;
        canvas.dataset.liveSamples = String(liveSamples);
        canvas.dataset.systemAlive = String(system.buffer.alive);
        canvas.dataset.layerCount = String(bridge.layer.count);
        canvas.dataset.particleAge = String(system.buffer.age[0] ?? 0);
    });
    registerSpriteRenderer(renderer);

    await startEngine(engine);
    if (liveSamples === 0) {
        throw new Error("Scene 300 renderer did not publish live particle state");
    }

    canvas.dataset.bridge = bridge.layer === renderer.layers[0] ? "particle-sprite-2d" : "invalid";
    canvas.dataset.bindingActive = String(binding.active);
    canvas.dataset.rendererLayers = String(renderer.layers.length);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.animationFrozen = "true";
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error instanceof Error ? error.message : error);
    }
});
