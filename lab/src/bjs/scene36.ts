// Reference scene 36 — Babylon.js textured-plane rendering of facing
// (spherical) billboards.
//
// `SpriteManager` performs an off-by-axis projection that does not match
// Lite's `composeFacingBillboard` WGSL (which expands each quad along
// `cameraRight`/`cameraUp` extracted from the camera world matrix). To
// remove the spurious sub-pixel diff that SpriteManager introduces under
// camera tilt, we instead build per-sprite quads with `MeshBuilder.CreatePlane`
// and orient them with the SAME basis as Lite's vertex shader:
//
//   right = camera.worldMatrix column 0
//   up    = camera.worldMatrix column 1
//   fwd   = cross(right, up)               // plane normal toward camera
//
// This is the same recipe scenes 35 (yaw-locked) and 36 (axis-locked) use
// to achieve MAD = 0.0000.
//
// Pivot is the plane center (matches Lite's `(0.5, 0.5)` convention).

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import "@babylonjs/core/Materials/standardMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { BILLBOARD_ATLAS_INFO, BILLBOARD_ATLAS_URL } from "../_shared/sprite-billboard-atlas";
import { BILLBOARD_SCENE_LAYOUT } from "../_shared/billboard-scene-layout";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false });
    await engine.initAsync();

    const seekParam = new URLSearchParams(location.search).get("seekTime");
    const seekTime = seekParam !== null ? parseFloat(seekParam) : 1.0;

    const scene = new Scene(engine);
    const cc = BILLBOARD_SCENE_LAYOUT.clearColor;
    scene.clearColor = new Color4(cc.r, cc.g, cc.b, cc.a);

    const camCfg = BILLBOARD_SCENE_LAYOUT.camera;
    const cam = new ArcRotateCamera(
        "cam",
        camCfg.alpha,
        camCfg.beta,
        camCfg.radius,
        new Vector3(camCfg.target.x, camCfg.target.y, camCfg.target.z),
        scene,
    );
    cam.fov = camCfg.fov;
    cam.minZ = camCfg.near;
    cam.maxZ = camCfg.far;

    new HemisphericLight("light", new Vector3(0, 1, 0), scene).intensity = 0.95;

    const groundMat = new StandardMaterial("gmat", scene);
    const gc = BILLBOARD_SCENE_LAYOUT.groundColor;
    groundMat.diffuseColor = new Color3(gc[0], gc[1], gc[2]);
    const ground = MeshBuilder.CreateGround("ground", { width: 12, height: 12 }, scene);
    ground.material = groundMat;

    // Atlas texture — invertY=false to match Lite's `loadSpriteAtlas`
    // (which forces invertY=false). Both engines must consume the atlas
    // row order the same way.
    const atlasTex = await new Promise<Texture>((resolve) => {
        const t = new Texture(BILLBOARD_ATLAS_URL, scene, true, false, Texture.LINEAR_LINEAR);
        t.wrapU = Texture.CLAMP_ADDRESSMODE;
        t.wrapV = Texture.CLAMP_ADDRESSMODE;
        t.hasAlpha = true;
        const f = BILLBOARD_ATLAS_INFO.frames.glow;
        t.uScale = BILLBOARD_ATLAS_INFO.cellWidthPx / BILLBOARD_ATLAS_INFO.widthPx;
        t.uOffset = (f * BILLBOARD_ATLAS_INFO.cellWidthPx) / BILLBOARD_ATLAS_INFO.widthPx;
        t.vScale = 1;
        t.vOffset = 0;
        if (t.isReady()) {
            resolve(t);
        } else {
            t.onLoadObservable.addOnce(() => resolve(t));
        }
    });

    const planeMat = new StandardMaterial("billboardMat", scene);
    planeMat.diffuseTexture = atlasTex;
    planeMat.useAlphaFromDiffuseTexture = true;
    planeMat.transparencyMode = Constants.MATERIAL_ALPHABLEND;
    planeMat.backFaceCulling = false;
    planeMat.disableLighting = true;
    planeMat.emissiveColor = new Color3(1, 1, 1);
    planeMat.diffuseColor = new Color3(0, 0, 0);
    planeMat.specularColor = new Color3(0, 0, 0);

    const planes: { mesh: Mesh; pos: Vector3 }[] = [];
    for (let i = 0; i < BILLBOARD_SCENE_LAYOUT.sprites.length; i++) {
        const s = BILLBOARD_SCENE_LAYOUT.sprites[i]!;
        const plane = MeshBuilder.CreatePlane(`b${i}`, { width: s.sizeWorld[0], height: s.sizeWorld[1] }, scene);
        plane.material = planeMat;
        plane.position.set(s.position[0], s.position[1], s.position[2]);
        plane.rotationQuaternion = Quaternion.Identity();
        planes.push({ mesh: plane, pos: plane.position.clone() });
    }

    // Facing basis: right/up extracted directly from the camera's world
    // matrix columns — identical to `Sprite3DSceneUBO`'s updater, which is
    // the source of `scene.cameraRight` / `scene.cameraUp` consumed by
    // Lite's facing-billboard vertex shader.
    const tmpRight = new Vector3();
    const tmpUp = new Vector3();
    const tmpFwd = new Vector3();
    const basisMat = new Matrix();
    function updateBillboards(): void {
        const wm = cam.getWorldMatrix().m;
        tmpRight.set(wm[0]!, wm[1]!, wm[2]!);
        tmpUp.set(wm[4]!, wm[5]!, wm[6]!);
        // fwd = cross(right, up) — guarantees right-handed orthonormal basis
        // with the plane normal pointing toward the camera.
        Vector3.CrossToRef(tmpRight, tmpUp, tmpFwd);
        Matrix.FromXYZAxesToRef(tmpRight, tmpUp, tmpFwd, basisMat);
        for (const { mesh } of planes) {
            Quaternion.FromRotationMatrixToRef(basisMat, mesh.rotationQuaternion!);
        }
    }

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    let frameCounter = 0;
    const targetFrames = Math.round(seekTime * 60);
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
        updateBillboards();
        frameCounter++;
        if (frameCounter === targetFrames + 1) {
            canvas.dataset.animationFrozen = "true";
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));

    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
