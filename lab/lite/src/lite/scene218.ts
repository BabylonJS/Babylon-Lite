// Scene 218 — VAT (Vertex Animation Texture)
//
// The shark from scene 11, but its skeletal animation is BAKED into a texture (bakeVat) and played
// through the GPU VAT vertex path (mesh.vat) with NO live CPU skeleton — the first step toward
// thin-instancing animated meshes. The whole skeleton update is gone; the vertex shader reads each bone
// matrix from the baked texture at the current animation frame row. Proves a baked skinned mesh renders +
// animates through the full PBR pipeline, with ZERO bundle cost for scenes that never bake a VAT
// (the baker + VAT shader fragment are dynamic-import chunks gated on `mesh.vat`).

import { onBeforeRender, addToScene, startEngine, createEngine, createSceneContext, createDefaultCamera, createHemisphericLight, loadGltf, attachControl, registerScene, bakeVat, attachVat } from "babylon-lite";
import type { TransformNode, Mesh, VatHandle } from "babylon-lite";

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

    // Bake every clip into one texture BEFORE registerScene (so the material composes the VAT vertex path),
    // then play the swimming clip from the baked texture. attachVat drops the live skeleton.
    let handle: VatHandle | null = null;
    if (mesh && groups.length > 0) {
        const baked = bakeVat(engine, mesh, groups);
        handle = attachVat(engine, mesh, baked, "swimming");
        canvas.dataset.vatBones = String(baked.boneCount);
        canvas.dataset.vatFrames = String(baked.frameCount);
        canvas.dataset.vatClips = Object.keys(baked.clips).join(",");
    }

    const cam = createDefaultCamera(scene);
    cam.alpha = 0; // side view, matching scene 11
    cam.beta = Math.PI / 2.2;
    attachControl(cam, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // Free-running playback advances the VAT clock each frame (the analogue of
    // BakedVertexAnimationManager.time). For parity, ?seekTime freezes the swimming clip at an exact baked
    // frame: fps=0 makes the frame row static at round(seekTime*60), matching the BJS live-skeleton oracle
    // posed at the same integer frame (VAT bakes that very pose at full precision).
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
            if (frameCount === 10 && !seekDone) {
                handle?.play("swimming", { offset: Math.round(seekTimeParam * 60), fps: 0 });
                handle?.update(0);
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
