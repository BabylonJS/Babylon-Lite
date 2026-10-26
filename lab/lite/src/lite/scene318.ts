// Scene 318: glTF export of a textured sphere with two animated morph targets, reloaded and posed at frame 60 —
// matches Babylon.js playground #84M2SR#107 (visualization test "GLTF Serializer Morph Target Animation").
//
// The snippet passes `{ segments: 16, size: 2 }` to CreateSphere; `size` is not a sphere option, so the spheres keep the
// default diameter 1 and so does this page. The vertex noise comes from the visualization harness's seeded
// `Math.random`: Babylon.js has drawn 62 numbers by then (two geometry ids), so the generator below skips them.
//
// Deviations from the snippet (Lite has no public equivalent):
// - Morph targets are position/normal deltas (`createMorphTargets`), not absolute `MorphTarget.FromMesh` positions. The
//   deltas are the noisy / Y-stretched sphere minus the base sphere, with normals recomputed the way Babylon.js does it.
// - The snippet's two "influence" animations are not authored. The Lite exporter exports only glTF-clip animation groups;
//   natively authored animations (createPropertyAnimationGroup) are not exportable. So this test covers morph-target export
//   and reload, not morph-animation export. The weights of the frozen frame are applied directly after the reload: Babylon.js
//   reaches 1.25 for both targets (base 0.25 plus each additive clip's value at frame 60), written with `setMorphTargetWeights`.

import {
    addToScene,
    createDefaultCamera,
    createEngine,
    createHemisphericLight,
    createMorphTargets,
    createSceneContext,
    createSphere,
    createSphereData,
    createStandardMaterial,
    disposeScene,
    exportSceneAsGlb,
    loadGltf,
    loadTexture2D,
    registerScene,
    setMorphTargetWeights,
    startEngine,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";

const SPHERE_OPTIONS = { segments: 16 };
const NOISE_RANDOM_OFFSET = 62;
const INITIAL_INFLUENCE = 0.25;

/** The harness's `Math.random` (`sin(seed++) * 10000`, fractional part), started after `skip` numbers. */
function createSeededRandom(skip: number): () => number {
    let seed = 1 + skip;
    return () => {
        const x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    };
}

/** Per-vertex smooth normals from unit face normals, as Babylon.js's VertexData.ComputeNormals does. */
function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
    const normals = new Float32Array(positions.length);
    for (let f = 0; f < indices.length; f += 3) {
        const i1 = indices[f]! * 3;
        const i2 = indices[f + 1]! * 3;
        const i3 = indices[f + 2]! * 3;
        const ax = positions[i1]! - positions[i2]!;
        const ay = positions[i1 + 1]! - positions[i2 + 1]!;
        const az = positions[i1 + 2]! - positions[i2 + 2]!;
        const bx = positions[i3]! - positions[i2]!;
        const by = positions[i3 + 1]! - positions[i2 + 1]!;
        const bz = positions[i3 + 2]! - positions[i2 + 2]!;
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= length;
        ny /= length;
        nz /= length;
        for (const i of [i1, i2, i3]) {
            normals[i] = normals[i]! + nx;
            normals[i + 1] = normals[i + 1]! + ny;
            normals[i + 2] = normals[i + 2]! + nz;
        }
    }
    for (let i = 0; i < normals.length; i += 3) {
        const length = Math.sqrt(normals[i]! ** 2 + normals[i + 1]! ** 2 + normals[i + 2]! ** 2) || 1;
        normals[i] = normals[i]! / length;
        normals[i + 1] = normals[i + 1]! / length;
        normals[i + 2] = normals[i + 2]! / length;
    }
    return normals;
}

function subtract(a: Float32Array, b: Float32Array): Float32Array {
    return a.map((value, i) => value - b[i]!);
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    let scene = createSceneContext(engine);

    const sphere1 = createSphere(engine, SPHERE_OPTIONS);
    sphere1.name = "sphere1";
    const mat = createStandardMaterial();
    mat.diffuseTexture = await loadTexture2D(engine, "https://playground.babylonjs.com/textures/misc.jpg");
    sphere1.material = mat;

    // sphere2: every position element plus 0.2 * Math.random().
    const base = createSphereData(SPHERE_OPTIONS);
    const random = createSeededRandom(NOISE_RANDOM_OFFSET);
    const noisyPositions = base.positions.map((value) => value + 0.2 * random());
    // sphereYStretch: scaling (1, 3, 1) baked into the positions.
    const stretchedPositions = base.positions.map((value, i) => (i % 3 === 1 ? value * 3 : value));

    sphere1.morphTargets = createMorphTargets(
        engine,
        [
            { positions: subtract(noisyPositions, base.positions), normals: subtract(computeNormals(noisyPositions, base.indices), base.normals) },
            { positions: subtract(stretchedPositions, base.positions), normals: subtract(computeNormals(stretchedPositions, base.indices), base.normals) },
        ],
        base.vertexCount,
        [INITIAL_INFLUENCE, INITIAL_INFLUENCE]
    );
    addToScene(scene, sphere1);

    const glb = await exportSceneAsGlb(scene);
    disposeScene(scene);

    scene = createSceneContext(engine);
    const container = await loadGltf(engine, glb);
    addToScene(scene, container);
    addToScene(scene, createHemisphericLight());
    const camera = createDefaultCamera(scene);
    camera.radius *= 2;

    const loaded = scene.meshes.find((mesh: Mesh) => mesh.morphTargets) as Mesh;
    setMorphTargetWeights(engine, loaded.morphTargets!, [INITIAL_INFLUENCE + 1, INITIAL_INFLUENCE + 1]);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
