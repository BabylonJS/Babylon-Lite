// Havok physics — a brick wall demolished by a barrage of cannonballs.
//
// Stacks a wall of dynamic boxes on a static floor, then fires a heavy sphere at
// it every few seconds, launching each one with an initial velocity so the wall
// progressively collapses. Orbit with the mouse to watch from any angle.
import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyLinearVelocity,
    startEngine,
} from "@babylonjs/lite";

const WALL_COLS = 9;
const WALL_ROWS = 6;
const BALL_INTERVAL_MS = 2600;
const MAX_BALLS = 14;

function brickColor(row: number, col: number): [number, number, number] {
    const warm = (row + col) % 2 === 0;
    return warm ? [0.78, 0.33, 0.24] : [0.86, 0.5, 0.27];
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2.4, 1.15, 26, { x: 0, y: 2.5, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));
    addToScene(scene, createDirectionalLight([-0.4, -1, -0.5], 1.1));

    const havok = await HavokPhysics({
        locateFile: () => "https://esm.sh/@babylonjs/havok/lib/esm/HavokPhysics.wasm",
    });
    const world = createHavokWorld(scene, havok, { x: 0, y: -9.81, z: 0 });

    // Static floor (mass 0). Explicit extents — the collision box does not inherit
    // the node's visual scaling.
    const floor = createBox(engine, 1);
    floor.scaling.set(40, 1, 40);
    floor.position.set(0, -0.5, 0);
    const floorMat = createStandardMaterial();
    floorMat.diffuseColor = [0.16, 0.18, 0.22];
    floor.material = floorMat;
    addToScene(scene, floor);
    createPhysicsAggregate(world, floor, PhysicsShapeType.BOX, { mass: 0, friction: 0.6, extents: { x: 40, y: 1, z: 40 } });

    // A wall of unit-cube bricks (auto-sized collision shapes — no scaling).
    for (let row = 0; row < WALL_ROWS; row++) {
        for (let col = 0; col < WALL_COLS; col++) {
            const brick = createBox(engine, 1);
            brick.position.set((col - (WALL_COLS - 1) / 2) * 1.02, 0.5 + row * 1.02, 0);
            const mat = createStandardMaterial();
            mat.diffuseColor = brickColor(row, col);
            mat.specularColor = [0.05, 0.05, 0.05];
            brick.material = mat;
            addToScene(scene, brick);
            createPhysicsAggregate(world, brick, PhysicsShapeType.BOX, { mass: 1, friction: 0.5, restitution: 0.1 });
        }
    }

    // Fire a heavy cannonball at the wall on a timer.
    let fired = 0;
    let timer = 0;
    const fire = (): void => {
        if (fired >= MAX_BALLS) {
            window.clearInterval(timer);
            return;
        }
        fired++;
        const ball = createSphere(engine, { diameter: 1.8, segments: 20 });
        const offsetX = (Math.random() - 0.5) * 6;
        ball.position.set(offsetX, 2.2, -22);
        const mat = createStandardMaterial();
        mat.diffuseColor = [0.15, 0.16, 0.2];
        mat.specularColor = [0.4, 0.4, 0.4];
        ball.material = mat;
        addToScene(scene, ball);
        const { body } = createPhysicsAggregate(world, ball, PhysicsShapeType.SPHERE, { mass: 12, restitution: 0.2 });
        setPhysicsBodyLinearVelocity(world, body, { x: -offsetX * 0.4, y: 2.5, z: 34 });
    };

    await registerScene(scene);
    await startEngine(engine);

    timer = window.setInterval(fire, BALL_INTERVAL_MS);
    window.setTimeout(fire, 800);
}

main().catch((err) => console.error(err));
