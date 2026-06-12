// Scene 222 — Composite Gizmos (Babylon Lite)
//
// Three cubes, each parented to a TransformNode with non-null rotation and
// translation.  Each cube is driven by a composite gizmo via the utility layer:
//   • Cube 1 (left)   → PositionGizmo (3 axis-drag + 3 plane-drag)
//   • Cube 2 (centre) → RotationGizmo  (3 plane-rotation)
//   • Cube 3 (right)  → ScaleGizmo     (3 axis-scale + uniform-scale)
//
// `__scene222.setLocalMode(bool)` propagates the world/local coord-mode flag
// down to every sub-gizmo so each one re-orients its drag axis to follow the
// attached node's rotation each frame.  The test drives each gizmo in LOCAL
// mode (default) then switches to WORLD and drives them again.
import {
    addToScene,
    attachControl,
    attachPositionGizmoToNode,
    attachRotationGizmoToNode,
    attachScaleGizmoToNode,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createPositionGizmo,
    createRotationGizmo,
    createSceneContext,
    createScaleGizmo,
    createStandardMaterial,
    createTransformNode,
    createUtilityLayer,
    isGizmoInteracting,
    isGizmoDragging,
    isGizmoPickPending,
    onBeforeRender,
    registerScene,
    registerUtilityLayer,
    setPositionGizmoLocalCoordinates,
    setRotationGizmoLocalCoordinates,
    startEngine,
} from "babylon-lite";

/** Yaw/Pitch/Roll → quaternion, matching BJS `Quaternion.RotationYawPitchRoll`
 *  (rotation applied in Y → X → Z order).  The BJS reference scene builds the
 *  parent rotations with this composition, so the Lite scene must use the same
 *  one or the multi-axis cubes (green/blue) end up with a different orientation. */
function rotationYawPitchRoll(yaw: number, pitch: number, roll: number): [number, number, number, number] {
    const halfRoll = roll * 0.5,
        halfPitch = pitch * 0.5,
        halfYaw = yaw * 0.5;
    const sinRoll = Math.sin(halfRoll),
        cosRoll = Math.cos(halfRoll);
    const sinPitch = Math.sin(halfPitch),
        cosPitch = Math.cos(halfPitch);
    const sinYaw = Math.sin(halfYaw),
        cosYaw = Math.cos(halfYaw);
    return [
        cosYaw * sinPitch * cosRoll + sinYaw * cosPitch * sinRoll,
        sinYaw * cosPitch * cosRoll - cosYaw * sinPitch * sinRoll,
        cosYaw * cosPitch * sinRoll - sinYaw * sinPitch * cosRoll,
        cosYaw * cosPitch * cosRoll + sinYaw * sinPitch * sinRoll,
    ];
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3.5, 14, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    // Orbit/zoom/pan controls — but defer to gizmo interaction: when the pointer
    // is hovering or dragging a gizmo, the camera must not orbit.
    attachControl(camera, canvas, scene, {
        shouldHandlePointerDown: () => !isGizmoInteracting(canvas),
        isExternalDragActive: () => isGizmoDragging(canvas),
        isExternalPickPending: () => isGizmoPickPending(canvas),
    });

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.9;
    addToScene(scene, light);

    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.5, 0.5, 0.55];
    // Matte ground — kill the specular highlight so the parity comparison
    // focuses on the gizmos rather than a light-dependent glare on the floor.
    groundMat.specularColor = [0, 0, 0];
    const ground = createGround(engine, { width: 14, height: 14 });
    ground.material = groundMat;
    addToScene(scene, ground);

    const makeParentedCube = (name: string, parentT: { x: number; y: number; z: number }, parentR: { x: number; y: number; z: number }, color: [number, number, number]) => {
        const [qx, qy, qz, qw] = rotationYawPitchRoll(parentR.y, parentR.x, parentR.z);
        const parent = createTransformNode(name + "Parent", parentT.x, parentT.y, parentT.z, qx, qy, qz, qw);
        const cube = createBox(engine, 1);
        cube.name = name;
        const mat = createStandardMaterial();
        mat.diffuseColor = color;
        cube.material = mat;
        cube.parent = parent;
        addToScene(scene, cube);
        return { parent, cube };
    };

    const cube1 = makeParentedCube("cube1", { x: -4.5, y: 0.5, z: 0 }, { x: 0, y: 0.4, z: 0 }, [0.8, 0.25, 0.25]);
    const cube2 = makeParentedCube("cube2", { x: 0, y: 0.5, z: 0 }, { x: 0.3, y: -0.5, z: 0.2 }, [0.25, 0.8, 0.25]);
    const cube3 = makeParentedCube("cube3", { x: 4.5, y: 0.5, z: 0 }, { x: -0.3, y: 0.7, z: -0.4 }, [0.25, 0.25, 0.8]);

    await registerScene(scene);

    const utilityLayer = createUtilityLayer(engine, scene);

    const positionGizmo = createPositionGizmo(engine, utilityLayer);
    attachPositionGizmoToNode(positionGizmo, cube1.cube);
    // Default to LOCAL coords so the gizmo axes follow the parent's rotation,
    // matching BJS default `updateGizmoRotationToMatchAttachedMesh = true`.
    setPositionGizmoLocalCoordinates(positionGizmo, true);

    const rotationGizmo = createRotationGizmo(engine, utilityLayer);
    attachRotationGizmoToNode(rotationGizmo, cube2.cube);
    setRotationGizmoLocalCoordinates(rotationGizmo, true);

    const scaleGizmo = createScaleGizmo(engine, utilityLayer);
    attachScaleGizmoToNode(scaleGizmo, cube3.cube);

    (window as unknown as Record<string, unknown>).__scene222 = {
        cube1Pos: () => ({ x: cube1.cube.position.x, y: cube1.cube.position.y, z: cube1.cube.position.z }),
        cube1WorldPos: () => {
            const wm = cube1.cube.worldMatrix;
            return { x: wm[12]!, y: wm[13]!, z: wm[14]! };
        },
        cube2Quat: () => ({ x: cube2.cube.rotationQuaternion.x, y: cube2.cube.rotationQuaternion.y, z: cube2.cube.rotationQuaternion.z, w: cube2.cube.rotationQuaternion.w }),
        cube3Scale: () => ({ x: cube3.cube.scaling.x, y: cube3.cube.scaling.y, z: cube3.cube.scaling.z }),
        posGizmoRoot: () => ({ x: positionGizmo.xGizmo.root.position.x, y: positionGizmo.xGizmo.root.position.y, z: positionGizmo.xGizmo.root.position.z }),
        rotGizmoRoot: () => ({ x: rotationGizmo.xGizmo.root.position.x, y: rotationGizmo.xGizmo.root.position.y, z: rotationGizmo.xGizmo.root.position.z }),
        scaleGizmoRoot: () => ({ x: scaleGizmo.xGizmo.root.position.x, y: scaleGizmo.xGizmo.root.position.y, z: scaleGizmo.xGizmo.root.position.z }),
        scaleGizmoScale: () => ({ x: scaleGizmo.xGizmo.root.scaling.x, y: scaleGizmo.xGizmo.root.scaling.y, z: scaleGizmo.xGizmo.root.scaling.z }),
        // Diagnostic: gizmo X-arrow root rotation quaternion — confirms whether
        // local-coord mode is being applied (the X arrow should rotate with
        // the attached node's parent transform).
        posXGizmoQuat: () => ({
            x: positionGizmo.xGizmo.root.rotationQuaternion.x,
            y: positionGizmo.xGizmo.root.rotationQuaternion.y,
            z: positionGizmo.xGizmo.root.rotationQuaternion.z,
            w: positionGizmo.xGizmo.root.rotationQuaternion.w,
            useLocal: positionGizmo.xGizmo.useLocalCoordinates,
        }),
        probePick: async (x: number, y: number) => {
            const { createGpuPicker, pickAsync } = await import("babylon-lite");
            const picker = createGpuPicker(utilityLayer.scene);
            const info = await pickAsync(picker, x, y);
            return info.hit ? (info.pickedMesh?.name ?? "<unnamed>") : "miss";
        },
        setLocalMode: (useLocal: boolean) => {
            setPositionGizmoLocalCoordinates(positionGizmo, useLocal);
            setRotationGizmoLocalCoordinates(rotationGizmo, useLocal);
            // ScaleGizmo doesn't support world coords (matches BJS); stays local.
        },
    };

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
