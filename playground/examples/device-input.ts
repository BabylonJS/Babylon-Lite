/** WASD and a standard gamepad move the box; primary drag looks around it. */
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createKeyboardInput,
    createPointerInput,
    createSceneContext,
    createStandardMaterial,
    disposeKeyboardInput,
    disposePointerInput,
    isKeyboardKeyDown,
    onBeforeRender,
    onSceneDispose,
    readGamepad,
    registerScene,
    resetPointerInput,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.tabIndex = 0;
    canvas.style.touchAction = "none";
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    const camera = createArcRotateCamera(-Math.PI / 2, 1.1, 8, { x: 0, y: 0.5, z: 0 });
    scene.camera = camera;
    // The camera still owns secondary-button pan and wheel zoom. Primary look is app-owned.
    const detachCamera = attachControl(camera, canvas, scene, { shouldHandlePointerDown: (event) => event.button !== 0 });
    const keyboard = createKeyboardInput(canvas);
    const pointer = createPointerInput(canvas);
    const focus = (): void => canvas.focus();
    canvas.addEventListener("pointerdown", focus);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1));
    const box = createBox(engine, 1);
    box.position.y = 0.5;
    const material = createStandardMaterial();
    material.diffuseColor = [0.9, 0.35, 0.15];
    box.material = material;
    addToScene(scene, box);
    const ground = createGround(engine, { width: 20, height: 20 });
    const groundMaterial = createStandardMaterial();
    groundMaterial.diffuseColor = [0.15, 0.2, 0.25];
    ground.material = groundMaterial;
    addToScene(scene, ground);

    onBeforeRender(scene, (deltaMs) => {
        const pad = readGamepad();
        const axes = pad?.mapping === "standard" ? pad.axes : [];
        const deadZone = (value: number): number => (Math.abs(value) < 0.15 ? 0 : value);
        const x = Number(isKeyboardKeyDown(keyboard, "KeyD")) - Number(isKeyboardKeyDown(keyboard, "KeyA")) + deadZone(axes[0] ?? 0);
        const z = Number(isKeyboardKeyDown(keyboard, "KeyW")) - Number(isKeyboardKeyDown(keyboard, "KeyS")) - deadZone(axes[1] ?? 0);
        const step = (Math.min(deltaMs, 50) * 0.003) / Math.max(1, Math.hypot(x, z));
        box.position.x += x * step;
        box.position.z += z * step;
        camera.target.x = box.position.x;
        camera.target.z = box.position.z;
        if (pointer.buttons & 1) {
            camera.alpha -= pointer.deltaX / 300;
            camera.beta = Math.max(0.1, Math.min(Math.PI - 0.1, camera.beta - pointer.deltaY / 300));
        }
        resetPointerInput(pointer);
    });
    onSceneDispose(scene, () => {
        disposeKeyboardInput(keyboard);
        disposePointerInput(pointer);
        detachCamera();
        canvas.removeEventListener("pointerdown", focus);
    });
    await registerScene(scene);
    await startEngine(engine);
}
void main().catch((error) => console.error(error));
