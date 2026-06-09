// Scene 219 — Per-instance VAT parity.
//
// The scene-11 shark, baked to a VAT texture and rendered through the PER-INSTANCE VAT path (one GPU
// thin-instance), frozen at an integer frame via ?seekTime. The instanced path computes
//   finalWorld = instanceMatrix * mesh.world * skin
// so with an IDENTITY instance matrix it equals the non-instanced scene-218 pose exactly — and therefore
// must match the Babylon.js live-skeleton golden. This validates the instanced VAT shader (per-instance
// frame read from the instance texture by @builtin(instance_index), the thin-instance world placement, and
// the dual-clip blend path with blend=0) against ground truth — no skipParity.

import {
    onBeforeRender,
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createDefaultCamera,
    createHemisphericLight,
    loadGltf,
    attachControl,
    registerScene,
    bakeVat,
    attachVat,
    setThinInstances,
} from "babylon-lite";
import type { TransformNode, Mesh, VatHandle, VatClip } from "babylon-lite";

/** Depth-first search for the first mesh in a node tree that carries a skeleton. */
function findSkinned(node: TransformNode): Mesh | null {
    const m = node as unknown as Mesh;
    if (m.skeleton) {
        return m;
    }
    for (const c of (node.children ?? []) as TransformNode[]) {
        const hit = findSkinned(c);
        if (hit) {
            return hit;
        }
    }
    return null;
}

/** Per-instance params for one instance frozen at clip-frame `frame` (fps 0 → static at that frame). */
function frozenParams(swim: VatClip, frame: number): Float32Array {
    return new Float32Array([swim.fromRow, swim.fromRow + swim.frameCount - 1, frame, 0]);
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.14, g: 0.14, b: 0.16, a: 1.0 };

    const container = await loadGltf(engine, "https://models.babylonjs.com/shark.glb");
    addToScene(scene, container);

    const root = container.entities[0] as TransformNode;
    const mesh = findSkinned(root);
    const groups = container.animationGroups ?? [];

    let handle: VatHandle | null = null;
    let swim: VatClip | null = null;
    if (mesh && groups.length > 0) {
        const baked = bakeVat(engine, mesh, groups);
        handle = attachVat(engine, mesh, baked, "swimming");
        swim = baked.clips["swimming"] ?? null;

        // ONE thin-instance at identity → the instanced VAT path runs, and finalWorld = mesh.world * skin
        // (same as scene 218). setInstances BEFORE registerScene so the instance texture exists when the
        // bind group is built.
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        setThinInstances(mesh, identity, 1);
        if (swim) {
            // Free-running playback: fps = the clip's fps so handle.update() advances the frame each
            // frame. (?seekTime overrides this in onBeforeRender with a frozen, fps=0 params set.)
            handle.setInstances(new Float32Array([swim.fromRow, swim.fromRow + swim.frameCount - 1, 0, swim.fps]));
        }
        canvas.dataset.vatBones = String(baked.boneCount);
        canvas.dataset.vatFrames = String(baked.frameCount);
    }

    const cam = createDefaultCamera(scene);
    cam.alpha = 0; // side view, matching scene 218 / scene 11
    cam.beta = Math.PI / 2.2;
    attachControl(cam, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // ?seekTime freezes the instance at the exact baked frame seekTime*60, matching the BJS live oracle.
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    const freezing = !isNaN(seekTimeParam) && seekTimeParam >= 0;
    let frameCount = 0;
    let seekDone = false;
    let last = performance.now();
    onBeforeRender(scene, () => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (freezing) {
            if (frameCount === 10 && !seekDone && handle && swim) {
                handle.setInstances(frozenParams(swim, Math.round(seekTimeParam * 60)));
                handle.update(0);
                seekDone = true;
                canvas.dataset.animationFrozen = "true";
            }
            return; // frozen pose — never advance the clock
        }
        handle?.update(dt);
    });

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
