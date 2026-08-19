// Scene 301: exact NPE Multiply and MultiplyAdd rendered through pure Sprite2D.

import {
    animateParticleSystem,
    buildNodeParticleSet,
    createEngine,
    createSceneContext,
    createSpriteRenderer,
    createTexture2DFromPixels,
    parseNodeParticleSource,
    registerNodeParticleSet2DWithBlendModes,
    registerSpriteRenderer,
    startEngine,
    startParticleSystem,
} from "babylon-lite";
import { buildScene283TexturePixels, createScene283NpeJson, SCENE283_CLEAR_COLOR, SCENE283_TEXTURE_SIZE } from "../shared/scene283-npe-multiply-blend.js";

const SPRITE_SIZE_PX = 256;
const LAYER_OPACITY = 0.75;
const PARTICLE_TINT = [0.3, 0.8, 0.45, 1] as const;

function seedOneParticle(system: Awaited<ReturnType<typeof buildNodeParticleSet>>["systems"][number], x: number, y: number): void {
    system.emitRate = 60;
    system.updateSpeed = 1 / 60;
    startParticleSystem(system);
    animateParticleSystem(system, 1);
    if (system.buffer.alive !== 1) {
        throw new Error(`Scene 301 expected one live particle, got ${system.buffer.alive}`);
    }
    system.updateSpeed = 0;
    system.buffer.posX[0] = x;
    system.buffer.posY[0] = y;
    system.buffer.size[0] = SPRITE_SIZE_PX;
    system.buffer.scaleX[0] = 1;
    system.buffer.scaleY[0] = 1;
    system.buffer.angle[0] = 0;
    system.buffer.colorR[0] = PARTICLE_TINT[0];
    system.buffer.colorG[0] = PARTICLE_TINT[1];
    system.buffer.colorB[0] = PARTICLE_TINT[2];
    system.buffer.colorA[0] = PARTICLE_TINT[3];
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const buildScene = createSceneContext(engine);
    const multiplySet = await buildNodeParticleSet(engine, buildScene, parseNodeParticleSource(createScene283NpeJson({ blendMode: 3 })));
    const multiplyAddSet = await buildNodeParticleSet(engine, buildScene, parseNodeParticleSource(createScene283NpeJson({ blendMode: 4 })));
    const multiply = multiplySet.systems[0];
    const multiplyAdd = multiplyAddSet.systems[0];
    if (!multiply || !multiplyAdd) {
        throw new Error("Scene 301 requires two NPE particle systems");
    }

    const texture = createTexture2DFromPixels(engine, buildScene283TexturePixels(), SCENE283_TEXTURE_SIZE, SCENE283_TEXTURE_SIZE, {
        minFilter: "nearest",
        magFilter: "nearest",
    });
    multiply.texture = texture;
    multiplyAdd.texture = texture;

    const multiplyX = Math.round(canvas.width * 0.3);
    const multiplyAddX = Math.round(canvas.width * 0.7);
    const centerY = Math.round(canvas.height * 0.5);
    const originalRandom = Math.random;
    let seed = 1;
    Math.random = () => {
        const value = Math.sin(seed++) * 10000;
        return value - Math.floor(value);
    };
    try {
        seedOneParticle(multiply, multiplyX, centerY);
        seedOneParticle(multiplyAdd, multiplyAddX, centerY);
    } finally {
        Math.random = originalRandom;
    }

    multiplySet.systems.push(multiplyAdd);
    const renderer = createSpriteRenderer(engine, {
        layers: [],
        clearValue: { r: SCENE283_CLEAR_COLOR[0], g: SCENE283_CLEAR_COLOR[1], b: SCENE283_CLEAR_COLOR[2], a: SCENE283_CLEAR_COLOR[3] },
    });
    const binding = registerNodeParticleSet2DWithBlendModes(renderer, multiplySet, {
        autoStart: false,
        invertY: false,
        layer: { opacity: LAYER_OPACITY, order: 10 },
    });
    registerSpriteRenderer(renderer);

    await startEngine(engine);
    const multiplyBridge = binding.bridges[0]!;
    const multiplyAddBridge = binding.bridges[1]!;
    canvas.dataset.bindingActive = String(binding.active);
    canvas.dataset.multiplyLayers = String(multiplyBridge.layers.length);
    canvas.dataset.multiplyAddLayers = String(multiplyAddBridge.layers.length);
    canvas.dataset.passOrder = multiplyAddBridge.layers.map((layer) => layer.blendMode._key).join(",");
    canvas.dataset.rendererLayers = String(renderer.layers.length);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.multiplyX = String(multiplyX);
    canvas.dataset.multiplyAddX = String(multiplyAddX);
    canvas.dataset.centerY = String(centerY);
    canvas.dataset.spriteSize = String(SPRITE_SIZE_PX);
    canvas.dataset.animationFrozen = "true";
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
