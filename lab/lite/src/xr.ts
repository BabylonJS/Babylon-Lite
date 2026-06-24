/**
 * WebXR (WebGPU binding) lab demo — forward-looking.
 *
 * The WebXR/WebGPU binding (`XRGPUBinding`) is a draft spec that no browser ships
 * yet, so the Enter VR / Enter AR buttons feature-detect and report gracefully.
 * The moment a UA implements the binding, the same code drives a real session.
 *
 * Exposes `window.__xrDemo` so Playwright (or a curious user) can read the
 * detected support state without entering a headset.
 */

import {
    createEngine,
    startEngine,
    createSceneContext,
    createArcRotateCamera,
    createHemisphericLight,
    createBox,
    createStandardMaterial,
    addToScene,
    registerScene,
    isWebXrPresent,
    isWebGpuXrSupported,
    isXrSessionSupported,
    enterXr,
    exitXr,
    type XrSessionContext,
    type XrSessionMode,
} from "babylon-lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const enterVrBtn = document.getElementById("enterVr") as HTMLButtonElement;
const enterArBtn = document.getElementById("enterAr") as HTMLButtonElement;
const exitBtn = document.getElementById("exitXr") as HTMLButtonElement;

interface XrDemoState {
    ready: boolean;
    webxrPresent: boolean;
    webgpuBinding: boolean;
    vrSupported: boolean;
    arSupported: boolean;
    inSession: boolean;
    lastMessage: string;
    error: string | null;
}

const state: XrDemoState = {
    ready: false,
    webxrPresent: false,
    webgpuBinding: false,
    vrSupported: false,
    arSupported: false,
    inSession: false,
    lastMessage: "",
    error: null,
};
(window as unknown as { __xrDemo: XrDemoState }).__xrDemo = state;

function setStatus(html: string): void {
    state.lastMessage = html;
    statusEl.innerHTML = html;
}

let session: XrSessionContext | null = null;

async function startSession(mode: XrSessionMode, scene: Parameters<typeof enterXr>[0]): Promise<void> {
    if (session) {
        return;
    }
    const supported = await isXrSessionSupported(mode);
    if (!supported) {
        setStatus(
            `<strong>${mode}</strong> is not available yet.<br />` +
                `The WebXR/WebGPU binding (<code>XRGPUBinding</code>) is a draft spec that no browser implements today. ` +
                `This demo is wired and ready for the moment it lands.`,
        );
        return;
    }
    try {
        session = await enterXr(scene, {
            mode,
            input: {
                onSelect: () => setStatus(`${mode}: select`),
                onSqueeze: () => setStatus(`${mode}: squeeze`),
            },
            onEnd: () => {
                session = null;
                state.inSession = false;
                exitBtn.disabled = true;
                setStatus(`Exited ${mode}.`);
            },
        });
        state.inSession = true;
        exitBtn.disabled = false;
        setStatus(`In <strong>${mode}</strong> session. Put on your headset.`);
    } catch (e) {
        state.error = String(e);
        setStatus(`Failed to enter ${mode}: <code>${String(e)}</code>`);
    }
}

async function run(): Promise<void> {
    try {
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.4, 6, { x: 0, y: 1, z: 0 });
        addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

        for (let i = 0; i < 5; i++) {
            const box = createBox(engine, 0.6);
            box.name = `box-${i}`;
            const mat = createStandardMaterial();
            mat.diffuseColor = [0.3 + i * 0.12, 0.5, 0.9 - i * 0.1];
            box.material = mat;
            const angle = (i / 5) * Math.PI * 2;
            box.position.set(Math.cos(angle) * 2, 1, Math.sin(angle) * 2);
            addToScene(scene, box);
        }

        await registerScene(scene);
        await startEngine(engine);

        // Feature detection.
        state.webxrPresent = isWebXrPresent();
        state.webgpuBinding = isWebGpuXrSupported();
        state.vrSupported = await isXrSessionSupported("immersive-vr");
        state.arSupported = await isXrSessionSupported("immersive-ar");
        state.ready = true;

        enterVrBtn.disabled = false;
        enterArBtn.disabled = false;
        enterVrBtn.addEventListener("click", () => void startSession("immersive-vr", scene));
        enterArBtn.addEventListener("click", () => void startSession("immersive-ar", scene));
        exitBtn.addEventListener("click", () => {
            if (session) {
                void exitXr(session);
            }
        });

        if (!state.webxrPresent) {
            setStatus("WebXR is not available in this browser (<code>navigator.xr</code> missing).");
        } else if (!state.webgpuBinding) {
            setStatus(
                "WebXR is present, but the <strong>WebGPU binding</strong> " +
                    "(<code>XRGPUBinding</code>) is not implemented by any browser yet. " +
                    "The buttons are wired and will work the moment it ships.",
            );
        } else {
            setStatus(
                `Ready. VR: <strong>${state.vrSupported ? "supported" : "no"}</strong>, ` +
                    `AR: <strong>${state.arSupported ? "supported" : "no"}</strong>.`,
            );
        }
    } catch (e) {
        state.error = String(e);
        setStatus(`Demo failed to start: <code>${String(e)}</code>`);
    }
}

void run();
