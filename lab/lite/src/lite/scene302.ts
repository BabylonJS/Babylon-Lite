import {
    animateParticleSystem,
    attachControl,
    buildNodeParticleSet,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    createTexture2DFromPixels,
    mat4Compose,
    parseNodeParticleSource,
    registerNodeParticleSet,
    registerScene,
    startEngine,
    startParticleSystem,
    withNodeParticleEmitterProvider,
} from "babylon-lite";
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
    type Scene302MutableMatrix,
    writeScene302EmitterMatrix,
} from "../shared/scene302-npe-moving-emitter.js";

function readSeekTime(): number | null {
    const value = Number.parseFloat(new URLSearchParams(window.location.search).get("seekTime") ?? "");
    return Number.isFinite(value) && value >= 0 ? value : null;
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const seekTime = readSeekTime();
    const frozen = seekTime !== null;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: SCENE302_CLEAR_COLOR[0], g: SCENE302_CLEAR_COLOR[1], b: SCENE302_CLEAR_COLOR[2], a: SCENE302_CLEAR_COLOR[3] };

    const camera = createArcRotateCamera(SCENE302_CAMERA_ALPHA, SCENE302_CAMERA_BETA, SCENE302_CAMERA_RADIUS, {
        x: SCENE302_CAMERA_TARGET[0],
        y: SCENE302_CAMERA_TARGET[1],
        z: SCENE302_CAMERA_TARGET[2],
    });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const emitterMatrix = mat4Compose(0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
    const mutableEmitterMatrix = emitterMatrix as unknown as Scene302MutableMatrix;
    const motionStart = performance.now();
    let pose: Scene302EmitterPose = getScene302EmitterPose(0);
    let providerCalls = 0;

    const publishTelemetry = (): void => {
        canvas.dataset.emitterX = pose.x.toFixed(3);
        canvas.dataset.emitterY = pose.y.toFixed(3);
        canvas.dataset.emitterZ = pose.z.toFixed(3);
        canvas.dataset.emitterAngle = pose.angle.toFixed(3);
        canvas.dataset.providerCalls = String(providerCalls);
    };
    const provider = () => {
        if (!frozen) {
            pose = getScene302EmitterPose((performance.now() - motionStart) / 1000);
            writeScene302EmitterMatrix(mutableEmitterMatrix, pose);
        }
        providerCalls++;
        publishTelemetry();
        return emitterMatrix;
    };

    writeScene302EmitterMatrix(mutableEmitterMatrix, pose);
    const originalRandom = Math.random;

    let set: Awaited<ReturnType<typeof buildNodeParticleSet>>;
    try {
        set = await buildNodeParticleSet(
            engine,
            scene,
            parseNodeParticleSource(createScene302NpeGraph()),
            withNodeParticleEmitterProvider(provider, { emitter: { x: 0, y: 0, z: 0 } })
        );
        const system = set.systems[0];
        if (!system) {
            throw new Error("Scene 302 requires one NPE particle system");
        }
        system.texture = createTexture2DFromPixels(engine, buildScene302TexturePixels(), SCENE302_TEXTURE_SIZE, SCENE302_TEXTURE_SIZE, {
            minFilter: "nearest",
            magFilter: "nearest",
        });

        if (seekTime !== null) {
            Math.random = createScene302SeededRandom();
            startParticleSystem(system);
            const steps = getScene302StepCount(seekTime);
            for (let step = 1; step <= steps; step++) {
                pose = getScene302EmitterPoseForStep(step);
                writeScene302EmitterMatrix(mutableEmitterMatrix, pose);
                animateParticleSystem(system, 1);
            }
            system.updateSpeed = 0;
            registerNodeParticleSet(scene, set, { autoStart: false });
            canvas.dataset.animationFrozen = "true";
        } else {
            registerNodeParticleSet(scene, set);
        }

        await registerScene(scene);
        await startEngine(engine);

        const updateTelemetry = (): void => {
            publishTelemetry();
            canvas.dataset.particles = String(system.buffer.alive);
            requestAnimationFrame(updateTelemetry);
        };
        updateTelemetry();
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
    } finally {
        Math.random = originalRandom;
    }
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
