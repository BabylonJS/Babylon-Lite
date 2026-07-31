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

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.14, g: 0.14, b: 0.16, a: 1.0 };

    const container = await loadGltf(engine, "https://models.babylonjs.com/shark.glb");
    addToScene(scene, container);

    const mesh = findSkinned(container.entities[0] as TransformNode);
    const groups = container.animationGroups;

    let handle: VatHandle | null = null;
    let swim: VatClip | null = null;
    if (mesh && groups?.length) {
        const baked = bakeVat(engine, mesh, groups);
        handle = attachVat(engine, mesh, baked, "swimming");
        swim = baked.clips["swimming"] ?? null;

        // ONE thin-instance at identity → the instanced VAT path runs, and finalWorld = mesh.world * skin
        // (same as scene 218). setInstances BEFORE registerScene so the instance texture exists when the
        // bind group is built.
        setThinInstances(mesh, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 1);
        if (swim) {
            // Free-running playback: fps = the clip's fps so handle.update() advances the frame each
            // frame. (?seekTime overrides this in onBeforeRender with a frozen, fps=0 params set.)
            handle.setInstances(new Float32Array([swim.fromRow, swim.fromRow + swim.frameCount - 1, 0, swim.fps]));
        }
    }

    const cam = createDefaultCamera(scene);
    cam.alpha = 0; // side view, matching scene 218 / scene 11
    cam.beta = Math.PI / 2.2;
    attachControl(cam, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // ?seekTime freezes the instance at the exact baked frame seekTime*60, matching the BJS live oracle.
    const seekTimeParam = parseFloat(new URLSearchParams(location.search).get("seekTime") || "");
    const freezing = seekTimeParam >= 0;
    let frameCount = 0;
    let last = performance.now();
    onBeforeRender(scene, () => {
        frameCount++;
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (freezing) {
            if (frameCount === 10 && handle && swim) {
                handle.setInstances(new Float32Array([swim.fromRow, swim.fromRow + swim.frameCount - 1, Math.round(seekTimeParam * 60), 0]));
                handle.update(0);
                canvas.dataset.animationFrozen = "true";
            }
            return; // frozen pose — never advance the clock
        }
        handle?.update(dt);
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
