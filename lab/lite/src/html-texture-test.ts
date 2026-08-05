/**
 * HTML-in-Canvas texture demo — renders TWO interactable HTML pages as live
 * WebGPU textures on 3D planes, proving multi-texture support for the opt-in
 * `createHtmlTexture` feature.
 *
 *  • Panel A "Color Studio" — click the R/G/B rows to mix a colour; the mix
 *    drives the scene background in real time (HTML → 3D).
 *  • Panel B "Click Reactor" — +/- buttons drive a counter that recolours and
 *    spins a torus-knot (HTML → 3D).
 *
 * Interaction works on both the native path (Chrome with
 * chrome://flags/#canvas-draw-element) and the SVG `<foreignObject>` fallback
 * used by normal Chrome: a pointer tap is GPU-picked, mapped to the panel's
 * local UV, converted to element pixels, dispatched to the panel, and the
 * texture is re-rasterised via `requestHtmlTextureUpdate`.
 */

import {
    createEngine,
    startEngine,
    createSceneContext,
    createArcRotateCamera,
    attachControl,
    setCameraLimits,
    createHemisphericLight,
    createDirectionalLight,
    createPlane,
    createGround,
    createTorusKnot,
    createStandardMaterial,
    addToScene,
    registerScene,
    onBeforeRender,
    createGpuPicker,
    pickAsync,
    createHtmlTexture,
    requestHtmlTextureUpdate,
    isHtmlInCanvasSupported,
} from "babylon-lite";
import type { HtmlTexture2D } from "babylon-lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

const TEX_W = 512;
const TEX_H = 384;
const PLANE_W = 3.2;
const PLANE_H = PLANE_W * (TEX_H / TEX_W);

/** Shared state written by the HTML panels, read by the 3D render loop. */
const reactor = { count: 0 };

interface Panel {
    mesh: ReturnType<typeof createPlane>;
    tex: HtmlTexture2D;
    yaw: number;
    /** Called with element-local pixel coords of a tap. */
    hit: (ex: number, ey: number) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small DOM helpers (inline styles only — most portable across the native path
// and the SVG `<foreignObject>` fallback rasteriser).
// ─────────────────────────────────────────────────────────────────────────────

function el(tag: string, css: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    node.style.cssText = css;
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function hslToRgb01(h: number, s: number, l: number): [number, number, number] {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [r + m, g + m, b + m];
}

const PANEL_ROOT_CSS =
    `position:relative;box-sizing:border-box;width:${TEX_W}px;height:${TEX_H}px;` +
    `overflow:hidden;font-family:'Segoe UI',system-ui,sans-serif;color:#eef2ff;` +
    `border-radius:18px;`;

// ─────────────────────────────────────────────────────────────────────────────
// Panel A — Color Studio (drives scene.clearColor)
// ─────────────────────────────────────────────────────────────────────────────

interface ColorStudio {
    element: HTMLElement;
    hit: (ex: number, ey: number) => void;
    getColor: () => [number, number, number];
}

function buildColorStudio(onChange: () => void): ColorStudio {
    const rgb: [number, number, number] = [80, 150, 235];
    const channels: Array<{ name: string; accent: string; top: number }> = [
        { name: "R", accent: "#f38ba8", top: 78 },
        { name: "G", accent: "#a6e3a1", top: 160 },
        { name: "B", accent: "#89b4fa", top: 242 },
    ];

    // Row layout in element-pixel space (the panel renders at exactly TEX_W×TEX_H,
    // so these px values map 1:1 to the tapped `ex`). Shared by the CSS below and the
    // hit-test — derived, never measured, so it works on the SVG-fallback path too
    // (a hosted <canvas> child is never laid out, so offsetLeft/offsetWidth are 0).
    const ROW_L = 24;
    const ROW_W = 464;
    const PAD = 18;
    const CHIP = 38;
    const GAP = 16;
    const VAL_W = 56;
    const TRACK_L = ROW_L + PAD + CHIP + GAP;
    const TRACK_W = ROW_W - 2 * PAD - CHIP - 2 * GAP - VAL_W;

    const root = el(
        "div",
        PANEL_ROOT_CSS + "background:linear-gradient(160deg,#1e1b4b 0%,#0f172a 60%,#020617 100%);padding:0;"
    );

    root.appendChild(
        el(
            "div",
            "position:absolute;top:0;left:0;width:100%;height:64px;display:flex;align-items:center;" +
                "padding:0 24px;box-sizing:border-box;font-size:26px;font-weight:700;letter-spacing:0.5px;",
            "🎨 Color Studio"
        )
    );

    const bars: HTMLElement[] = [];
    const values: HTMLElement[] = [];
    channels.forEach((ch, i) => {
        const row = el(
            "div",
            `position:absolute;left:${ROW_L}px;top:${ch.top}px;width:${ROW_W}px;height:64px;` +
                `border-radius:14px;background:rgba(255,255,255,0.05);box-sizing:border-box;padding:0 ${PAD}px;` +
                `display:flex;align-items:center;gap:${GAP}px;`
        );
        row.appendChild(
            el(
                "div",
                `width:${CHIP}px;height:${CHIP}px;flex:0 0 ${CHIP}px;border-radius:10px;background:${ch.accent};color:#0b1020;` +
                    "display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px;",
                ch.name
            )
        );
        const track = el(
            "div",
            "position:relative;flex:1 1 auto;height:14px;border-radius:8px;background:rgba(255,255,255,0.12);overflow:hidden;"
        );
        const fill = el("div", `position:absolute;left:0;top:0;height:100%;width:0%;background:${ch.accent};`);
        track.appendChild(fill);
        row.appendChild(track);
        const val = el("div", `flex:0 0 ${VAL_W}px;text-align:right;font-variant-numeric:tabular-nums;font-size:22px;font-weight:600;`, "0");
        row.appendChild(val);
        root.appendChild(row);
        bars[i] = fill;
        values[i] = val;
    });

    const swatch = el(
        "div",
        "position:absolute;left:24px;top:318px;width:52px;height:44px;border-radius:12px;border:2px solid rgba(255,255,255,0.25);"
    );
    root.appendChild(swatch);
    const hex = el(
        "div",
        "position:absolute;left:92px;top:318px;height:44px;display:flex;align-items:center;font-size:24px;font-weight:600;letter-spacing:1px;font-family:'Consolas',monospace;"
    );
    root.appendChild(hex);
    root.appendChild(
        el(
            "div",
            "position:absolute;right:24px;top:326px;font-size:13px;opacity:0.6;text-align:right;line-height:1.35;",
            "tap along a bar →"
        )
    );

    function redraw(): void {
        const toHex = (n: number): string => n.toString(16).padStart(2, "0");
        for (let i = 0; i < 3; i++) {
            bars[i]!.style.width = `${(rgb[i]! / 255) * 100}%`;
            values[i]!.textContent = String(rgb[i]);
        }
        const css = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        swatch.style.background = css;
        hex.textContent = `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`.toUpperCase();
    }

    function hit(ex: number, ey: number): void {
        let idx = -1;
        for (let i = 0; i < channels.length; i++) {
            const top = channels[i]!.top;
            if (ey >= top - 6 && ey <= top + 70) {
                idx = i;
                break;
            }
        }
        if (idx < 0) {
            return;
        }
        // Positional select: map the tapped element-pixel X across the track's span to
        // 0–255. The span is derived from the layout constants (not measured), so it is
        // identical on the native and SVG-fallback paths.
        const t = Math.min(1, Math.max(0, (ex - TRACK_L) / TRACK_W));
        rgb[idx] = Math.round(t * 255);
        redraw();
        onChange();
    }

    redraw();
    return { element: root, hit, getColor: () => [rgb[0]!, rgb[1]!, rgb[2]!] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel B — Click Reactor (drives the torus-knot)
// ─────────────────────────────────────────────────────────────────────────────

interface ClickReactor {
    element: HTMLElement;
    hit: (ex: number, ey: number) => void;
}

function buildClickReactor(onChange: () => void): ClickReactor {
    const root = el("div", PANEL_ROOT_CSS + "background:radial-gradient(120% 120% at 50% 0%,#312e81 0%,#0b1120 70%);");

    root.appendChild(
        el(
            "div",
            "position:absolute;top:0;left:0;width:100%;height:64px;display:flex;align-items:center;justify-content:center;" +
                "font-size:26px;font-weight:700;letter-spacing:0.5px;",
            "🚀 Click Reactor"
        )
    );

    const number = el(
        "div",
        "position:absolute;top:74px;left:0;width:100%;height:120px;display:flex;align-items:center;justify-content:center;" +
            "font-size:104px;font-weight:800;font-variant-numeric:tabular-nums;text-shadow:0 6px 30px rgba(129,140,248,0.55);",
        "0"
    );
    root.appendChild(number);

    const status = el(
        "div",
        "position:absolute;top:200px;left:0;width:100%;height:44px;display:flex;align-items:center;justify-content:center;gap:10px;font-size:22px;opacity:0.9;",
        "🌱 warming up"
    );
    root.appendChild(status);

    const btnCss =
        "position:absolute;top:262px;width:224px;height:104px;border-radius:16px;display:flex;align-items:center;" +
        "justify-content:center;font-size:56px;font-weight:800;box-sizing:border-box;";
    const minus = el("div", btnCss + "left:16px;background:rgba(243,139,168,0.22);border:2px solid rgba(243,139,168,0.6);color:#f8c8d4;", "−");
    const plus = el("div", btnCss + "left:272px;background:rgba(166,227,161,0.22);border:2px solid rgba(166,227,161,0.6);color:#cdf3c8;", "+");
    root.appendChild(minus);
    root.appendChild(plus);

    function moodFor(n: number): string {
        if (n <= 0) return "🌱 warming up";
        if (n < 5) return "✨ nice";
        if (n < 10) return "🔥 heating up";
        if (n < 20) return "⚡ energised";
        return "🌟 maxed out";
    }

    function redraw(): void {
        number.textContent = String(reactor.count);
        status.textContent = moodFor(reactor.count);
        const hue = (200 + reactor.count * 18) % 360;
        root.style.background = `radial-gradient(120% 120% at 50% 0%,hsl(${hue} 70% 32%) 0%,#0b1120 70%)`;
    }

    function hit(ex: number, ey: number): void {
        if (ey >= 256) {
            if (ex < TEX_W / 2) {
                reactor.count = Math.max(0, reactor.count - 1);
            } else {
                reactor.count += 1;
            }
        } else {
            reactor.count += 1;
        }
        redraw();
        onChange();
    }

    redraw();
    return { element: root, hit };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene
// ─────────────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.clearColor = { r: 0.04, g: 0.05, b: 0.09, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 8.5, { x: 0, y: 0.2, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    setCameraLimits(camera, {
        lowerRadiusLimit: 5,
        upperRadiusLimit: 16,
        lowerBetaLimit: 0.35,
        upperBetaLimit: Math.PI - 0.35,
    });

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.75));
    addToScene(scene, createDirectionalLight([-0.4, -1, 0.6], 0.7));

    // Reflective-ish dark floor for depth.
    const ground = createGround(engine, { width: 40, height: 40 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.05, 0.06, 0.1];
    groundMat.specularColor = [0.12, 0.14, 0.2];
    ground.material = groundMat;
    ground.position.y = -PLANE_H / 2 - 0.4;
    addToScene(scene, ground);

    // Decorative torus-knot driven by the Click Reactor.
    const knot = createTorusKnot(engine, { radius: 0.5, tube: 0.16, radialSegments: 24, tubularSegments: 128 });
    const knotMat = createStandardMaterial();
    knotMat.diffuseColor = [0.1, 0.1, 0.14];
    knotMat.emissiveColor = [0.2, 0.35, 0.9];
    knot.material = knotMat;
    knot.position.y = PLANE_H / 2 + 1.15;
    addToScene(scene, knot);

    // ── Build the two interactive HTML panels ──
    const studio = buildColorStudio(() => {
        const [r, g, b] = studio.getColor();
        scene.clearColor = { r: (r / 255) * 0.45, g: (g / 255) * 0.45, b: (b / 255) * 0.45, a: 1 };
    });
    const reactorPanel = buildClickReactor(() => {
        const hue = (200 + reactor.count * 18) % 360;
        knotMat.emissiveColor = hslToRgb01(hue, 0.7, 0.55);
    });

    const panels: Panel[] = [];
    const layout: Array<{ src: { element: HTMLElement; hit: (ex: number, ey: number) => void }; x: number }> = [
        { src: studio, x: -(PLANE_W / 2 + 0.35) },
        { src: reactorPanel, x: PLANE_W / 2 + 0.35 },
    ];

    for (const { src, x } of layout) {
        // Dark bezel behind the panel (farther from the -Z camera → +Z).
        const bezel = createPlane(engine, { width: PLANE_W + 0.28, height: PLANE_H + 0.28 });
        const bezelMat = createStandardMaterial();
        bezelMat.diffuseColor = [0.02, 0.02, 0.03];
        bezelMat.emissiveColor = [0.02, 0.02, 0.04];
        bezelMat.disableLighting = true;
        bezelMat.backFaceCulling = false;
        bezel.material = bezelMat;
        bezel.position.x = x;
        bezel.position.y = 0.2;
        bezel.position.z = 0.06;
        addToScene(scene, bezel);

        const plane = createPlane(engine, { width: PLANE_W, height: PLANE_H });
        plane.position.x = x;
        plane.position.y = 0.2;

        const tex = createHtmlTexture(engine, src.element, { width: TEX_W, height: TEX_H });
        const mat = createStandardMaterial();
        mat.emissiveTexture = tex;
        mat.emissiveColor = [0, 0, 0];
        mat.disableLighting = true;
        mat.backFaceCulling = false;
        plane.material = mat;
        addToScene(scene, plane);

        panels.push({ mesh: plane, tex, yaw: 0, hit: src.hit });
    }

    // Gentle idle spin for the knot; reactor count boosts the speed.
    let last = performance.now();
    onBeforeRender(scene, () => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const speed = 0.4 + reactor.count * 0.12;
        knot.rotation.y += speed * dt;
        knot.rotation.x += speed * 0.4 * dt;
    });

    await registerScene(scene);
    await startEngine(engine);

    // Let a few frames render so the GPU picker's resources are ready.
    for (let i = 0; i < 5; i++) {
        await new Promise((r) => requestAnimationFrame(r));
    }
    const picker = createGpuPicker(scene);

    // ── Pointer interaction: tap a panel to interact, drag to orbit ──
    let downX = 0;
    let downY = 0;
    canvas.addEventListener("pointerdown", (e) => {
        downX = e.clientX;
        downY = e.clientY;
    });
    canvas.addEventListener("pointerup", async (e) => {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) {
            return; // treated as an orbit drag
        }
        const rect = canvas.getBoundingClientRect();
        const info = await pickAsync(picker, e.clientX - rect.left, e.clientY - rect.top);
        if (!info.hit || !info.pickedMesh || !info.pickedPoint) {
            return;
        }
        const panel = panels.find((p) => p.mesh === info.pickedMesh);
        if (!panel) {
            return;
        }
        // World hit point → plane-local (undo the panel's Y yaw) → UV → element pixels.
        const cx = panel.mesh.position.x;
        const cy = panel.mesh.position.y;
        const cz = panel.mesh.position.z;
        const wx = info.pickedPoint[0] - cx;
        const wy = info.pickedPoint[1] - cy;
        const wz = info.pickedPoint[2] - cz;
        const cos = Math.cos(panel.yaw);
        const sin = Math.sin(panel.yaw);
        const localX = wx * cos - wz * sin;
        const localY = wy;
        const u = Math.min(1, Math.max(0, localX / PLANE_W + 0.5));
        const v = Math.min(1, Math.max(0, localY / PLANE_H + 0.5));
        panel.hit(u * TEX_W, (1 - v) * TEX_H);
        requestHtmlTextureUpdate(engine, panel.tex);
    });

    (window as unknown as { __htmlTextureDemo: unknown }).__htmlTextureDemo = {
        native: isHtmlInCanvasSupported(engine),
        panels: panels.length,
    };
    canvas.dataset.ready = "true";
}

run().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    canvas.dataset.ready = "true";
});
