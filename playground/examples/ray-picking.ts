/**
 * Ray Picking — click a box to select it using Lite's synchronous CPU AABB picker.
 */
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createPickingRay,
    createSceneContext,
    createSolidTexture2D,
    createStandardMaterial,
    getViewProjectionMatrix,
    pickWithRay,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.025, g: 0.035, b: 0.06, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, 1.15, 8, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0], 1));

    const boxes = [-2, 0, 2].map((x, index) => {
        const box = createBox(engine, 1.4);
        box.name = `box-${index + 1}`;
        box.position.x = x;
        box.material = createStandardMaterial({
            diffuseTexture: createSolidTexture2D(engine, 0.15 + index * 0.2, 0.55, 0.85 - index * 0.2),
        });
        addToScene(scene, box);
        return box;
    });

    canvas.addEventListener("pointerdown", (event) => {
        const rect = canvas.getBoundingClientRect();
        const x = ((event.clientX - rect.left) * canvas.width) / rect.width;
        const y = ((event.clientY - rect.top) * canvas.height) / rect.height;
        const ray = createPickingRay(x, y, getViewProjectionMatrix(camera, canvas.width / canvas.height), canvas.width, canvas.height);
        if (!ray) {
            return;
        }
        const hit = pickWithRay(scene, ray);
        for (const box of boxes) {
            box.scaling.set(box === hit.pickedMesh ? 1.3 : 1, box === hit.pickedMesh ? 1.3 : 1, box === hit.pickedMesh ? 1.3 : 1);
        }
    });

    await registerScene(scene);
    await startEngine(engine);
}

void main().catch((error) => console.error(error));
