import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    goToFrame,
    loadUsd,
    registerScene,
    startEngine,
} from "babylon-lite";
import { createUsdVisualSource, type UsdVisualAsset } from "../shared/usd-visual-stages.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const asset = (new URLSearchParams(location.search).get("asset") ?? "materials") as UsdVisualAsset;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.04, g: 0.05, b: 0.08, a: 1 };
    const target = asset === "materials" ? { x: 0.5, y: 0.5, z: 0 } : { x: 0, y: 1.1, z: 0 };
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.65, asset === "materials" ? 6 : 6.5, target);
    addToScene(scene, createHemisphericLight([0.25, 1, 0.2], 1.1));

    const container = await loadUsd(engine, createUsdVisualSource(asset));
    addToScene(scene, container);
    if (asset === "skin" && container.animationGroups?.[0]) {
        goToFrame(container.animationGroups[0], 12, engine);
    }

    await registerScene(scene);
    await startEngine(engine);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    canvas.dataset.ready = "true";
}

void main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
