/** Demo: live-editable orthographic-looking text driven by a <textarea>. */

import {
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    attachControl,
    registerScene,
    startEngine,
    loadFont,
    createDefaultTextData,
    updateDefaultTextData,
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
    const data = createDefaultTextData(font, 48, textarea.value, undefined, { maxWidth: 1200, align: "left" });
    const text = createTextRenderable(data, { opacity: 1 });
    const scale = 0.01;
    text.position.set(-data.width * scale * 0.5, data.height * scale * 0.5, 0);
    text.scaling.set(scale, scale, scale);
    addTextRenderable(scene, text);

    textarea.addEventListener("input", () => {
        updateDefaultTextData(data, textarea.value);
        text.position.set(-data.width * scale * 0.5, data.height * scale * 0.5, 0);
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

void run();
