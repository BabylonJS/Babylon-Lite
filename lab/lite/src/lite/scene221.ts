// Scene 221 — Pointer Drags (Babylon Lite)
//
// Four cubes over a flat ground.  Each cube is driven by a different gizmo
// rendered through a utility layer (separate scene, fresh depth, always on
// top):
//   • Cube 1 (left)         → axisDragGizmo on X
//   • Cube 2 (centre-left)  → planeRotationGizmo on Y
//   • Cube 3 (centre-right) → planeDragGizmo on Y normal
//   • Cube 4 (right)        → axisScaleGizmo on Y
import {
    addToScene,
    attachAxisDragGizmoToNode,
    attachAxisScaleGizmoToNode,
    attachPlaneDragGizmoToNode,
    attachPlaneRotationGizmoToNode,
    createArcRotateCamera,
    createAxisDragGizmo,
    createAxisScaleGizmo,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createPlaneDragGizmo,
    createPlaneRotationGizmo,
    createSceneContext,
    createStandardMaterial,
    createUtilityLayer,
    onBeforeRender,
    registerScene,
    registerUtilityLayer,
    startEngine,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 12, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.9;
    addToScene(scene, light);

    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.5, 0.5, 0.55];
    const ground = createGround(engine, { width: 12, height: 12 });
    ground.material = groundMat;
    addToScene(scene, ground);

    const makeCube = (name: string, x: number, color: [number, number, number]) => {
        const cube = createBox(engine, 1);
        cube.name = name;
        cube.position.set(x, 0.5, 0);
        const mat = createStandardMaterial();
        mat.diffuseColor = color;
        cube.material = mat;
        addToScene(scene, cube);
        return cube;
    };

    const cube1 = makeCube("cube1", -3.75, [0.8, 0.25, 0.25]);
    const cube2 = makeCube("cube2", -1.25, [0.25, 0.8, 0.25]);
    const cube3 = makeCube("cube3", 1.25, [0.25, 0.25, 0.8]);
    const cube4 = makeCube("cube4", 3.75, [0.85, 0.85, 0.25]);

    // Expose cube state for the parity spec to verify each drag took effect.
    (window as unknown as Record<string, unknown>).__scene221 = {
        cube1Pos: () => ({ x: cube1.position.x, y: cube1.position.y, z: cube1.position.z }),
        cube2Quat: () => ({ x: cube2.rotationQuaternion.x, y: cube2.rotationQuaternion.y, z: cube2.rotationQuaternion.z, w: cube2.rotationQuaternion.w }),
        cube3Pos: () => ({ x: cube3.position.x, y: cube3.position.y, z: cube3.position.z }),
        cube4Scale: () => ({ x: cube4.scaling.x, y: cube4.scaling.y, z: cube4.scaling.z }),
    };

    await registerScene(scene);

    // Utility layer — its render pass overlays the main scene with a freshly
    // cleared depth buffer so gizmos always appear on top.
    const utilityLayer = createUtilityLayer(engine, scene);

    const axisDrag = createAxisDragGizmo(engine, utilityLayer, {
        dragAxis: { x: 1, y: 0, z: 0 },
        color: [1, 0, 0],
    });
    attachAxisDragGizmoToNode(axisDrag, cube1);

    const planeRotation = createPlaneRotationGizmo(engine, utilityLayer, {
        planeNormal: { x: 0, y: 1, z: 0 },
        color: [0, 1, 0],
    });
    attachPlaneRotationGizmoToNode(planeRotation, cube2);

    const planeDrag = createPlaneDragGizmo(engine, utilityLayer, {
        dragPlaneNormal: { x: 0, y: 1, z: 0 },
        color: [0, 0, 1],
    });
    attachPlaneDragGizmoToNode(planeDrag, cube3);

    const axisScale = createAxisScaleGizmo(engine, utilityLayer, {
        dragAxis: { x: 0, y: 1, z: 0 },
        color: [1, 0.85, 0.1],
    });
    attachAxisScaleGizmoToNode(axisScale, cube4);

    await registerUtilityLayer(utilityLayer);

    let frame = 0;
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        frame++;
        if (frame === 3) {
            canvas.dataset.initMs = String(performance.now() - __initStart);
            canvas.dataset.ready = "true";
        }
    });

    await startEngine(engine);
}

main().catch(console.error);
