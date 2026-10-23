// Scene 319: glTF export, Rotation Conversion. Babylon.js visualization test "GLTF Serializer Rotation conversion,
// left-handed" (playground #UK7FLI#1). Six rotated parent/child box pairs are exported with exportSceneAsGlb and
// reloaded with loadGltf. The right-handed variant is not ported (Lite has no right-handed scenes).
import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    createTransformNode,
    exportSceneAsGlb,
    loadGltf,
    registerScene,
    removeFromScene,
    startEngine,
} from "babylon-lite";
import type { EngineContext, Mesh, SceneContext } from "babylon-lite";

/** Babylon.js `Quaternion.FromEulerAngles(x, y, z)` (yaw-pitch-roll, angles in radians as written in the snippet). */
function fromEulerAngles(x: number, y: number, z: number): [number, number, number, number] {
    const sr = Math.sin(z * 0.5);
    const cr = Math.cos(z * 0.5);
    const sp = Math.sin(x * 0.5);
    const cp = Math.cos(x * 0.5);
    const sy = Math.sin(y * 0.5);
    const cy = Math.cos(y * 0.5);
    return [cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr, cy * cp * sr - sy * sp * cr, cy * cp * cr + sy * sp * sr];
}

type Quat = [number, number, number, number];

function createRotatedParentChild(engine: EngineContext, scene: SceneContext, xOffset: number, yOffset: number, parentQuaternion: Quat, childQuaternion: Quat): void {
    const parent = createTransformNode("parent", xOffset - 1, yOffset - 0.5, 0, ...parentQuaternion);

    const child = createBox(engine, 1);
    child.name = "child";
    // The Babylon.js boxes have no material, so they render and export with a default StandardMaterial. Lite's exporter
    // writes no material for a mesh without one.
    child.material = createStandardMaterial();
    child.rotationQuaternion.set(...childQuaternion);
    child.parent = parent;
    parent.children.push(child);
    addToScene(scene, parent);
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // scene.createDefaultLight() / createDefaultCamera(true, true, true) on the (still empty) Babylon.js scene yield:
    // a HemisphericLight "default light" (direction (0, 1, 0), intensity 1) and an ArcRotateCamera at alpha -PI/2, beta PI/2,
    // radius 1, target (0, 0, 0), minZ 0.01, maxZ 1000; the snippet then adds PI to alpha and sets radius = 3.
    const light = createHemisphericLight([0, 1, 0], 1);
    scene.camera = createArcRotateCamera(-Math.PI / 2 + Math.PI, Math.PI / 2, 3, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.01;
    scene.camera.farPlane = 1000;

    const Q = fromEulerAngles;
    createRotatedParentChild(engine, scene, 0, 0, Q(-21, 42, 63), Q(0, 0, 0));
    createRotatedParentChild(engine, scene, 0, 1, Q(0, 0, 0), Q(-98, 56, 43));
    createRotatedParentChild(engine, scene, 1, 0, Q(-21, 42, 63), Q(34, -78, -121));
    createRotatedParentChild(engine, scene, 1, 1, Q(-21, -100, -87), Q(-159, -80, 42));
    createRotatedParentChild(engine, scene, 2, 0, Q(189, -33, -90), Q(-9, 56, 43));
    createRotatedParentChild(engine, scene, 2, 1, Q(0, 360, 0), Q(-34, -180, 43));

    // exportThenImportAsync: the snippet excludes lights and cameras from the export, removes the exported nodes and loads the GLB back.
    const blob = await exportSceneAsGlb(scene);
    for (const mesh of scene.meshes.slice() as Mesh[]) {
        removeFromScene(scene, mesh);
    }
    addToScene(scene, await loadGltf(engine, blob));
    // A hemispheric light has no KHR_lights_punctual form, so it joins the scene after the round trip.
    addToScene(scene, light);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
