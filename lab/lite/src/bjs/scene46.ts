// Babylon.js reference — Scene 46: Physics constraints (playground #7DMWP8#693, labels removed)

import HavokPhysics from "@babylonjs/havok";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import {
    BallAndSocketConstraint,
    DistanceConstraint,
    HingeConstraint,
    LockConstraint,
    Physics6DoFConstraint,
    PrismaticConstraint,
    SliderConstraint,
} from "@babylonjs/core/Physics/v2/physicsConstraint";
import { PhysicsConstraintAxis, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";

let curX = -8;

function readCaptureAfterFrames(): number | null {
    const params = new URLSearchParams(window.location.search);
    const frameValue = params.get("captureFrame");
    if (frameValue !== null) {
        const frame = Number(frameValue);
        return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : null;
    }
    return null;
}

function colorFor(index: number): Color3 {
    return new Color3(((index * 83 + 37) & 255) / 255, ((index * 149 + 91) & 255) / 255, ((index * 211 + 53) & 255) / 255);
}

function addMat(mesh: Mesh, color: Color3): void {
    const material = new StandardMaterial(`mat-${mesh.name}`, mesh.getScene());
    material.diffuseColor = color;
    material.specularColor = new Color3(0.08, 0.08, 0.08);
    mesh.material = material;
}

function createBox(scene: Scene, name: string, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, color = colorFor(0)): Mesh {
    const mesh = MeshBuilder.CreateBox(name, { size: 1 }, scene);
    mesh.position.set(x, y, z);
    mesh.scaling.set(sx, sy, sz);
    addMat(mesh, color);
    return mesh;
}

function boxAggregate(mesh: Mesh, mass: number, scene: Scene): PhysicsAggregate {
    return new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass, restitution: 1 }, scene);
}

function ballAndSocket(scene: Scene): void {
    const col = colorFor(0);
    const box1 = createBox(scene, "ballAndSocketBox1", curX, 1, 0, 1, 0.2, 1, col);
    const box2 = createBox(scene, "ballAndSocketBox2", curX, 1, -1, 1, 0.2, 1, col);
    const agg1 = boxAggregate(box1, 0, scene);
    const agg2 = boxAggregate(box2, 1, scene);
    const joint = new BallAndSocketConstraint(new Vector3(-0.5, 0, -0.5), new Vector3(-0.5, 0, 0.5), new Vector3(0, 1, 0), new Vector3(0, 1, 0), scene);
    agg1.body.addConstraint(agg2.body, joint);
    curX += 2;
}

function distance(scene: Scene): void {
    const col = colorFor(1);
    const sphere = MeshBuilder.CreateSphere("distanceSphere1", { diameter: 1, segments: 5 }, scene);
    sphere.position.set(curX, 1, 0);
    addMat(sphere, col);
    const box = createBox(scene, "distanceBox1", curX, 1, -2, 1, 1, 1, col);
    const agg1 = new PhysicsAggregate(sphere, PhysicsShapeType.SPHERE, { mass: 0, restitution: 0.9 }, scene);
    const agg2 = boxAggregate(box, 1, scene);
    const joint = new DistanceConstraint(2, scene);
    agg1.body.addConstraint(agg2.body, joint);
    curX += 2;
}

function hinge(scene: Scene): void {
    const col = colorFor(2);
    const box1 = createBox(scene, "hingeBox1", curX, 1, 0, 1, 0.2, 1, col);
    const box2 = createBox(scene, "hingeBox2", curX, 1, -1, 1, 0.2, 1, col);
    const agg1 = boxAggregate(box1, 0, scene);
    const agg2 = boxAggregate(box2, 1, scene);
    const joint = new HingeConstraint(new Vector3(0, 0, -0.5), new Vector3(0, 0, 0.5), new Vector3(1, 0, 0), new Vector3(1, 0, 0), scene);
    agg1.body.addConstraint(agg2.body, joint);
    curX += 2;
}

function prismatic(scene: Scene, sliderMode = false): void {
    const col = colorFor(sliderMode ? 5 : 3);
    const box1 = createBox(scene, sliderMode ? "sliderBox1" : "prismaticBox1", curX, 0, 0, 0.2, 3, 0.2, col);
    const box2 = createBox(scene, sliderMode ? "sliderBox2" : "prismaticBox2", curX, 1.5, -0.2, 0.2, 0.5, 0.2, col);
    const box3 = createBox(scene, sliderMode ? "sliderBase" : "prismaticBase", curX, -1.5, 0, 1.5, 0.1, 1.5, col);
    const agg1 = boxAggregate(box1, 0, scene);
    const agg2 = boxAggregate(box2, 1, scene);
    boxAggregate(box3, 0, scene);
    const joint = sliderMode
        ? new SliderConstraint(new Vector3(0, 0, -0.2), new Vector3(0, 0, 0.25), new Vector3(0, 1, 0), new Vector3(0, 1, 0), scene)
        : new PrismaticConstraint(new Vector3(0, 0, -0.2), new Vector3(0, 0, 0.25), new Vector3(0, 1, 0), new Vector3(0, 1, 0), scene);
    agg1.body.addConstraint(agg2.body, joint);
    curX += 2;
}

function locked(scene: Scene): void {
    const col = colorFor(4);
    const box1 = createBox(scene, "fixedBox1", curX, 0, 0, 1, 1, 1, col);
    const box2 = createBox(scene, "fixedBox2", curX, 0, -2, 1, 1, 1, col);
    const agg1 = boxAggregate(box1, 0, scene);
    const agg2 = boxAggregate(box2, 1, scene);
    const joint = new LockConstraint(new Vector3(0.5, 0.5, -0.5), new Vector3(-0.5, -0.5, 0.5), new Vector3(0, 1, 0), new Vector3(0, 1, 0), scene);
    agg1.body.addConstraint(agg2.body, joint);
    curX += 2;
}

function sixdof(scene: Scene): void {
    const col = colorFor(6);
    const box1 = createBox(scene, "sixdofBox1", curX, 0, 0, 1, 1, 1, col);
    const box2 = createBox(scene, "sixdofBox2", curX, 1.5, -0.2, 1, 1, 1, col);
    const agg1 = boxAggregate(box1, 0, scene);
    const agg2 = boxAggregate(box2, 1, scene);
    const joint = new Physics6DoFConstraint(
        { pivotA: new Vector3(0, -0.5, 0), pivotB: new Vector3(0, 0.5, 0), perpAxisA: new Vector3(1, 0, 0), perpAxisB: new Vector3(1, 0, 0) },
        [{ axis: PhysicsConstraintAxis.LINEAR_DISTANCE, minLimit: 1, maxLimit: 2 }],
        scene
    );
    agg1.body.addConstraint(agg2.body, joint);
    curX += 2;
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();
    const captureAfterFrames = readCaptureAfterFrames();

    curX = -8;
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);
    const plugin = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    scene.enablePhysics(new Vector3(0, -10, 0), new HavokPlugin(false, plugin));

    const camera = new FreeCamera("camera1", new Vector3(0, 4, -24), scene);
    camera.setTarget(Vector3.Zero());
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light1", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;
    const light2 = new HemisphericLight("light2", new Vector3(0, -1, 0), scene);
    light2.intensity = 0.2;

    ballAndSocket(scene);
    distance(scene);
    hinge(scene);
    prismatic(scene);
    locked(scene);
    prismatic(scene, true);
    sixdof(scene);

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });

    let ready = false;
    let simulatedFrames = 0;
    let captureQueued = false;
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
        const now = performance.now();
        if (!ready) {
            ready = true;
            canvas.dataset.initMs = String(now - __initStart);
            canvas.dataset.ready = "true";
        } else {
            simulatedFrames++;
        }
        if (captureAfterFrames !== null && !captureQueued && simulatedFrames >= captureAfterFrames) {
            captureQueued = true;
            canvas.dataset.captureReady = "true";
            window.setTimeout(() => engine.stopRenderLoop(), 0);
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
