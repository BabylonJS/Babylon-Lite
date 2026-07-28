// Scene 270: mirrored StandardMaterial meshes — triangle-winding reversal.
//
// A mesh whose world transform mirrors it (`scaling.x = -1`, or a negative scale inherited from an
// ancestor) has reversed triangle winding. Without reversing the pipeline's `frontFace` its front
// faces are culled and it renders inside-out. Lite's Standard pipeline had no winding reversal at
// all — only the glTF/PBR path did — so every mirrored Standard mesh was wrong.
//
// Four boxes, left to right:
//   1. control, not mirrored
//   2. mirrored BEFORE its renderable was built (build-time winding rule)
//   3. mirrored at RUNTIME, after its renderable was built (winding watcher + pipeline rebuild)
//   4. mirrored by an ANCESTOR's negative scale, applied at runtime (the mesh's own scaling stays
//      positive, so the sign has to come from the full world matrix)
//
// Deliberately has no environment/tone mapping: Lite applies scene image processing in the PBR path
// only, so a tone-mapped Standard mesh would carry an unrelated shading delta. Static once settled.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    attachControl,
    registerScene,
    createBox,
    createStandardMaterial,
    createTransformNode,
    createHemisphericLight,
    createDirectionalLight,
    enableMirroredMeshes,
    onBeforeRender,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.15, g: 0.16, b: 0.22, a: 1.0 };

    scene.camera = createArcRotateCamera(-Math.PI / 2 + 0.5, Math.PI / 3, 26, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 200;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    const hemi = createHemisphericLight([0, 1, 0], 0.7);
    addToScene(scene, hemi);
    const dir = createDirectionalLight([-0.4, -1, 0.6], 0.8);
    addToScene(scene, dir);

    const mat = createStandardMaterial();
    mat.diffuseColor = [0.35, 0.6, 0.9];
    mat.specularColor = [0, 0, 0];

    const box = (x: number) => {
        const m = createBox(engine, 4);
        m.position.set(x, 0, 0);
        m.material = mat;
        addToScene(scene, m);
        return m;
    };

    // 1. Control — never mirrored.
    box(-9);

    // 2. Mirrored before its renderable is built.
    box(-3).scaling.set(-1, 1, 1);

    // 3. Mirrored at runtime.
    const runtimeBox = box(3);

    // 4. Mirrored at runtime through an ancestor. The child sits at local X = -9 so the parent's
    //    -1 X scale lands it at world X = +9 — a spot no other box occupies, otherwise the control
    //    box would sit on top of it and mask a broken result.
    const mirrorParent = createTransformNode("mirrorParent");
    const childBox = box(0);
    childBox.position.set(-9, 0, 0);
    childBox.parent = mirrorParent;
    mirrorParent.children.push(childBox);

    // No glTF here, so nothing else provides winding reversal — this opt-in is what makes the
    // mirrored boxes render right side out. Called after every mesh is added so the watcher runs
    // after any per-frame hooks they register.
    await enableMirroredMeshes(scene);

    await registerScene(scene);

    let frame = 0;
    onBeforeRender(scene, () => {
        frame++;
        if (frame === 1) {
            runtimeBox.scaling.set(-1, 1, 1);
            mirrorParent.scaling.set(-1, 1, 1);
        }
    });

    await startEngine(engine);

    // Let the pipeline rebuilds drain before declaring the frame stable.
    await new Promise<void>((resolve) => {
        const wait = (): void => (frame > 4 ? resolve() : void requestAnimationFrame(wait));
        wait();
    });

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
