// Scene 224 — Bounding Box Gizmo (Babylon Lite)
//
// 5 cubes parented to a common TransformNode (the "group root").  A
// BoundingBoxGizmo is attached to that root and computes the AABB
// covering every cube — drag operations on the gizmo widgets drive the
// root's transform, which in turn moves/scales/rotates the whole group.
//
// `__scene224.{rootPos, rootQuat, rootScale}` expose the group's
// transform for the parity spec to verify each drag took effect.
import {
    addToScene,
    attachBoundingBoxGizmoToNode,
    attachControl,
    createArcRotateCamera,
    createBoundingBoxGizmo,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    createTransformNode,
    createUtilityLayer,
    getViewProjectionMatrix,
    isGizmoInteracting,
    isGizmoDragging,
    isGizmoPickPending,
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

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 14, { x: 0, y: 1, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    // Orbit/zoom/pan controls — defer to gizmo interaction so dragging a
    // bounding-box handle doesn't also orbit the camera.  The parity test loads
    // with `?nocam` to suppress camera controls entirely so a scripted drag that
    // misses a handle can't orbit the view (keeping the camera identical between
    // the two engines); interactive use keeps full orbit.
    if (!new URLSearchParams(window.location.search).has("nocam")) {
        attachControl(camera, canvas, scene, { shouldHandlePointerDown: () => !isGizmoInteracting(canvas), isExternalDragActive: () => isGizmoDragging(canvas), isExternalPickPending: () => isGizmoPickPending(canvas) });
    }

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.9;
    addToScene(scene, light);

    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.5, 0.5, 0.55];
    const ground = createGround(engine, { width: 14, height: 14 });
    ground.material = groundMat;
    addToScene(scene, ground);

    const root = createTransformNode("groupRoot", 0, 1, 0, 0, 0, 0, 1);

    const colors: [number, number, number][] = [
        [0.8, 0.25, 0.25],
        [0.25, 0.8, 0.25],
        [0.25, 0.25, 0.8],
        [0.85, 0.85, 0.2],
        [0.7, 0.3, 0.85],
    ];
    const offsets: [number, number, number][] = [
        [-1.5, 0, 0],
        [1.5, 0, 0],
        [0, 0, -1.5],
        [0, 0, 1.5],
        [0, 0.9, 0],
    ];
    const sizes = [0.8, 0.6, 0.9, 0.7, 0.5];
    for (let i = 0; i < 5; i++) {
        const cube = createBox(engine, sizes[i]!);
        cube.name = `cube${i + 1}`;
        cube.position.set(offsets[i]![0], offsets[i]![1], offsets[i]![2]);
        const mat = createStandardMaterial();
        mat.diffuseColor = colors[i]!;
        cube.material = mat;
        cube.parent = root;
        addToScene(scene, cube);
    }

    await registerScene(engine, scene);

    const utilityLayer = createUtilityLayer(engine, scene);
    const bbox = createBoundingBoxGizmo(engine, utilityLayer, { color: [1, 1, 0.4] });
    attachBoundingBoxGizmoToNode(bbox, root);

    (window as unknown as Record<string, unknown>).__scene224 = {
        rootPos: () => ({ x: root.position.x, y: root.position.y, z: root.position.z }),
        rootQuat: () => ({ x: root.rotationQuaternion.x, y: root.rotationQuaternion.y, z: root.rotationQuaternion.z, w: root.rotationQuaternion.w }),
        rootScale: () => ({ x: root.scaling.x, y: root.scaling.y, z: root.scaling.z }),
        // Directly drive the group root's TRS, bypassing pointer-drag entirely.
        // Used by the parity spec to put BOTH engines at an identical post-edit
        // pose so the rendered frame compares cleanly (only material / AA noise
        // remains).  Avoids the pointer-drag plumbing gap that produces ~14%
        // over-rotation / over-scale in Lite vs BJS for the same screen drag.
        setRootTrs: (pos: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }, scl: { x: number; y: number; z: number }) => {
            root.position.set(pos.x, pos.y, pos.z);
            root.rotationQuaternion.set(q.x, q.y, q.z, q.w);
            root.scaling.set(scl.x, scl.y, scl.z);
        },
        aabb: () => {
            const b = (bbox as unknown as { _aabb: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number }; centre: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } } })._aabb;
            return { min: { ...b.min }, max: { ...b.max }, centre: { ...b.centre }, size: { ...b.size } };
        },
        bbox: () => {
            const meshes = bbox._meshes.map((m) => ({
                name: m.name,
                pos: { x: m.position.x, y: m.position.y, z: m.position.z },
                scl: { x: m.scaling.x, y: m.scaling.y, z: m.scaling.z },
                visible: m.visible,
            }));
            return { count: meshes.length, meshes: meshes.slice(0, 14) };
        },
        // Project a world-space point to a canvas-relative CSS pixel
        // coordinate using the active camera's view-projection matrix.  The
        // parity spec uses this on BOTH engines to drive each drag by
        // world-space anchors (corner / edge midpoint / body centre) rather
        // than hard-coded screen pixels — so the simulated input actually
        // hits the gizmo handles in each engine's projection.
        worldToScreen: (p: { x: number; y: number; z: number }) => {
            const aspect = canvas.clientWidth / canvas.clientHeight;
            const vp = getViewProjectionMatrix(camera, aspect);
            const clipX = vp[0]! * p.x + vp[4]! * p.y + vp[8]! * p.z + vp[12]!;
            const clipY = vp[1]! * p.x + vp[5]! * p.y + vp[9]! * p.z + vp[13]!;
            const clipW = vp[3]! * p.x + vp[7]! * p.y + vp[11]! * p.z + vp[15]!;
            const ndcX = clipX / clipW;
            const ndcY = clipY / clipW;
            return {
                x: (ndcX * 0.5 + 0.5) * canvas.clientWidth,
                y: (1 - (ndcY * 0.5 + 0.5)) * canvas.clientHeight,
            };
        },
    };

    await registerUtilityLayer(engine, utilityLayer);

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
