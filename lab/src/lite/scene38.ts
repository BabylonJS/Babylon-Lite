// Scene 38 — Procedural Builders parity
// Demonstrates: cylinder (+ cone via diameterTop=0), plane, disc, ring
// (disc with arc<1), polyhedron (icosahedron), ribbon, tube, extruded shape.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createHemisphericLight,
    createDirectionalLight,
    createCylinder,
    createPlane,
    createDisc,
    createPolyhedron,
    createRibbon,
    createTube,
    createExtrudeShape,
    createStandardMaterial,
    registerScene,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 14, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.5;
    camera.farPlane = 1000;
    scene.camera = camera;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));
    const dir = createDirectionalLight([-0.5, -1, 0.3]);
    dir.diffuse = [0.9, 0.9, 0.9];
    addToScene(scene, dir);

    const mat = createStandardMaterial();
    mat.diffuseColor = [0.7, 0.7, 0.85];

    const col = (x: number, y: number, z: number) => {
        const m = createStandardMaterial();
        m.diffuseColor = [x, y, z];
        return m;
    };

    const cyl = createCylinder(engine, { height: 2, diameter: 1, tessellation: 24 });
    cyl.position.set(-6, 0, 0);
    cyl.material = col(0.8, 0.3, 0.3);
    addToScene(scene, cyl);

    const cone = createCylinder(engine, { height: 2, diameterTop: 0, diameterBottom: 1.2, tessellation: 24 });
    cone.position.set(-4, 0, 0);
    cone.material = col(0.9, 0.6, 0.2);
    addToScene(scene, cone);

    const plane = createPlane(engine, { size: 1.5 });
    plane.position.set(-2, 0, 0);
    plane.material = col(0.2, 0.7, 0.3);
    addToScene(scene, plane);

    const disc = createDisc(engine, { radius: 0.9, tessellation: 32 });
    disc.position.set(0, 0, 0);
    disc.material = col(0.3, 0.3, 0.85);
    addToScene(scene, disc);

    const ring = createDisc(engine, { radius: 0.9, tessellation: 48, arc: 0.7 });
    ring.position.set(2, 0, 0);
    ring.material = col(0.85, 0.3, 0.85);
    addToScene(scene, ring);

    const ico = createPolyhedron(engine, { type: 3, size: 0.8 });
    ico.position.set(4, 0, 0);
    ico.material = col(0.3, 0.85, 0.85);
    addToScene(scene, ico);

    // Ribbon — 3 parallel sinusoidal paths
    const ribbonPaths: { x: number; y: number; z: number }[][] = [];
    for (let p = 0; p < 3; p++) {
        const row: { x: number; y: number; z: number }[] = [];
        for (let i = 0; i < 16; i++) {
            const t = i / 15;
            row.push({
                x: t * 1.5 - 0.75,
                y: Math.sin(t * Math.PI * 2) * 0.15,
                z: (p - 1) * 0.3,
            });
        }
        ribbonPaths.push(row);
    }
    const ribbon = createRibbon(engine, { pathArray: ribbonPaths });
    ribbon.position.set(6, 0, 0);
    ribbon.material = col(0.85, 0.85, 0.3);
    addToScene(scene, ribbon);

    // Tube — helical path
    const tubePath: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 24; i++) {
        const t = i / 23;
        tubePath.push({
            x: Math.cos(t * Math.PI * 2) * 0.5,
            y: t * 1.5 - 0.75,
            z: Math.sin(t * Math.PI * 2) * 0.5,
        });
    }
    const tube = createTube(engine, { path: tubePath, radius: 0.1, tessellation: 16 });
    tube.position.set(-5, -2.5, 0);
    tube.material = col(0.5, 0.9, 0.5);
    addToScene(scene, tube);

    // Extruded shape — star cross-section swept along an arc path
    const starShape: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 0.25 : 0.12;
        const a = (i / 10) * Math.PI * 2;
        starShape.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, z: 0 });
    }
    starShape.push(starShape[0]!);
    const extrudePath: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 20; i++) {
        const t = i / 19;
        extrudePath.push({
            x: (t - 0.5) * 2,
            y: Math.sin(t * Math.PI) * 0.4,
            z: 0,
        });
    }
    const star = createExtrudeShape(engine, { shape: starShape, path: extrudePath, scale: 1, rotation: 0 });
    star.position.set(0, -2.5, 0);
    star.material = col(0.85, 0.5, 0.2);
    addToScene(scene, star);

    // Second extrusion — a simple square along a straight path for clearer parity.
    const squareShape = [
        { x: -0.2, y: -0.2, z: 0 },
        { x: 0.2, y: -0.2, z: 0 },
        { x: 0.2, y: 0.2, z: 0 },
        { x: -0.2, y: 0.2, z: 0 },
        { x: -0.2, y: -0.2, z: 0 },
    ];
    const straight: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 6; i++) straight.push({ x: (i / 5) * 1.5 - 0.75, y: 0, z: 0 });
    const bar = createExtrudeShape(engine, { shape: squareShape, path: straight, scale: 1, rotation: 0 });
    bar.position.set(5, -2.5, 0);
    bar.material = col(0.4, 0.4, 0.9);
    addToScene(scene, bar);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
