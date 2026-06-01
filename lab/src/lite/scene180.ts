/** Scene 180 — TextRenderer demo. Standalone 2D text path: no scene, no camera.
 *  Live-editable textarea + sliders + canvas drag/wheel drive a `TextLayer`. */

import {
    createEngine,
    startEngine,
    loadFont,
    createDefaultTextDescriptor,
    updateDefaultTextDescriptor,
    createTextData,
    updateTextData,
    createTextLayer,
    createTextRenderer,
    registerTextRenderer,
} from "babylon-lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const textarea = document.getElementById("textInput") as HTMLTextAreaElement;
const rot = document.getElementById("rot") as HTMLInputElement;
const opacity = document.getElementById("opacity") as HTMLInputElement;
const rotVal = document.getElementById("rotVal")!;
const opacityVal = document.getElementById("opacityVal")!;

async function run(): Promise<void> {
    const engine = await createEngine(canvas);
    const font = await loadFont("/fonts/Inter.ttf");

    let desc = createDefaultTextDescriptor(font, textarea.value, 48, { maxWidth: 1200, align: "left" });
    const data = createTextData(desc);

    const layer = createTextLayer(data, {
        positionPx: { x: 360, y: 240 },
        scale: 1,
        rotationRad: 0,
        opacity: 1,
    });

    const tr = createTextRenderer(engine, {
        layers: [layer],
        clearValue: { r: 0.05, g: 0.06, b: 0.09, a: 1 },
    });
    registerTextRenderer(tr);

    textarea.addEventListener("input", () => {
        desc = updateDefaultTextDescriptor(desc, textarea.value);
        updateTextData(data, desc);
    });

    rot.addEventListener("input", () => {
        layer.rotationRad = (+rot.value * Math.PI) / 180;
        rotVal.textContent = rot.value + "°";
    });
    opacity.addEventListener("input", () => {
        layer.opacity = +opacity.value;
        opacityVal.textContent = (+opacity.value).toFixed(2);
    });

    // Drag-to-move (in CSS pixels — matches layer.positionPx units).
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener("pointerdown", (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.classList.add("dragging");
        canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
        if (!dragging) {
            return;
        }
        layer.positionPx.x += e.clientX - lastX;
        layer.positionPx.y += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
    });
    const endDrag = (e: PointerEvent): void => {
        if (!dragging) {
            return;
        }
        dragging = false;
        canvas.classList.remove("dragging");
        canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    // Wheel-to-scale, anchored at the cursor so the point under the mouse stays put.
    canvas.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            const factor = Math.exp(-e.deltaY * 0.001);
            const newScale = layer.scale * factor;
            const k = newScale / layer.scale;
            layer.positionPx.x = e.clientX + (layer.positionPx.x - e.clientX) * k;
            layer.positionPx.y = e.clientY + (layer.positionPx.y - e.clientY) * k;
            layer.scale = newScale;
        },
        { passive: false }
    );

    await startEngine(engine);
    canvas.dataset.ready = "true";
}

void run();
