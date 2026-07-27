// Scene 269: mirrored-transform coverage — setParent, matrix nodes, runtime winding.
//
// Reproduces https://forum.babylonjs.com/t/lite-confusion-about-createnodetransform-and-negative-scaling/63859
// and covers every mirrored-transform fix in one frame. Each glTF group is reparented onto a fresh
// transform node which is THEN moved, so the reparented subtree has to follow it — a decomposition
// that loses the reflection, or a node that ignores the reparent, shows up immediately.
//
//   1. (left) glTF root reparented with setParent(). The loader's `__root__` carries the RH->LH flip
//      as a negative scale, so its local matrix has a negative determinant. A decomposition that
//      returns only non-negative scales drops the reflection and mirrors the model.
//   2. (centre-left) glTF `matrix`-declared node (Node1, a diag(-1,1,1) mirror) pulled out of the
//      hierarchy with setParent(). Such a node reports a captured raw matrix and ignores TRS writes,
//      so setParent used to be a no-op on it and the node stayed behind.
//   3. (right) PBR box mirrored at RUNTIME, after its renderable was built. Triangle winding
//      reverses, so the pipeline's frontFace must be re-resolved or the box renders inside-out.
//
// Standard-material winding is covered by scene 270 instead: Lite applies scene image processing
// (tone mapping / exposure / contrast) in the PBR path only, so a Standard mesh in this
// tone-mapped scene would carry an unrelated shading delta.
//
// Static once settled: the runtime mirror is applied on frame 1 and the scene reports ready only
// after the rebuild has drained, so the screenshot is deterministic.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    loadGltf,
    loadEnvironment,
    attachControl,
    registerScene,
    createTransformNode,
    setParent,
    createBox,
    createPbrMaterial,
    createSolidTexture2D,
    createHemisphericLight,
    enableMirroredMeshes,
    onBeforeRender,
} from "babylon-lite";
import type { ArcRotateCamera, SceneNode } from "babylon-lite";

const MODEL_URL = "/gltf-assets/Node_NegativeScale/Node_NegativeScale_01.gltf";

/** Depth-first search for a node by name. */
function findNode(root: SceneNode, name: string): SceneNode | undefined {
    if (root.name === name) {
        return root;
    }
    for (const child of root.children) {
        const hit = findNode(child, name);
        if (hit) {
            return hit;
        }
    }
    return undefined;
}

/** Apply a yaw + uniform scale + translation to a transform node. */
function place(node: SceneNode, x: number, y: number, z: number, yaw: number, scale: number): void {
    node.position.set(x, y, z);
    node.rotationQuaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    node.scaling.set(scale, scale, scale);
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3.2, 42, { x: 0, y: 1, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    // ── 1. Mirrored glTF root reparented, then the new parent is moved ────────
    const containerA = await loadGltf(engine, MODEL_URL);
    const newRootA = createTransformNode("newRootA");
    setParent(containerA.entities[0] as SceneNode, newRootA);
    place(newRootA, -13, 0, 0, Math.PI / 7, 0.8);
    // Only the container is added: it already owns the reparented subtree, and adding `newRootA`
    // too would walk that same subtree a second time and duplicate every mesh.
    addToScene(scene, containerA);

    // ── 2. Matrix-declared glTF node pulled out, then its new parent is moved ─
    const containerB = await loadGltf(engine, MODEL_URL);
    // Add first: the loader builds `children` arrays but leaves `parent` links to addToScene, and
    // setParent needs the real parent chain to compute the node's world transform.
    addToScene(scene, containerB);
    const rootB = containerB.entities[0] as SceneNode;
    // Park the rest of the asset behind the row so only the extracted node is under test.
    rootB.position.set(-5, 0, -14);
    // Node1 declares a raw `matrix` (diag(-1,1,1) + translate) — a matrix-backed node.
    const newRootB = createTransformNode("newRootB");
    setParent(findNode(rootB, "Node1")!, newRootB);
    place(newRootB, -5, 0, 2, -Math.PI / 9, 0.8);

    // ── 3. PBR box mirrored at runtime ────────────────────────────────────────
    const pbrBox = createBox(engine, 3);
    pbrBox.position.set(6, 1.5, 0);
    pbrBox.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.85, 0.35, 0.25),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.45, 0.0),
    });
    addToScene(scene, pbrBox);

    // Group 3 mirrors a procedural mesh after its renderable was built — the glTF loader's built-in
    // winding pass cannot see that, so the scene opts in explicitly. Called after every asset is
    // added so the watcher runs after their per-frame hooks.
    await enableMirroredMeshes(scene);

    await registerScene(scene);

    // Mirror the box on frame 1, i.e. once its renderable exists. The winding watcher then
    // re-resolves its pipeline through the material-swap queue.
    let frame = 0;
    onBeforeRender(scene, () => {
        frame++;
        if (frame === 1) {
            pbrBox.scaling.set(-1, 1, 1);
        }
    });

    await startEngine(engine);

    // Let the rebuild drain before declaring the frame stable.
    await new Promise<void>((resolve) => {
        const wait = (): void => (frame > 4 ? resolve() : void requestAnimationFrame(wait));
        wait();
    });

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
