/**
 * Spinning Polyhedra — a ring of six solids orbiting a central
 * pillar, each tumbling on its own axis while the whole carousel rotates. Pure
 * procedural geometry and standard materials, so it loads instantly with no
 * external assets — a compact tour of the mesh factories and the per-frame
 * `onBeforeRender` hook.
 */
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createCylinder,
    createDirectionalLight,
    createGround,
    createHemisphericLight,
    createPolyhedron,
    createSceneContext,
    createStandardMaterial,
    createEngine,
    onBeforeRender,
    registerScene,
    startEngine,
    type Mesh,
} from "@babylonjs/lite";

// Polyhedron preset indices (see createPolyhedron docs) and a brand-ish palette.
const SOLIDS = [0, 1, 2, 3, 4, 7];
const COLORS: [number, number, number][] = [
    [0.86, 0.27, 0.29], // red
    [0.88, 0.41, 0.29], // coral
    [0.95, 0.77, 0.35], // amber
    [0.35, 0.72, 0.55], // green
    [0.31, 0.55, 0.86], // blue
    [0.6, 0.45, 0.85], // violet
];

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.04, g: 0.05, b: 0.08, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, 1.05, 12, { x: 0, y: 0.8, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.6));
    addToScene(scene, createDirectionalLight([-0.5, -1, -0.4], 1.2));

    // Dark reflective-ish floor.
    const ground = createGround(engine, { width: 24, height: 24 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.12, 0.14, 0.18];
    groundMat.specularColor = [0.05, 0.05, 0.05];
    ground.material = groundMat;
    ground.position.set(0, -1.4, 0);
    addToScene(scene, ground);

    // Central pillar the ring revolves around.
    const pillar = createCylinder(engine, { height: 2.6, diameter: 0.5, tessellation: 32 });
    const pillarMat = createStandardMaterial();
    pillarMat.diffuseColor = [0.5, 0.52, 0.58];
    pillarMat.specularColor = [0.6, 0.6, 0.6];
    pillar.material = pillarMat;
    pillar.position.set(0, 0.1, 0);
    addToScene(scene, pillar);

    const radius = 4;
    const solids: { mesh: Mesh; spin: number }[] = [];
    for (let i = 0; i < SOLIDS.length; i++) {
        const mesh = createPolyhedron(engine, { type: SOLIDS[i]!, size: 0.7 });
        const mat = createStandardMaterial();
        mat.diffuseColor = COLORS[i % COLORS.length]!;
        mat.specularColor = [0.4, 0.4, 0.4];
        mesh.material = mat;
        mesh.position.set(0, 0.6, 0);
        addToScene(scene, mesh);
        solids.push({ mesh, spin: 0.6 + i * 0.18 });
    }

    let t = 0;
    onBeforeRender(scene, (deltaMs) => {
        const dt = deltaMs / 1000;
        t += dt;
        for (let i = 0; i < solids.length; i++) {
            const { mesh, spin } = solids[i]!;
            const angle = t * 0.4 + (i / solids.length) * Math.PI * 2;
            mesh.position.set(Math.cos(angle) * radius, 0.6 + Math.sin(t * 1.5 + i) * 0.35, Math.sin(angle) * radius);
            mesh.rotation.set(t * spin, t * spin * 1.3, 0);
        }
    });

    await registerScene(scene);
    await startEngine(engine);
}

void main().catch((err) => console.error(err));
