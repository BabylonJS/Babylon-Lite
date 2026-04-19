// Reference scene 32 — Babylon.js anchored labels using SpriteManager with
// per-frame distance-based size adjustment to maintain a fixed pixel size,
// matching Lite's `AnchoredSpriteLayer` semantics.
//
// This is the canonical lightweight BJS pattern for HUD-style labels above
// 3D meshes (without depending on `@babylonjs/gui`). Each frame, every
// sprite's world `size` is recomputed from its distance to the camera so
// that its on-screen footprint stays constant in pixels.

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
import { getLabelAtlasDataUrl, LABEL_ATLAS_INFO } from "../_shared/sprite-label-atlas";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.06, 0.1, 1);

    const cam = new ArcRotateCamera("cam", -Math.PI / 2.2, Math.PI / 2.6, 14, new Vector3(0, 0.5, 3.5), scene);
    cam.fov = Math.PI / 4;
    cam.minZ = 0.1;
    cam.maxZ = 100;

    new HemisphericLight("light", new Vector3(0, 1, 0), scene).intensity = 0.95;

    const colors: [number, number, number][] = [
        [0.9, 0.25, 0.25],
        [0.25, 0.75, 0.35],
        [0.3, 0.5, 0.95],
        [0.95, 0.78, 0.2],
    ];
    const sizes = [1.0, 1.4, 0.8, 1.6];
    const zs = [0, 2.5, 5, 7.5];
    const anchors: Vector3[] = [];
    for (let i = 0; i < 4; i++) {
        const sz = sizes[i]!;
        const mat = new StandardMaterial(`m${i}`, scene);
        mat.diffuseColor = new Color3(colors[i]![0], colors[i]![1], colors[i]![2]);
        const box = MeshBuilder.CreateBox(`b${i}`, { size: sz }, scene);
        box.material = mat;
        box.position.x = -3 + i * 2;
        box.position.y = sz / 2;
        box.position.z = zs[i]!;
        anchors.push(new Vector3(box.position.x, box.position.y + sz / 2 + 0.1, box.position.z));
    }

    // epsilon=0 to avoid the 1% quad inset BJS applies by default.
    const mgr = new SpriteManager("labels", getLabelAtlasDataUrl(), 8, { width: LABEL_ATLAS_INFO.cellWidthPx, height: LABEL_ATLAS_INFO.cellHeightPx }, scene, 0);
    mgr.renderingGroupId = 1;
    const labels: Sprite[] = [];
    for (let i = 0; i < anchors.length; i++) {
        const s = new Sprite(`l${i}`, mgr);
        s.cellIndex = i;
        s.position.copyFrom(anchors[i]!);
        s.isPickable = i !== 2;
        labels.push(s);
    }

    // Maintain ~56-pixel size and a -32-pixel Y offset (in screen space)
    // by reprojecting each frame, matching the Lite scene's anchored layout.
    // IMPORTANT: apply the Y offset along the CAMERA's up vector (screen-up
    // mapped into world space), not along world-Y. With a tilted camera,
    // world-Y is not aligned with screen-Y, so a pure world-Y offset would
    // land sub-pixel off from Lite's clip-space offset — causing a ~1px
    // outline in the parity diff on every sprite.
    const targetSizePx = 56;
    const offsetPxY = -32;
    scene.onBeforeRenderObservable.add(() => {
        const tan = Math.tan(cam.fov * 0.5);
        // Extract camera-space axes in world coordinates from the view matrix.
        // Per BJS Matrix.LookAtLHToRef: world-up axis = (m[1], m[5], m[9]),
        // world-forward axis = (m[2], m[6], m[10]), translation = (m[12], m[13], m[14]).
        const vm = cam.getViewMatrix().m;
        const upX = vm[1]!, upY = vm[5]!, upZ = vm[9]!;
        const fx = vm[2]!, fy = vm[6]!, fz = vm[10]!, ft = vm[14]!;
        for (let i = 0; i < labels.length; i++) {
            const a = anchors[i]!;
            // Use camera-space Z (view-space depth), NOT 3D distance: BJS's
            // sprite projection uses cz for perspective divide. Using distance
            // would over-scale off-axis sprites vs Lite's clip-space sizing.
            const cz = Math.abs(fx * a.x + fy * a.y + fz * a.z + ft);
            const worldPerPxY = (2 * cz * tan) / canvas.height;
            labels[i]!.size = targetSizePx * worldPerPxY;
            // screen-down by offsetPxY pixels → world shift along -camUp * offsetPxY * worldPerPxY.
            // (offsetPxY is negative = screen-up → +camUp direction).
            const shift = -offsetPxY * worldPerPxY;
            labels[i]!.position.x = a.x + upX * shift;
            labels[i]!.position.y = a.y + upY * shift;
            labels[i]!.position.z = a.z + upZ * shift;
        }
    });

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));

    // Picking smoke-test via scene.pickSprite at each label's screen position.
    const results: { i: number; pickable: boolean; hit: boolean }[] = [];
    const tan = Math.tan(cam.fov * 0.5);
    const view = cam.getViewMatrix();
    const proj = scene.getProjectionMatrix();
    const vp = view.multiply(proj).m;
    const vm = view.m;
    const upX = vm[1]!, upY = vm[5]!, upZ = vm[9]!;
    const fx = vm[2]!, fy = vm[6]!, fz = vm[10]!, ft = vm[14]!;
    for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i]!;
        const cz = Math.abs(fx * a.x + fy * a.y + fz * a.z + ft);
        const worldPerPxY = (2 * cz * tan) / canvas.height;
        const shift = -offsetPxY * worldPerPxY;
        const wx = a.x + upX * shift;
        const wy = a.y + upY * shift;
        const wz = a.z + upZ * shift;
        const cx = vp[0]! * wx + vp[4]! * wy + vp[8]! * wz + vp[12]!;
        const cy = vp[1]! * wx + vp[5]! * wy + vp[9]! * wz + vp[13]!;
        const cw = vp[3]! * wx + vp[7]! * wy + vp[11]! * wz + vp[15]!;
        const sx = ((cx / cw) * 0.5 + 0.5) * canvas.width;
        const sy = (1 - ((cy / cw) * 0.5 + 0.5)) * canvas.height;
        const pick = scene.pickSprite(sx, sy);
        results.push({ i, pickable: i !== 2, hit: !!pick?.hit });
    }
    canvas.dataset.pickResults = JSON.stringify(results);

    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
