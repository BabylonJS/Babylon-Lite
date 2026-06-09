// Scene 219 — Per-instance VAT (instanced baked animation, one draw call)
//
// The scene-11 shark, baked to a VAT texture (bakeVat) and GPU thin-instanced into a grid. Each instance
// plays the swimming clip at its OWN random phase via handle.setInstances() — one (fromRow,toRow,offset,fps)
// vec4 per instance in a small texture the VAT vertex path reads by instance_index. The whole crowd renders
// in a single draw call with no live CPU skeletons — proving animated meshes can be GPU-instanced through VAT.

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
    scene.clearColor = { r: 0.1, g: 0.12, b: 0.18, a: 1.0 };

    const container = await loadGltf(engine, "https://models.babylonjs.com/shark.glb");
    addToScene(scene, container);

    const root = container.entities[0] as TransformNode;
    const mesh = findSkinned(root);
    const groups = container.animationGroups ?? [];

    const GRID = 6;
    const N = GRID * GRID;
    const SPACING = 14;
    let handle: VatHandle | null = null;

    if (mesh && groups.length > 0) {
        // Bake every clip BEFORE registerScene, then thin-instance the baked shark + give each instance its
        // own phase. attachVat drops the live skeleton; setInstances selects the MSH_VAT_INSTANCED variant.
        const baked = bakeVat(engine, mesh, groups);
        handle = attachVat(engine, mesh, baked, "swimming");

        // Grid of instance world matrices (column-major: scale on the diagonal, translation in column 3).
        const matrices = new Float32Array(N * 16);
        for (let i = 0; i < N; i++) {
            const gx = (i % GRID) - (GRID - 1) / 2;
            const gz = Math.floor(i / GRID) - (GRID - 1) / 2;
            const o = i * 16;
            matrices[o] = 1;
            matrices[o + 5] = 1;
            matrices[o + 10] = 1;
            matrices[o + 15] = 1;
            matrices[o + 12] = gx * SPACING;
            matrices[o + 14] = gz * SPACING;
        }
        setThinInstances(mesh, matrices, N);

        // Per-instance DUAL-CLIP VAT: blend swimming<->circling, the blend weight sweeping across the grid
        // columns (left column = pure swim, right = pure circle), each instance at its own phase. Proves
        // smooth clip cross-fading under instancing — exactly what animal gait blending needs.
        const swim = baked.clips["swimming"]!;
        const circ = baked.clips["circling"] ?? swim;
        const params = new Float32Array(N * 8);
        for (let i = 0; i < N; i++) {
            const col = i % GRID;
            const blend = GRID > 1 ? col / (GRID - 1) : 0;
            const offset = Math.random() * swim.frameCount;
            const o = i * 8;
            params[o + 0] = swim.fromRow;
            params[o + 1] = swim.fromRow + swim.frameCount - 1;
            params[o + 2] = offset;
            params[o + 3] = swim.fps;
            params[o + 4] = circ.fromRow;
            params[o + 5] = circ.fromRow + circ.frameCount - 1;
            params[o + 6] = blend;
            params[o + 7] = circ.fps;
        }
        handle.setInstancesBlend(params);

        canvas.dataset.instances = String(N);
        canvas.dataset.vatBones = String(baked.boneCount);
        canvas.dataset.vatClips = Object.keys(baked.clips).join(",");
    }

    const cam = createDefaultCamera(scene);
    attachControl(cam, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.05));

    let last = performance.now();
    let frameCount = 0;
    onBeforeRender(scene, () => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        handle?.update(dt); // one shared clock advances the whole crowd; per-instance offsets stagger them
    });

    await registerScene(engine, scene);
    // Frame the whole grid (set after registerScene so it isn't overridden by content auto-framing).
    cam.alpha = 0.85;
    cam.beta = 1.0;
    cam.radius = GRID * SPACING * 1.7;
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
