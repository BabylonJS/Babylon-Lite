// Scene 224 — Bounding Box Gizmo (BJS reference)
//
// 5 cubes parented to a common TransformNode.  A BoundingBoxGizmo is
// attached to that root so the gizmo's bounding box encompasses every cube
// at once.  Scripted pointer drags on the gizmo widgets exercise the three
// supported operations:
//   • Drag a corner cube → uniform scale of the whole group
//   • Drag a rotation anchor → rotation around the corresponding axis
//   • Drag the body box → camera-plane translation
//
// `__scene224.{rootPos, rootQuat, rootScale}` expose the group's transform
// for the parity spec to verify each drag took effect.
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
import { BoundingBoxGizmo } from "@babylonjs/core/Gizmos/boundingBoxGizmo";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);
    scene.attachControl();

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3, 14, new Vector3(0, 1, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    // Enable orbit/zoom/pan on the reference camera so it can be rotated like
    // the Lite scene.  The gizmo's own pointer-drag behaviour detaches the
    // camera while a handle is being dragged, so the two don't fight.
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.9;

    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.5, 0.5, 0.55);
    const ground = MeshBuilder.CreateGround("ground", { width: 14, height: 14 }, scene);
    ground.material = groundMat;

    // Group root — the BoundingBoxGizmo's "attached" node.  Cubes parented
    // to this root inherit its TRS so the gizmo's pointer interactions on
    // the bounds drive all 5 children together.
    const root = new TransformNode("groupRoot", scene);
    root.position.set(0, 1, 0);
    root.rotationQuaternion = Quaternion.Identity();

    const colors = [
        new Color3(0.8, 0.25, 0.25),
        new Color3(0.25, 0.8, 0.25),
        new Color3(0.25, 0.25, 0.8),
        new Color3(0.85, 0.85, 0.2),
        new Color3(0.7, 0.3, 0.85),
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
        const cube = MeshBuilder.CreateBox(`cube${i + 1}`, { size: sizes[i] }, scene);
        cube.position.set(offsets[i]![0], offsets[i]![1], offsets[i]![2]);
        const mat = new StandardMaterial(`cube${i + 1}Mat`, scene);
        mat.diffuseColor = colors[i]!;
        cube.material = mat;
        cube.parent = root;
    }

    const utilityLayer = new UtilityLayerRenderer(scene);
    const bbox = new BoundingBoxGizmo(new Color3(1, 1, 0.4), utilityLayer);
    bbox.attachedMesh = root as never;
    // Match Lite's default body-translate behaviour.  BJS only enables drag
    // on the box body when this is called.
    bbox.enableDragBehavior();

    (window as unknown as Record<string, unknown>).__scene224 = {
        rootPos: () => ({ x: root.position.x, y: root.position.y, z: root.position.z }),
        rootQuat: () => {
            const q = root.rotationQuaternion ?? Quaternion.Identity();
            return { x: q.x, y: q.y, z: q.z, w: q.w };
        },
        rootScale: () => ({ x: root.scaling.x, y: root.scaling.y, z: root.scaling.z }),
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
