// Scene 126 — Gaussian Splatting material plugin (Lite).
// Loads Halo_Believe.splat and injects a GsShaderFragment that overrides
// the final color at GS_FRAGMENT_MAIN_END (Lite equivalent of BJS's
// MaterialPluginBase CUSTOM_FRAGMENT_MAIN_END hook).

import { attachControl, createArcRotateCamera, createEngine, createSceneContext, loadSplat, registerScene, startEngine } from "babylon-lite";
import type { GsShaderFragment } from "babylon-lite";

const SPLAT_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/Halo_Believe.splat";

const gsPlugin: GsShaderFragment = {
    id: "someGsPlugin",
    fragmentSlots: {
        GS_FRAGMENT_MAIN_END: "finalColor = vec4<f32>(1.0, 0.0, 0.0, 0.05);",
    },
};

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(4.57, 1.29, 6, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const splat = await loadSplat(scene, SPLAT_URL, [gsPlugin]);

    await registerScene(engine, scene);
    await startEngine(engine);

    await splat.firstSortReady;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
