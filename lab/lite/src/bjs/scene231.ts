// BJS reference for Scene 231 — StandardMaterial deform features (per-vertex
// color + skeletal skinning + UV offset) on an in-code beam with programmatically
// animated bones. Mirrors lab/lite/src/lite/scene231.ts exactly: the geometry,
// vertex colors, skin weights, checker texture, and per-frame bone matrices all
// come from the shared engine-agnostic module so the two engines stay in lockstep.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import "@babylonjs/core/Materials/standardMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Scene } from "@babylonjs/core/scene";
import { boneMatrixData, buildBeamData, buildCheckerPixels, CHECKER_SIZE, UV_OFFSET } from "../shared/scene231-skin.js";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.145, 0.165, 0.21, 1);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, 1.1, 5.5, new Vector3(0, 0, 0), scene);
    camera.fov = 0.72;
    camera.minZ = 0.1;
    camera.maxZ = 100;
    camera.attachControl(canvas, true);
    scene.activeCamera = camera;

    const light = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    light.intensity = 0.9;

    const beam = buildBeamData();

    // Build the mesh from the shared geometry, including per-vertex color and skin attributes.
    const mesh = new Mesh("scene231-beam", scene);
    const vd = new VertexData();
    vd.positions = beam.positions;
    vd.normals = beam.normals;
    vd.uvs = beam.uvs;
    vd.colors = beam.colors;
    vd.indices = beam.indices;
    vd.matricesIndices = Array.from(beam.joints);
    vd.matricesWeights = Array.from(beam.weights);
    vd.applyToMesh(mesh);
    mesh.numBoneInfluencers = 4;
    mesh.hasVertexAlpha = false;
    mesh.useVertexColors = true;

    // Two independent bones (root + upper), bound at identity so the per-frame
    // local matrices become the skin palette directly (matching Lite's bone texture).
    const skeleton = new Skeleton("scene231-skeleton", "scene231-skeleton", scene);
    const root = new Bone("root", skeleton, null, Matrix.Identity());
    const upper = new Bone("upper", skeleton, null, Matrix.Identity());
    mesh.skeleton = skeleton;

    const checker = RawTexture.CreateRGBATexture(buildCheckerPixels(), CHECKER_SIZE, CHECKER_SIZE, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    checker.wrapU = Texture.WRAP_ADDRESSMODE;
    checker.wrapV = Texture.WRAP_ADDRESSMODE;
    checker.uOffset = UV_OFFSET[0];
    checker.vOffset = UV_OFFSET[1];

    const material = new StandardMaterial("scene231-mat", scene);
    material.diffuseColor = new Color3(1, 1, 1);
    material.diffuseTexture = checker;
    mesh.material = material;

    // Per-frame programmatic bone animation: recompute the bone matrices as a pure
    // function of the frame index and push them as the bones' local transforms.
    const boneData = boneMatrixData(0);
    const m0 = Matrix.Identity();
    const m1 = Matrix.Identity();
    const params = new URLSearchParams(window.location.search);
    const seek = parseFloat(params.get("seekTime") || "");
    const freezeFrame = isNaN(seek) ? -1 : Math.round(seek * 60);
    let frame = 0;
    let frozen = false;

    const applyBones = (): void => {
        Matrix.FromArrayToRef(boneData, 0, m0);
        Matrix.FromArrayToRef(boneData, 16, m1);
        root.updateMatrix(m0, false, true);
        upper.updateMatrix(m1, false, true);
    };
    applyBones();

    scene.onBeforeRenderObservable.add(() => {
        if (frozen) {
            return;
        }
        frame++;
        boneMatrixData(frame, boneData);
        applyBones();
        if (freezeFrame >= 0 && frame >= freezeFrame) {
            frozen = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
