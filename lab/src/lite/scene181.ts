/** Demo: live-editable orthographic-looking text driven by a <textarea>. */

import {
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    attachControl,
    registerScene,
    startEngine,
    loadFont,
    createDefaultTextDescriptor,
    updateDefaultTextDescriptor,
    createTextData,
    updateTextData,
    createTextRenderable,
    addTextRenderable,
} from "babylon-lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const textarea = document.getElementById("textInput") as HTMLTextAreaElement;

async function run(): Promise<void> {
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Arc-rotate camera initially looking straight at the text (alpha = -PI/2,
    // beta = PI/2). attachControl enables drag-to-rotate, right-drag-to-pan,
    // wheel-to-zoom on the canvas itself.
    const camera = (scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 12, { x: 0, y: 0, z: 0 }));
    attachControl(camera, canvas, scene);

    const font = await loadFont("/fonts/Inter.ttf");
    let desc = createDefaultTextDescriptor(font, textarea.value, 48, { maxWidth: 1200, align: "left" });
    const data = createTextData(desc);
    const text = createTextRenderable(data, { color: [1, 1, 1, 1] });
    text.position.set(-desc.width * 0.005, desc.height * 0.005, 0);
    text.scaling.set(0.01, 0.01, 0.01);
    addTextRenderable(scene, text);

    textarea.addEventListener("input", () => {
        desc = updateDefaultTextDescriptor(desc, textarea.value);
        updateTextData(data, desc);
        text.position.set(-desc.width * 0.005, desc.height * 0.005, 0);
    });

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

void run();
