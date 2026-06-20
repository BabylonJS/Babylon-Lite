// Scene 251 — AnimationGroupMask (Xbot walk with frozen legs)
//
// Loads Xbot, plays only the "walk" clip, and applies an AnimationGroupMask in
// Exclude mode listing the lower-body bones (both legs + feet/toes). Everything
// animates EXCEPT those, so the hips, spine, and arms swing through the walk
// while the legs hold their bind pose. Validates Babylon-Lite's AnimationGroupMask
// against Babylon.js (which uses AnimationGroupMask + the same bone names). Frozen
// at a deterministic frame for parity capture.

import {
    addToScene,
    attachControl,
    AnimationGroupMaskMode,
    createAnimationGroupMask,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    goToFrame,
    loadGltf,
    registerScene,
    startEngine,
    stopAnimation,
} from "babylon-lite";
import type { AnimationGroup, ArcRotateCamera } from "babylon-lite";

const XBOT_URL = "https://playground.babylonjs.com/scenes/Xbot.glb";

// Lower-body bones (both legs + feet/toes). Exclude mode → everything animates EXCEPT
// these, so the character walks with frozen (bind-pose) legs while the hips, spine, and
// arms swing normally.
const LOWER_BODY_BONES = [
    "mixamorig:LeftUpLeg",
    "mixamorig:LeftLeg",
    "mixamorig:LeftFoot",
    "mixamorig:LeftToeBase",
    "mixamorig:LeftToe_End",
    "mixamorig:RightUpLeg",
    "mixamorig:RightLeg",
    "mixamorig:RightFoot",
    "mixamorig:RightToeBase",
    "mixamorig:RightToe_End",
];

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    scene.fixedDeltaMs = 16.0;

    scene.camera = createArcRotateCamera(Math.PI / 2, Math.PI / 4, 3, { x: 0, y: 1, z: 0 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.6));
    addToScene(scene, createDirectionalLight([0, -0.5, -1], 0.8));

    const xbot = await loadGltf(engine, XBOT_URL);
    addToScene(scene, xbot);

    const groups = xbot.animationGroups ?? [];
    const walk = requireGroup(groups, "walk");
    // Stop every clip so only `walk` poses the shared skeleton.
    for (const group of groups) {
        stopAnimation(group);
    }
    walk.mask = createAnimationGroupMask(LOWER_BODY_BONES, AnimationGroupMaskMode.Exclude);

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "0.5");
    const seekFrame = seekTime * 60;

    await registerScene(scene);
    // Apply the masked pose deterministically (legs/hips at bind, upper body at frame).
    goToFrame(walk, seekFrame, engine);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.animationFrozen = "true";
    canvas.dataset.ready = "true";
}

function requireGroup(groups: readonly AnimationGroup[], name: string): AnimationGroup {
    const group = groups.find((candidate) => candidate.name === name);
    if (!group) {
        throw new Error(`Xbot animation group "${name}" was not found`);
    }
    return group;
}

main().catch(console.error);
