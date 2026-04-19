// Reference scene 33 — Babylon.js anchored animated + cutout sprites.
//
// Two SpriteManagers: an alpha-blended animated layer (manual cellIndex
// driven by a deterministic `?seekTime=`) and a cutout-style layer with
// depth writes enabled. Per-frame distance scaling keeps anchored sprites
// at fixed pixel size, matching Lite.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import "@babylonjs/core/Materials/standardMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";
import { CUTOUT_ATLAS_INFO, getCutoutAtlasDataUrl } from "../_shared/sprite-cutout-atlas";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false });
    await engine.initAsync();

    const seekParam = new URLSearchParams(location.search).get("seekTime");
    const seekTime = seekParam !== null ? parseFloat(seekParam) : 0.5;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.03, 0.04, 0.06, 1);

    const cam = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.4, 7, new Vector3(0, 0.4, 0), scene);
    cam.fov = Math.PI / 4;
    cam.minZ = 0.1;
    cam.maxZ = 50;

    new HemisphericLight("light", new Vector3(0, 1, 0), scene).intensity = 0.95;

    const groundMat = new StandardMaterial("gmat", scene);
    groundMat.diffuseColor = new Color3(0.3, 0.32, 0.38);
    const ground = MeshBuilder.CreateGround("ground", { width: 8, height: 8 }, scene);
    ground.material = groundMat;

    const matA = new StandardMaterial("ma", scene);
    matA.diffuseColor = new Color3(0.85, 0.3, 0.25);
    const boxA = MeshBuilder.CreateBox("ba", { size: 0.7 }, scene);
    boxA.material = matA;
    boxA.position.set(-1.4, 0.35, 0);

    const matB = new StandardMaterial("mb", scene);
    matB.diffuseColor = new Color3(0.25, 0.55, 0.85);
    const boxB = MeshBuilder.CreateBox("bb", { size: 0.7 }, scene);
    boxB.material = matB;
    boxB.position.set(1.4, 0.35, -0.4);

    const url = getCutoutAtlasDataUrl();
    const cell = { width: CUTOUT_ATLAS_INFO.cellWidthPx, height: CUTOUT_ATLAS_INFO.cellHeightPx };

    // Layer A — alpha-blend animated.
    // epsilon=0 on both managers to avoid the 1% quad inset BJS applies by default.
    const alphaMgr = new SpriteManager("alpha", url, 8, cell, scene, 0);
    alphaMgr.renderingGroupId = 1;
    const alphaAnchors: Vector3[] = [new Vector3(-1.4, 1.0, 0), new Vector3(1.4, 1.0, -0.4), new Vector3(0, 1.4, 0)];
    const alphaSprites: Sprite[] = [];
    const phases: number[] = [];
    const msPerFrame = 1000 / CUTOUT_ATLAS_INFO.spinClip.fps;
    const frameCount = CUTOUT_ATLAS_INFO.spinClip.frames.length;
    for (let i = 0; i < alphaAnchors.length; i++) {
        const s = new Sprite(`a${i}`, alphaMgr);
        s.position.copyFrom(alphaAnchors[i]!);
        if (i === 2) {
            // Negate angle: Lite uses positive=CW (canvas2D convention), BJS
            // sprite.angle is positive=CCW. Flip sign here to match Lite.
            s.angle = -Math.PI / 4;
        }
        alphaSprites.push(s);
        // Lite's third sprite has +1 frame phase offset.
        phases.push(i === 2 ? msPerFrame : 0);
    }

    // Layer B — cutout (depth-write on, drawn before animated layer).
    const cutoutMgr = new SpriteManager("cutout", url, 4, cell, scene, 0);
    cutoutMgr.renderingGroupId = 0;
    cutoutMgr.disableDepthWrite = false;
    const cutoutAnchors: Vector3[] = [new Vector3(-0.6, 0.5, -1.2), new Vector3(0.6, 0.5, -1.2)];
    const cutoutFrames = [0, 2];
    const cutoutPickable = [true, false];
    const cutoutSprites: Sprite[] = [];
    for (let i = 0; i < cutoutAnchors.length; i++) {
        const s = new Sprite(`c${i}`, cutoutMgr);
        s.position.copyFrom(cutoutAnchors[i]!);
        s.cellIndex = cutoutFrames[i]!;
        s.isPickable = cutoutPickable[i]!;
        cutoutSprites.push(s);
    }

    // Per-frame: distance-based size + animated cellIndex from frozen seekTime.
    const targetSizePx = 80;
    const cutoutSizePx = 120;
    const targetFrames = Math.round(seekTime * 60);
    let frameCounter = 0;

    function updateSizes(): void {
        const tan = Math.tan(cam.fov * 0.5);
        // Use camera-space Z (view-space depth), not 3D distance: BJS's sprite
        // projection only uses cz for perspective divide. Per LookAtLHToRef,
        // world-forward = (m[2], m[6], m[10]) and translation_z = m[14].
        const vm = cam.getViewMatrix().m;
        const fx = vm[2]!, fy = vm[6]!, fz = vm[10]!, ft = vm[14]!;
        for (let i = 0; i < alphaSprites.length; i++) {
            const a = alphaAnchors[i]!;
            const cz = Math.abs(fx * a.x + fy * a.y + fz * a.z + ft);
            const worldPerPxY = (2 * cz * tan) / canvas.height;
            alphaSprites[i]!.size = targetSizePx * worldPerPxY;
        }
        for (let i = 0; i < cutoutSprites.length; i++) {
            const a = cutoutAnchors[i]!;
            const cz = Math.abs(fx * a.x + fy * a.y + fz * a.z + ft);
            const worldPerPxY = (2 * cz * tan) / canvas.height;
            cutoutSprites[i]!.size = cutoutSizePx * worldPerPxY;
        }
    }

    function setCellsForElapsed(elapsedMs: number): void {
        for (let i = 0; i < alphaSprites.length; i++) {
            const t = phases[i]! + elapsedMs;
            alphaSprites[i]!.cellIndex = Math.floor(t / msPerFrame) % frameCount;
        }
    }

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
        updateSizes();
        const advances = Math.min(frameCounter, targetFrames);
        setCellsForElapsed(advances * 16.667);
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

    // Picking smoke-test on the cutout sprites.
    const view = scene.getViewMatrix();
    const proj = scene.getProjectionMatrix();
    const vp = view.multiply(proj).m;
    function project(a: Vector3): [number, number] {
        const cx = vp[0]! * a.x + vp[4]! * a.y + vp[8]! * a.z + vp[12]!;
        const cy = vp[1]! * a.x + vp[5]! * a.y + vp[9]! * a.z + vp[13]!;
        const cw = vp[3]! * a.x + vp[7]! * a.y + vp[11]! * a.z + vp[15]!;
        return [((cx / cw) * 0.5 + 0.5) * canvas.width, (1 - ((cy / cw) * 0.5 + 0.5)) * canvas.height];
    }
    const [pxOk, pyOk] = project(cutoutAnchors[0]!);
    const [pxNo, pyNo] = project(cutoutAnchors[1]!);
    const hitOk = scene.pickSprite(pxOk, pyOk);
    const hitNo = scene.pickSprite(pxNo, pyNo);
    canvas.dataset.pickResults = JSON.stringify([
        { label: "pickable-cutout", expectedHit: true, hit: !!hitOk?.hit, idx: 0 },
        { label: "non-pickable-cutout", expectedHit: false, hit: !!hitNo?.hit, idx: 1 },
    ]);

    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
