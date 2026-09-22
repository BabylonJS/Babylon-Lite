import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    createDirectionalLight,
    createEngine,
    createHavokWorld,
    createHemisphericLight,
    createPcfDirectionalShadowGenerator,
    createSceneContext,
    disposeEngine,
    disposeScene,
    enableHavokThinInstanceAdvancedPhysics,
    enableHavokThinInstancePhysics,
    loadEnvironment,
    loadSkybox,
    registerSceneWithShadowSupport,
    setPhysicsTimestepMs,
    setShadowTaskCasterMeshes,
    startEngine,
} from "babylon-lite";
import { startPlayroomAudioLoad } from "./playroom/audio.js";
import { loadPlayroomAssets } from "./playroom/assets.js";
import { createPlayroomCameras } from "./playroom/camera.js";
import { createPlayroomEffects } from "./playroom/effects.js";
import { createPlayroomGame, disposePlayroomGame } from "./playroom/game.js";
import { installPlayroomStartupUi, markPlayroomReady } from "./playroom/ui.js";
import { buildPlayroomWorld } from "./playroom/world.js";
import { demoAssetUrl } from "./demo-asset-url.js";
import { installFetchProgress } from "./loading-progress.js";

function asset(relative: string): string {
    return demoAssetUrl(`./playroom/${relative}`, import.meta.url);
}

async function main(): Promise<void> {
    const startedAt = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const startupUi = installPlayroomStartupUi(canvas);
    const progress = installFetchProgress(canvas, { estimatedBytes: 26_800_000 });
    let disposeGame: (() => void) | null = null;
    let engine: Awaited<ReturnType<typeof createEngine>> | null = null;
    let scene: ReturnType<typeof createSceneContext> | null = null;
    try {
        engine = await createEngine(canvas);
        scene = createSceneContext(engine);
        scene.fixedDeltaMs = 1000 / 60;
        scene.clearColor = { r: 0.18, g: 0.18, b: 0.2, a: 1 };
        const cameras = createPlayroomCameras(scene, canvas);

        const sun = createDirectionalLight([0, -2, -2], 0.85);
        sun.position.set(0, 12, 0);
        const ambient = createHemisphericLight([0, 1, 0.5], 0.1);
        addToScene(scene, sun);
        addToScene(scene, ambient);
        const shadow = createPcfDirectionalShadowGenerator(engine, sun, {
            mapSize: 2048,
            bias: 0.0001,
            orthoMinZ: -6,
            orthoMaxZ: 30,
            forceRefreshEveryFrame: true,
        });
        sun.shadowGenerator = shadow;

        await loadEnvironment(scene, asset("env/childRoom_ibl.env"), {
            skipSkybox: true,
            skipGround: true,
            brdfUrl: demoAssetUrl("./brdf-lut.png", import.meta.url),
        });
        scene.imageProcessing.toneMappingEnabled = false;
        scene.imageProcessing.exposure = 1;
        scene.imageProcessing.contrast = 1;
        await loadSkybox(scene, asset("env/skybox/childRoom_1K"), ".jpg", 70);

        const assets = await loadPlayroomAssets(engine, import.meta.url, [shadow]);
        const hknp = await HavokPhysics({ locateFile: () => demoAssetUrl("./HavokPhysics.wasm", import.meta.url) });
        const physics = createHavokWorld(scene, hknp, { x: 0, y: -9.81, z: 0 });
        setPhysicsTimestepMs(physics, 1000 / 60);
        enableHavokThinInstanceAdvancedPhysics(physics);
        await enableHavokThinInstancePhysics(physics);
        const world = buildPlayroomWorld(engine, scene, physics, assets);
        const effects = createPlayroomEffects(engine, scene, assets);
        const audioLoad = startPlayroomAudioLoad((file) => asset(`sounds/${file}`));
        const game = createPlayroomGame({
            canvas,
            engine,
            scene,
            physics,
            assets,
            camera: cameras.orbit,
            freeCamera: cameras.free,
            world,
            audio: audioLoad.state,
            effects,
            shadow,
            setCameraMode: cameras.setMode,
            disposeCameras: cameras.dispose,
        });
        game.cleanup.push(startupUi.dispose);
        disposeGame = () => disposePlayroomGame(game, effects);
        window.addEventListener("pagehide", disposeGame, { once: true });
        setShadowTaskCasterMeshes(
            shadow,
            world.meshes.filter((mesh) => mesh.visible !== false)
        );
        await registerSceneWithShadowSupport(scene);
        await startEngine(engine);
        await audioLoad.ready;
        progress.done();
        if (game.disposed) {
            return;
        }
        canvas.dataset.initMs = String(performance.now() - startedAt);
        canvas.dataset.assetCount = "80";
        markPlayroomReady(game);
        canvas.dataset.ready = "true";
    } catch (error: unknown) {
        progress.done();
        disposeGame?.();
        if (scene) {
            disposeScene(scene);
        }
        if (engine) {
            disposeEngine(engine);
        }
        const message = `Unable to start The Playroom: ${error instanceof Error ? error.message : String(error)}`;
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
        startupUi.showError(message);
        startupUi.dispose();
        console.error(error);
    }
}

void main();
