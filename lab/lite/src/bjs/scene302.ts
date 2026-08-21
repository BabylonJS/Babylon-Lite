import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { NodeParticleSystemSet } from "@babylonjs/core/Particles/Node/nodeParticleSystemSet";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Particles/Node/Blocks";
import "@babylonjs/core/Shaders/particles.fragment";
import "@babylonjs/core/Shaders/particles.vertex";
import {
    buildScene302TexturePixels,
    createScene302NpeGraph,
    createScene302SeededRandom,
    getScene302EmitterPose,
    getScene302EmitterPoseForStep,
    getScene302StepCount,
    SCENE302_CAMERA_ALPHA,
    SCENE302_CAMERA_BETA,
    SCENE302_CAMERA_RADIUS,
    SCENE302_CAMERA_TARGET,
    SCENE302_CLEAR_COLOR,
    SCENE302_TEXTURE_SIZE,
    type Scene302EmitterPose,
} from "../shared/scene302-npe-moving-emitter.js";

function readSeekTime(): number | null {
    const value = Number.parseFloat(new URLSearchParams(window.location.search).get("seekTime") ?? "");
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function applyEmitterPose(emitter: AbstractMesh, pose: Scene302EmitterPose): void {
    emitter.position.set(pose.x, pose.y, pose.z);
    emitter.rotation.z = pose.angle;
    emitter.computeWorldMatrix(true);
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const seekTime = readSeekTime();
    const frozen = seekTime !== null;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);
    scene.clearColor = new Color4(...SCENE302_CLEAR_COLOR);
    const camera = new ArcRotateCamera("camera", SCENE302_CAMERA_ALPHA, SCENE302_CAMERA_BETA, SCENE302_CAMERA_RADIUS, new Vector3(...SCENE302_CAMERA_TARGET), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    camera.attachControl(canvas, true);

    const emitter = new Mesh("scene302-emitter", scene);
    emitter.isVisible = false;
    let pose = getScene302EmitterPose(0);
    let providerCalls = 1;
    applyEmitterPose(emitter, pose);

    const set = NodeParticleSystemSet.Parse(createScene302NpeGraph());
    const systemBlock = set.systemBlocks[0];
    if (!systemBlock) {
        throw new Error("Scene 302 requires one NPE system block");
    }
    systemBlock.emitter = emitter;
    const built = await set.buildAsync(scene);
    const system = built.systems[0] as ParticleSystem | undefined;
    if (!system) {
        throw new Error("Scene 302 requires one built particle system");
    }
    system.particleTexture = RawTexture.CreateRGBATexture(
        buildScene302TexturePixels(),
        SCENE302_TEXTURE_SIZE,
        SCENE302_TEXTURE_SIZE,
        scene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE
    );

    const originalRandom = Math.random;
    if (frozen) {
        Math.random = createScene302SeededRandom();
    }
    try {
        system.start();
        if (seekTime !== null) {
            const steps = getScene302StepCount(seekTime);
            for (let step = 1; step <= steps; step++) {
                pose = getScene302EmitterPoseForStep(step);
                applyEmitterPose(emitter, pose);
                providerCalls++;
                system.animate(true);
            }
            system.updateSpeed = 0;
            canvas.dataset.animationFrozen = "true";
        }
    } finally {
        Math.random = originalRandom;
    }

    const motionStart = performance.now();
    const engineWithDrawCalls = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame?: () => void } };
    scene.onBeforeRenderObservable.add(() => {
        engineWithDrawCalls._drawCalls?.fetchNewFrame?.();
        if (!frozen) {
            pose = getScene302EmitterPose((performance.now() - motionStart) / 1000);
            applyEmitterPose(emitter, pose);
            providerCalls++;
        }
        canvas.dataset.emitterX = pose.x.toFixed(3);
        canvas.dataset.emitterY = pose.y.toFixed(3);
        canvas.dataset.emitterZ = pose.z.toFixed(3);
        canvas.dataset.emitterAngle = pose.angle.toFixed(3);
        canvas.dataset.providerCalls = String(providerCalls);
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.particles = String(system.getActiveCount());
        canvas.dataset.drawCalls = String(engineWithDrawCalls._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

void main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
