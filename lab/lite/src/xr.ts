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
    enableXrCompatibleAdapter,
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
    pointerSelection,
    controllerModels,
    readXrController,
    mat4Compose,
    mat4Invert,
    mat4Multiply,
    mat4Decompose,
    type Mat4,
    type Mesh,
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

/** A grabbable cube: its mesh plus the material we tint while it is held. */
interface Grabbable {
    mesh: Mesh;
    material: ReturnType<typeof createStandardMaterial>;
    baseEmissive: [number, number, number];
}

/** How close (metres) a controller grip must be to a cube's centre to grab it. */
const GRAB_RADIUS = 0.22;
const GRAB_RADIUS_SQ = GRAB_RADIUS * GRAB_RADIUS;
/** Emissive tint applied to a held cube so the grab is visually obvious. */
const GRAB_HIGHLIGHT: [number, number, number] = [0.35, 0.3, 0.05];

const grabbables: Grabbable[] = [];
/** Cubes currently held, so two controllers never grab the same one. */
const heldMeshes = new Set<Mesh>();
/** Per input-source hold: the cube and its rigid offset in the grip's local frame. */
const held = new Map<XRInputSource, { grabbable: Grabbable; offset: Mat4 }>();

/** Compose a mesh's local TRS into a world matrix (grabbables are unparented). */
function meshWorldMatrix(mesh: Mesh): Mat4 {
    const p = mesh.position,
        q = mesh.rotationQuaternion,
        s = mesh.scaling;
    return mat4Compose(p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z);
}

function releaseGrab(source: XRInputSource): void {
    const current = held.get(source);
    if (!current) {
        return;
    }
    current.grabbable.material.emissiveColor = current.grabbable.baseEmissive;
    heldMeshes.delete(current.grabbable.mesh);
    held.delete(source);
}

/**
 * Per-frame grab update. While a controller squeezes (grip) near a cube, the cube
 * is rigidly parented to the grip pose: we capture
 * `offset = inverse(grip) · cubeWorld` at grab time, then each frame set
 * `cubeWorld = grip · offset` so translation *and* rotation follow the hand.
 */
function updateGrab(ctx: XrSessionContext): void {
    if (!ctx.input) {
        return;
    }
    const live = new Set<XRInputSource>();
    for (const w of ctx.input.inputSources) {
        live.add(w.source);
        const grabbing = w.squeezing && w.gripTracked;
        const current = held.get(w.source);

        if (!grabbing) {
            releaseGrab(w.source);
            continue;
        }

        if (current) {
            const world = mat4Multiply(w.gripMatrix as unknown as Mat4, current.offset);
            const d = mat4Decompose(world);
            current.grabbable.mesh.position.set(d.translation.x, d.translation.y, d.translation.z);
            current.grabbable.mesh.rotationQuaternion.set(d.rotation.x, d.rotation.y, d.rotation.z, d.rotation.w);
            continue;
        }

        // Not holding yet: grab the nearest free cube within reach of the grip.
        const gx = w.gripMatrix[12]!,
            gy = w.gripMatrix[13]!,
            gz = w.gripMatrix[14]!;
        let best: Grabbable | null = null;
        let bestDist = GRAB_RADIUS_SQ;
        for (const g of grabbables) {
            if (heldMeshes.has(g.mesh)) {
                continue;
            }
            const dx = g.mesh.position.x - gx,
                dy = g.mesh.position.y - gy,
                dz = g.mesh.position.z - gz;
            const dist = dx * dx + dy * dy + dz * dz;
            if (dist < bestDist) {
                bestDist = dist;
                best = g;
            }
        }
        if (best) {
            const inv = mat4Invert(w.gripMatrix as unknown as Mat4);
            if (inv) {
                held.set(w.source, { grabbable: best, offset: mat4Multiply(inv, meshWorldMatrix(best.mesh)) });
                heldMeshes.add(best.mesh);
                best.material.emissiveColor = GRAB_HIGHLIGHT;
            }
        }
    }
    // A controller that disconnected mid-grab won't appear above — release it.
    for (const source of held.keys()) {
        if (!live.has(source)) {
            releaseGrab(source);
        }
    }
}

function setStatus(html: string): void {
    state.lastMessage = html;
    statusEl.innerHTML = html;
}

/** @internal Previous-frame pressed state per source, for button rising-edge detection. */
const prevPressed = new Map<XRInputSource, { a: boolean; b: boolean; stick: boolean }>();

/**
 * Read each controller's xr-standard buttons/axes and surface them on the status
 * line — a live demo of {@link readXrController}. Fires on face-button / thumbstick
 * press edges and on a strong thumbstick deflection, so it doesn't fight the grab
 * status every frame.
 */
function readControllers(ctx: XrSessionContext): void {
    if (!ctx.input) {
        return;
    }
    for (const w of ctx.input.inputSources) {
        const c = readXrController(w);
        if (!c) {
            continue;
        }
        const a = c.buttonA?.pressed ?? false;
        const b = c.buttonB?.pressed ?? false;
        const stick = c.thumbstick?.pressed ?? false;
        const prev = prevPressed.get(w.source) ?? { a: false, b: false, stick: false };
        if (a && !prev.a) {
            setStatus(`${c.handedness} controller: A/X pressed`);
        } else if (b && !prev.b) {
            setStatus(`${c.handedness} controller: B/Y pressed`);
        } else if (stick && !prev.stick) {
            setStatus(`${c.handedness} controller: thumbstick pressed`);
        } else if (c.thumbstickAxes && Math.hypot(c.thumbstickAxes[0], c.thumbstickAxes[1]) > 0.6) {
            setStatus(`${c.handedness} thumbstick: ${c.thumbstickAxes[0].toFixed(2)}, ${c.thumbstickAxes[1].toFixed(2)}`);
        }
        prevPressed.set(w.source, { a, b, stick });
    }
}

let session: XrSessionContext | null = null;

/** Map a picked mesh back to its grabbable so pointer-selection can tint it. */
function grabbableOf(mesh: Mesh): Grabbable | undefined {
    return grabbables.find((g) => g.mesh === mesh);
}

/** Flash a cube's emissive to acknowledge a remote (laser) trigger select. */
function pulseSelect(mesh: Mesh): void {
    const g = grabbableOf(mesh);
    if (!g || heldMeshes.has(mesh)) {
        return;
    }
    g.material.emissiveColor = GRAB_HIGHLIGHT;
    setStatus("Pointer: selected a cube.");
    setTimeout(() => {
        if (!heldMeshes.has(mesh)) {
            g.material.emissiveColor = g.baseEmissive;
        }
    }, 300);
}

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
            // Controller laser + cursor via the opt-in feature: aim at a cube and pull
            // the trigger to select it. The session drives + disposes it for us.
            features: [
                pointerSelection({
                    onHoverStart: (mesh) => {
                        const g = grabbableOf(mesh);
                        if (g && !heldMeshes.has(mesh)) {
                            g.material.emissiveColor = GRAB_HIGHLIGHT;
                        }
                    },
                    onHoverEnd: (mesh) => {
                        const g = grabbableOf(mesh);
                        if (g && !heldMeshes.has(mesh)) {
                            g.material.emissiveColor = g.baseEmissive;
                        }
                    },
                    onSelect: (mesh) => pulseSelect(mesh),
                }),
                // Real WebXR Input Profiles controller models loaded from the
                // registry CDN, with buttons/trigger/thumbstick animated from live
                // gamepad state (Babylon.js parity). Falls back to a handle box while
                // a model loads or if the source has no known profile / is offline.
                controllerModels({ profiles: true }),
            ],
            onFrame: (ctx) => {
                updateGrab(ctx);
                readControllers(ctx);
            },
            onEnd: () => {
                session = null;
                state.inSession = false;
                exitBtn.disabled = true;
                prevPressed.clear();
                for (const source of [...held.keys()]) {
                    releaseGrab(source);
                }
                setStatus(`Exited ${mode}.`);
            },
        });
        state.inSession = true;
        exitBtn.disabled = false;
        setStatus(`In <strong>${mode}</strong> session. Aim a controller — the laser highlights a cube; pull the trigger to select, or reach in and grip to grab.`);
    } catch (e) {
        state.error = String(e);
        setStatus(`Failed to enter ${mode}: <code>${String(e)}</code>`);
    }
}

async function run(): Promise<void> {
    try {
        // XR needs an XR-compatible GPU adapter; opt in before creating the engine.
        enableXrCompatibleAdapter();
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.4, 2.2, { x: 0, y: 1.15, z: -0.5 });
        addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

        // Five small cubes in a shallow arc directly in front, at roughly chest
        // height and within arm's reach, so they can be grabbed in the headset.
        // (WebXR local-floor: origin on the floor, forward is −Z, up is +Y.)
        for (let i = 0; i < 5; i++) {
            const box = createBox(engine, 0.16);
            box.name = `box-${i}`;
            const mat = createStandardMaterial();
            const baseEmissive: [number, number, number] = [0, 0, 0];
            mat.diffuseColor = [0.3 + i * 0.12, 0.5, 0.9 - i * 0.1];
            mat.emissiveColor = baseEmissive;
            box.material = mat;
            const angle = (i / 4 - 0.5) * 1.2; // −0.6…0.6 rad across the front
            box.position.set(Math.sin(angle) * 0.5, 1.1 + (i % 2) * 0.15, -Math.cos(angle) * 0.5);
            addToScene(scene, box);
            grabbables.push({ mesh: box, material: mat, baseEmissive });
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
