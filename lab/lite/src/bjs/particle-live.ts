import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { NodeParticleSystemSet } from "@babylonjs/core/Particles/Node/nodeParticleSystemSet";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Particles/Node/Blocks";
import "@babylonjs/core/Shaders/particles.fragment";
import "@babylonjs/core/Shaders/particles.vertex";

interface PreviewConfig {
    readonly source: unknown;
    readonly radius: number;
    readonly target: Vector3;
    readonly textureUrl: string;
    readonly invertTextureY: boolean;
}

async function loadPreview(sceneId: number): Promise<PreviewConfig> {
    switch (sceneId) {
        case 262:
            return {
                source: (await import("../shared/scene262-npe.js")).SCENE262_NPE_JSON,
                radius: 4,
                target: new Vector3(0, 0.3, 0),
                textureUrl: "https://playground.babylonjs.com/textures/flare.png",
                invertTextureY: true,
            };
        case 263:
            return {
                source: (await import("../shared/scene263-npe.js")).SCENE263_NPE_JSON,
                radius: 14,
                target: Vector3.Zero(),
                textureUrl: "https://playground.babylonjs.com/textures/flare.png",
                invertTextureY: true,
            };
        case 264:
            return {
                source: (await import("../shared/scene264-npe.js")).SCENE264_NPE_JSON,
                radius: 12,
                target: new Vector3(0, 0.7, 0),
                textureUrl: "https://playground.babylonjs.com/textures/flare.png",
                invertTextureY: true,
            };
        case 268:
            return {
                source: (await import("../shared/scene268-npe.js")).SCENE268_NPE_JSON,
                radius: 4,
                target: new Vector3(-1, 0, 0),
                textureUrl: "https://playground.babylonjs.com/textures/player.png",
                invertTextureY: false,
            };
        default:
            throw new Error(`Unknown particle preview scene ${sceneId}`);
    }
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const sceneId = Number(new URLSearchParams(window.location.search).get("scene") ?? "262");
    const preview = await loadPreview(sceneId);
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new ArcRotateCamera("cam", -Math.PI / 2, 1.2, preview.radius, preview.target, scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    camera.attachControl(canvas, true);

    const set = NodeParticleSystemSet.Parse(preview.source);
    const built = await set.buildAsync(scene);
    const system = built.systems[0] as ParticleSystem;
    system.particleTexture = new Texture(preview.textureUrl, scene, false, preview.invertTextureY);

    let seed = 1;
    Math.random = () => {
        const x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    };
    system.start();

    const engineWithDrawCalls = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame?: () => void } };
    scene.onBeforeRenderObservable.add(() => {
        engineWithDrawCalls._drawCalls?.fetchNewFrame?.();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(engineWithDrawCalls._drawCalls?.current ?? 0);
        canvas.dataset.particles = String(system.getActiveCount());
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));

    document.title = `Babylon.js - Live NPE Particles ${sceneId}`;
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.live = "true";
    canvas.dataset.scene = String(sceneId);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err instanceof Error ? err.message : err);
    }
});
