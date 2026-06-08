// Scene 222 — Composite Gizmos (BJS reference)
//
// Three cubes, each parented to a TransformNode with non-null rotation and
// translation.  Each cube is driven by a composite gizmo through the BJS
// UtilityLayerRenderer:
//   • Cube 1 (left)   → PositionGizmo (3 axis-drag + 3 plane-drag)
//   • Cube 2 (centre) → RotationGizmo  (3 plane-rotation)
//   • Cube 3 (right)  → ScaleGizmo     (3 axis-scale + uniform-scale)
//
// `__scene222.setLocalMode(bool)` toggles `updateGizmoRotationToMatchAttachedMesh`
// on each gizmo (true = LOCAL, false = WORLD).  The test drives each gizmo in
// LOCAL then switches to WORLD and drives them again.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer";
import { PositionGizmo } from "@babylonjs/core/Gizmos/positionGizmo";
import { RotationGizmo } from "@babylonjs/core/Gizmos/rotationGizmo";
import { ScaleGizmo } from "@babylonjs/core/Gizmos/scaleGizmo";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);
    scene.attachControl();

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3.5, 14, new Vector3(0, 0, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    // Allow orbiting the reference scene with the mouse (matches the Lite scene,
    // which attaches arc-rotate controls that defer to gizmo interaction).
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.9;

    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.5, 0.5, 0.55);
    groundMat.specularColor = new Color3(0, 0, 0);
    const ground = MeshBuilder.CreateGround("ground", { width: 14, height: 14 }, scene);
    ground.material = groundMat;

    // Build a parented cube — TransformNode with non-null TR, then a cube
    // child whose local TRS is identity so its world transform mirrors the
    // parent's TR.  Returns { parent, cube } so tests can probe both.
    const makeParentedCube = (name: string, parentT: Vector3, parentR: Vector3, color: Color3) => {
        const parent = new TransformNode(name + "Parent", scene);
        parent.position.copyFrom(parentT);
        parent.rotationQuaternion = Quaternion.RotationYawPitchRoll(parentR.y, parentR.x, parentR.z);
        const cube = MeshBuilder.CreateBox(name, { size: 1 }, scene);
        const mat = new StandardMaterial(name + "Mat", scene);
        mat.diffuseColor = color;
        cube.material = mat;
        cube.parent = parent;
        // Force quaternion-based rotation on the cube so gizmo rotation drags
        // can mutate rotationQuaternion directly (matches Lite behaviour).
        cube.rotationQuaternion = Quaternion.Identity();
        return { parent, cube };
    };

    const cube1 = makeParentedCube("cube1", new Vector3(-4.5, 0.5, 0), new Vector3(0, 0.4, 0), new Color3(0.8, 0.25, 0.25));
    const cube2 = makeParentedCube("cube2", new Vector3(0, 0.5, 0), new Vector3(0.3, -0.5, 0.2), new Color3(0.25, 0.8, 0.25));
    const cube3 = makeParentedCube("cube3", new Vector3(4.5, 0.5, 0), new Vector3(-0.3, 0.7, -0.4), new Color3(0.25, 0.25, 0.8));

    const utilityLayer = new UtilityLayerRenderer(scene);

    const positionGizmo = new PositionGizmo(utilityLayer);
    positionGizmo.attachedNode = cube1.cube;

    const rotationGizmo = new RotationGizmo(utilityLayer);
    rotationGizmo.attachedNode = cube2.cube;

    const scaleGizmo = new ScaleGizmo(utilityLayer);
    scaleGizmo.attachedNode = cube3.cube;

    (window as unknown as Record<string, unknown>).__scene222 = {
        cube1Pos: () => ({ x: cube1.cube.position.x, y: cube1.cube.position.y, z: cube1.cube.position.z }),
        cube2Quat: () => {
            const q = cube2.cube.rotationQuaternion ?? Quaternion.Identity();
            return { x: q.x, y: q.y, z: q.z, w: q.w };
        },
        cube3Scale: () => ({ x: cube3.cube.scaling.x, y: cube3.cube.scaling.y, z: cube3.cube.scaling.z }),
        setLocalMode: (useLocal: boolean) => {
            // BJS default: updateGizmoRotationToMatchAttachedMesh = true (LOCAL).
            // setLocalMode(false) switches to WORLD on position + rotation.  The
            // scale gizmo doesn't support world coords in BJS so it stays local.
            positionGizmo.updateGizmoRotationToMatchAttachedMesh = useLocal;
            rotationGizmo.updateGizmoRotationToMatchAttachedMesh = useLocal;
        },
    };

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => eng._drawCalls?.fetchNewFrame());

    let frame = 0;
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
        frame++;
        if (frame === 3) {
            canvas.dataset.initMs = String(performance.now() - __initStart);
            canvas.dataset.ready = "true";
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch(console.error);
