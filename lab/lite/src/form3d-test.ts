/**
 * 3D form controls, backed by a real HTML `<form>`.
 *
 * Each control on screen is built from Babylon Lite meshes and animated with a
 * small spring/tween engine — but the *state* lives in the native `<form>` in
 * the top-right corner (the real source of truth):
 *
 *   • Click a 3D control  → mutate the matching native input + dispatch `change`.
 *   • A single `change`   → re-read the form and animate every 3D control to match.
 *   • Click a native input → same `change` path animates the 3D. Two-way binding.
 *   • Submit the form     → the 3D button reacts and the readout serialises FormData.
 *
 * So the 3D layer is a skin: real, submittable, keyboard-accessible HTML underneath,
 * modern 3D presentation on top. Nothing here ships in the engine bundle — it is a
 * lab demo built entirely from the public Babylon Lite API.
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
    createBox,
    createSphere,
    createDisc,
    createTorus,
    createCapsule,
    createCylinder,
    createPlane,
    createGround,
    createStandardMaterial,
    setStandardEmissiveTexture,
    setStandardOpacityTexture,
    createDynamicTexture,
    updateDynamicTexture,
    addToScene,
    registerScene,
    onBeforeRender,
    createGpuPicker,
    pickAsync,
    markMaterialUboDirty,
} from "babylon-lite";

type Mesh = ReturnType<typeof createBox>;
type Mat = ReturnType<typeof createStandardMaterial>;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const form = document.getElementById("realForm") as HTMLFormElement;
const readout = document.getElementById("readout") as HTMLDivElement;

// Accent palette (linear-ish values look good through the emissive path).
const ACCENT: [number, number, number] = [0.36, 0.62, 1.0]; // blue
const GOOD: [number, number, number] = [0.42, 0.9, 0.62]; // green
const IDLE: [number, number, number] = [0.09, 0.11, 0.17]; // slate

// ─────────────────────────────────────────────────────────────────────────────
// Tween engine — named numeric channels eased toward targets each frame.
// Re-targeting a live channel is seamless (it eases from wherever it is now), so
// rapid clicks never snap. easeOutBack gives controls a springy "pop".
// ─────────────────────────────────────────────────────────────────────────────

type Ease = (t: number) => number;
const easeOutCubic: Ease = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic: Ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack: Ease = (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

interface Channel {
    value: number;
    from: number;
    to: number;
    elapsed: number;
    dur: number;
    ease: Ease;
    apply: (v: number) => void;
}
const channels = new Map<string, Channel>();

function channel(id: string, initial: number, apply: (v: number) => void): void {
    channels.set(id, { value: initial, from: initial, to: initial, elapsed: 0, dur: 0, ease: easeOutCubic, apply });
    apply(initial);
}
function tweenTo(id: string, to: number, dur = 0.35, ease: Ease = easeOutCubic): void {
    const ch = channels.get(id);
    if (!ch) return;
    ch.from = ch.value;
    ch.to = to;
    ch.elapsed = 0;
    ch.dur = Math.max(0.0001, dur);
    ch.ease = ease;
}
function stepChannels(dt: number): void {
    for (const ch of channels.values()) {
        if (ch.value === ch.to && ch.elapsed >= ch.dur) continue;
        ch.elapsed += dt;
        const t = Math.min(1, ch.elapsed / ch.dur);
        ch.value = ch.from + (ch.to - ch.from) * ch.ease(t);
        ch.apply(ch.value);
    }
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ─────────────────────────────────────────────────────────────────────────────
// Text labels via dynamic textures (opaque, so no alpha-blending needed).
// ─────────────────────────────────────────────────────────────────────────────

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

interface Label {
    tex: ReturnType<typeof createDynamicTexture>;
    draw: (text: string, opts?: { fg?: string; bg?: string; align?: CanvasTextAlign; weight?: number; size?: number }) => void;
}

function makeLabel(engine: Parameters<typeof createDynamicTexture>[0], w: number, h: number): Label {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const tex = createDynamicTexture(engine, w, h, { srgb: true });
    const draw: Label["draw"] = (text, opts = {}) => {
        const { fg = "#eaf0ff", bg = "rgba(0,0,0,0)", align = "left", weight = 600, size = Math.round(h * 0.46) } = opts;
        ctx.clearRect(0, 0, w, h);
        if (bg !== "rgba(0,0,0,0)") {
            ctx.fillStyle = bg;
            roundRect(ctx, 2, 2, w - 4, h - 4, Math.min(h * 0.35, 28));
            ctx.fill();
        }
        ctx.fillStyle = fg;
        ctx.font = `${weight} ${size}px 'Segoe UI', system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.textAlign = align;
        const x = align === "left" ? 22 : align === "right" ? w - 22 : w / 2;
        ctx.fillText(text, x, h / 2 + 2);
        updateDynamicTexture(engine, tex, c);
    };
    return { tex, draw };
}

/** A flat plane whose front face shows a text label (opaque emissive). */
function labelPlane(
    engine: Parameters<typeof createDynamicTexture>[0],
    text: string,
    worldW: number,
    worldH: number,
    px: number,
    opts?: Parameters<Label["draw"]>[1]
): { mesh: Mesh; label: Label } {
    const label = makeLabel(engine, px, Math.round(px * (worldH / worldW)));
    label.draw(text, opts);
    const mesh = createPlane(engine, { width: worldW, height: worldH });
    const mat = createStandardMaterial();
    setStandardEmissiveTexture(mat, label.tex);
    setStandardOpacityTexture(mat, label.tex); // per-pixel alpha → transparent background
    mat.emissiveColor = [0, 0, 0];
    mat.alpha = 0.999; // < 1 enables source-over blending (text floats on the card)
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mesh.material = mat;
    return { mesh, label };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared state model — mirrors the native form.
// ─────────────────────────────────────────────────────────────────────────────

interface FormState {
    notifications: boolean;
    terms: boolean;
    size: "S" | "M" | "L";
    plan: "free" | "pro" | "team";
}
const PLAN_LABEL: Record<FormState["plan"], string> = { free: "Free", pro: "Pro", team: "Team" };

function readState(): FormState {
    const data = new FormData(form);
    return {
        notifications: (form.elements.namedItem("notifications") as HTMLInputElement).checked,
        terms: (form.elements.namedItem("terms") as HTMLInputElement).checked,
        size: (data.get("size") as FormState["size"]) ?? "S",
        plan: (data.get("plan") as FormState["plan"]) ?? "free",
    };
}
/** Mutate a native input and fire `change` (drives the single sync path). */
function setInput(name: string, value: string | boolean, radioValue?: string): void {
    if (typeof value === "boolean") {
        (form.elements.namedItem(name) as HTMLInputElement).checked = value;
    } else if (radioValue !== undefined) {
        const radios = form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`);
        radios.forEach((r) => (r.checked = r.value === radioValue));
    } else {
        (form.elements.namedItem(name) as HTMLSelectElement).value = value;
    }
    form.dispatchEvent(new Event("change", { bubbles: true }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Control definitions. Each registers pick meshes + a hover group + a sync(state).
// ─────────────────────────────────────────────────────────────────────────────

interface Control {
    sync: (s: FormState, animate: boolean) => void;
}
const pickHandlers = new Map<Mesh, () => void>();
const hoverGroup = new Map<Mesh, string>();
const hoverApply = new Map<string, (on: boolean) => void>();

function emissive(mat: Mat, id: string, base: () => [number, number, number]): void {
    // Route a material's emissive through a 0..1 glow channel so hover/idle pulse.
    channel(id, 0, (v) => {
        const b = base();
        mat.emissiveColor = [b[0] + v * 0.5, b[1] + v * 0.5, b[2] + v * 0.5];
        markMaterialUboDirty(mat);
    });
}

/** Register a channel that mutates a material colour, marking its UBO dirty each frame. */
function colorChannel(id: string, mat: Mat, initial: number, apply: (v: number) => void): void {
    channel(id, initial, (v) => {
        apply(v);
        markMaterialUboDirty(mat);
    });
}

// ── Toggle switch (notifications) ────────────────────────────────────────────
function buildToggle(engine: any, scene: any, x: number, y: number): Control {
    const track = createCapsule(engine, { height: 1.5, radius: 0.32, tessellation: 24 });
    track.rotation.z = Math.PI / 2;
    track.position.x = x;
    track.position.y = y;
    const trackMat = createStandardMaterial();
    trackMat.diffuseColor = [0.12, 0.14, 0.2];
    trackMat.specularColor = [0.2, 0.2, 0.25];
    track.material = trackMat;
    addToScene(scene, track);

    const knob = createSphere(engine, { diameter: 0.5, segments: 20 });
    knob.position.y = y;
    knob.position.z = -0.18;
    const knobMat = createStandardMaterial();
    knobMat.diffuseColor = [0.95, 0.97, 1.0];
    knobMat.emissiveColor = [0.25, 0.28, 0.35];
    knob.material = knobMat;
    addToScene(scene, knob);

    const LEFT = x - 0.42;
    const RIGHT = x + 0.42;
    channel("toggle.knob", LEFT, (v) => (knob.position.x = v));
    colorChannel("toggle.fill", trackMat, 0, (v) => {
        trackMat.emissiveColor = mix([0.02, 0.03, 0.04], [0.16, 0.85, 0.45], v);
        trackMat.diffuseColor = mix([0.12, 0.14, 0.2], [0.13, 0.55, 0.32], v);
    });
    colorChannel("toggle.hover", knobMat, 0, (v) => (knobMat.emissiveColor = mix([0.2, 0.23, 0.3], [0.5, 0.55, 0.7], v)));

    const onPick = (): void => setInput("notifications", !readState().notifications);
    for (const m of [track, knob]) {
        pickHandlers.set(m, onPick);
        hoverGroup.set(m, "toggle");
    }
    hoverApply.set("toggle", (on) => tweenTo("toggle.hover", on ? 1 : 0, 0.2));

    return {
        sync: (s, animate) => {
            const d = animate ? 0.4 : 0.0001;
            tweenTo("toggle.knob", s.notifications ? RIGHT : LEFT, d, easeOutBack);
            tweenTo("toggle.fill", s.notifications ? 1 : 0, d);
        },
    };
}

// ── Checkbox (terms) with a 3D check-mark pop ─────────────────────────────────
function buildCheckbox(engine: any, scene: any, x: number, y: number): Control {
    const box = createBox(engine, { width: 0.9, height: 0.9, depth: 0.28 });
    box.position.x = x;
    box.position.y = y;
    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [0.14, 0.16, 0.22];
    boxMat.specularColor = [0.25, 0.25, 0.3];
    box.material = boxMat;
    addToScene(scene, box);

    // Check-mark: two thin lit boxes forming a ✓, scaled in with a spring pop.
    // Geometry meets at a bottom vertex: short stroke up-left, long stroke up-right.
    const armMat = createStandardMaterial();
    armMat.diffuseColor = [0.95, 1.0, 0.98];
    armMat.emissiveColor = [0.3, 0.75, 0.5];
    const shortArm = createBox(engine, { width: 0.26, height: 0.13, depth: 0.13 });
    shortArm.material = armMat;
    shortArm.position.set(x - 0.16, y - 0.12, -0.18);
    shortArm.rotation.z = (3 * Math.PI) / 4; // up-left
    addToScene(scene, shortArm);
    const longArm = createBox(engine, { width: 0.52, height: 0.13, depth: 0.13 });
    longArm.material = armMat;
    longArm.position.set(x + 0.09, y - 0.01, -0.18);
    longArm.rotation.z = 0.84; // up-right
    addToScene(scene, longArm);

    channel("check.mark", 0, (v) => {
        shortArm.scaling.set(v, v, v);
        longArm.scaling.set(v, v, v);
    });
    colorChannel("check.fill", boxMat, 0, (v) => {
        boxMat.emissiveColor = mix([0.02, 0.03, 0.04], mix(ACCENT, GOOD, 0.5), v);
        boxMat.diffuseColor = mix([0.14, 0.16, 0.22], [0.12, 0.22, 0.3], v);
    });
    channel("check.hover", 0, (v) => (box.rotation.y = v * 0.18));

    const onPick = (): void => setInput("terms", !readState().terms);
    for (const m of [box, shortArm, longArm]) {
        pickHandlers.set(m, onPick);
        hoverGroup.set(m, "check");
    }
    hoverApply.set("check", (on) => tweenTo("check.hover", on ? 1 : 0, 0.25));

    return {
        sync: (s, animate) => {
            const d = animate ? 0.45 : 0.0001;
            tweenTo("check.mark", s.terms ? 1 : 0, d, s.terms ? easeOutBack : easeOutCubic);
            tweenTo("check.fill", s.terms ? 1 : 0, animate ? 0.3 : 0.0001);
        },
    };
}

// ── Radio group (team size) ───────────────────────────────────────────────────
function buildRadioGroup(engine: any, scene: any, cx: number, y: number): Control {
    const opts: FormState["size"][] = ["S", "M", "L"];
    const gap = 0.95;
    opts.forEach((opt, i) => {
        const ox = cx + (i - 1) * gap;

        // Invisible-ish backing disc makes the whole circle (incl. the ring's hollow
        // centre) a pick target, not just the thin torus.
        const hit = createDisc(engine, { radius: 0.42, tessellation: 40 });
        hit.position.set(ox, y, 0.04);
        const hitMat = createStandardMaterial();
        hitMat.diffuseColor = [0.06, 0.07, 0.11];
        hitMat.emissiveColor = [0.02, 0.025, 0.04];
        hitMat.disableLighting = true;
        hitMat.backFaceCulling = false;
        hit.material = hitMat;
        addToScene(scene, hit);

        const ring = createTorus(engine, { diameter: 0.62, thickness: 0.08, tessellation: 32 });
        ring.rotation.x = Math.PI / 2;
        ring.position.set(ox, y, 0);
        const ringMat = createStandardMaterial();
        ringMat.diffuseColor = [0.16, 0.18, 0.24];
        ring.material = ringMat;
        emissive(ringMat, `radio.ring.${i}`, () => IDLE);
        addToScene(scene, ring);

        const dot = createSphere(engine, { diameter: 0.32, segments: 18 });
        dot.position.set(ox, y, -0.06);
        const dotMat = createStandardMaterial();
        dotMat.diffuseColor = ACCENT;
        dotMat.emissiveColor = ACCENT;
        dot.material = dotMat;
        dot.scaling.set(0, 0, 0);
        addToScene(scene, dot);
        channel(`radio.dot.${i}`, 0, (v) => dot.scaling.set(v, v, v));

        const cap = labelPlane(engine, opt, 0.4, 0.4, 128, { align: "center", weight: 800, size: 78 });
        cap.mesh.position.set(ox, y - 0.62, 0);
        addToScene(scene, cap.mesh);

        const onPick = (): void => setInput("size", "radio", opt);
        for (const m of [hit, ring, dot, cap.mesh]) {
            pickHandlers.set(m, onPick);
            hoverGroup.set(m, `radio.${i}`);
        }
        hoverApply.set(`radio.${i}`, (on) => tweenTo(`radio.ring.${i}`, on ? 0.5 : 0, 0.2));
    });

    return {
        sync: (s, animate) => {
            const d = animate ? 0.4 : 0.0001;
            opts.forEach((opt, i) => tweenTo(`radio.dot.${i}`, s.size === opt ? 1 : 0, d, s.size === opt ? easeOutBack : easeOutCubic));
        },
    };
}

// ── Select / dropdown (plan) ──────────────────────────────────────────────────
function buildSelect(engine: any, scene: any, x: number, y: number): Control {
    let open = false;
    const plans: FormState["plan"][] = ["free", "pro", "team"];

    // Closed bar with a live value label + a caret.
    const bar = createBox(engine, { width: 2.3, height: 0.72, depth: 0.26 });
    bar.position.set(x, y, 0);
    const barMat = createStandardMaterial();
    barMat.diffuseColor = [0.13, 0.15, 0.21];
    barMat.specularColor = [0.2, 0.2, 0.26];
    bar.material = barMat;
    emissive(barMat, "select.hover", () => IDLE);
    addToScene(scene, bar);

    const valueLbl = labelPlane(engine, "Free", 2.0, 0.5, 400, { align: "left", size: 84, fg: "#eaf0ff" });
    valueLbl.mesh.position.set(x - 0.05, y, -0.14);
    addToScene(scene, valueLbl.mesh);

    const caret = createCylinder(engine, { height: 0.22, diameterTop: 0, diameterBottom: 0.26, tessellation: 3 });
    caret.position.set(x + 0.92, y, -0.16);
    const caretMat = createStandardMaterial();
    caretMat.diffuseColor = [0.7, 0.78, 0.95];
    caretMat.emissiveColor = [0.3, 0.36, 0.5];
    caret.material = caretMat;
    channel("select.caret", Math.PI, (v) => (caret.rotation.z = v)); // ▲ closed → ▼ open
    addToScene(scene, caret);

    // Option boxes float in FRONT of everything (a real dropdown overlay),
    // animating in staggered when opened.
    const optionMeshes: Mesh[] = [];
    const optionLabels: Mesh[] = [];
    plans.forEach((plan, i) => {
        const oy = y - 0.58 - i * 0.62;
        const ob = createBox(engine, { width: 2.1, height: 0.56, depth: 0.2 });
        ob.position.set(x, oy, -0.72);
        const obMat = createStandardMaterial();
        obMat.diffuseColor = [0.19, 0.22, 0.31];
        obMat.specularColor = [0.28, 0.32, 0.42];
        ob.material = obMat;
        emissive(obMat, `select.opt.${i}`, () => [0.14, 0.17, 0.24]);
        ob.scaling.set(0, 0, 0);
        ob.pickable = false;
        addToScene(scene, ob);
        optionMeshes.push(ob);

        const olbl = labelPlane(engine, PLAN_LABEL[plan], 1.6, 0.4, 360, { align: "left", size: 52 });
        olbl.mesh.position.set(x - 0.05, oy, -0.84);
        olbl.mesh.scaling.set(0, 0, 0);
        olbl.mesh.pickable = false;
        addToScene(scene, olbl.mesh);
        optionLabels.push(olbl.mesh);

        channel(`select.optScale.${i}`, 0, (v) => {
            ob.scaling.set(v, v, v);
            olbl.mesh.scaling.set(v, v, v);
        });

        const onPick = (): void => {
            setInput("plan", plan);
            setOpen(false);
        };
        pickHandlers.set(ob, onPick);
        pickHandlers.set(olbl.mesh, onPick);
        hoverGroup.set(ob, `select.opt.${i}`);
        hoverGroup.set(olbl.mesh, `select.opt.${i}`);
        hoverApply.set(`select.opt.${i}`, (on) => open && tweenTo(`select.opt.${i}`, on ? 0.6 : 0, 0.15));
    });

    function setOpen(next: boolean): void {
        open = next;
        tweenTo("select.caret", next ? 0 : Math.PI, 0.3, easeInOutCubic);
        optionMeshes.forEach((m) => (m.pickable = next));
        optionLabels.forEach((m) => (m.pickable = next));
        plans.forEach((_, i) => {
            if (next) {
                setTimeout(() => tweenTo(`select.optScale.${i}`, 1, 0.32, easeOutBack), i * 55);
            } else {
                tweenTo(`select.optScale.${i}`, 0, 0.22, easeOutCubic);
                tweenTo(`select.opt.${i}`, 0, 0.15);
            }
        });
    }

    pickHandlers.set(bar, () => setOpen(!open));
    pickHandlers.set(valueLbl.mesh, () => setOpen(!open));
    pickHandlers.set(caret, () => setOpen(!open));
    hoverGroup.set(bar, "select");
    hoverGroup.set(valueLbl.mesh, "select");
    hoverGroup.set(caret, "select");
    hoverApply.set("select", (on) => tweenTo("select.hover", on ? 0.35 : 0, 0.2));

    return {
        sync: (s) => {
            valueLbl.label.draw(PLAN_LABEL[s.plan], { align: "left", size: 84, fg: "#eaf0ff" });
        },
    };
}

// ── Submit button ─────────────────────────────────────────────────────────────
function buildSubmit(engine: any, scene: any, x: number, y: number): { control: Control; flash: () => void } {
    const btn = createBox(engine, { width: 2.7, height: 0.9, depth: 0.34 });
    btn.position.set(x, y, 0);
    const btnMat = createStandardMaterial();
    btnMat.diffuseColor = [0.2, 0.55, 0.9];
    btnMat.specularColor = [0.4, 0.5, 0.7];
    btn.material = btnMat;
    addToScene(scene, btn);

    const lbl = labelPlane(engine, "Create account", 2.4, 0.5, 560, { align: "center", size: 66, weight: 700, fg: "#04121b" });
    lbl.mesh.position.set(x, y, -0.18);
    addToScene(scene, lbl.mesh);

    colorChannel("submit.glow", btnMat, 0, (v) => (btnMat.emissiveColor = mix([0.06, 0.2, 0.35], mix(ACCENT, GOOD, 0.4), v)));
    channel("submit.press", 0, (v) => {
        btn.position.z = v * 0.2;
        lbl.mesh.position.z = -0.18 + v * 0.2;
        btn.scaling.set(1 - v * 0.05, 1 - v * 0.05, 1);
    });

    pickHandlers.set(btn, () => form.requestSubmit());
    pickHandlers.set(lbl.mesh, () => form.requestSubmit());
    hoverGroup.set(btn, "submit");
    hoverGroup.set(lbl.mesh, "submit");
    hoverApply.set("submit", (on) => tweenTo("submit.glow", on ? 1 : 0.15, 0.2));

    const flash = (): void => {
        tweenTo("submit.press", 1, 0.09, easeOutCubic);
        setTimeout(() => tweenTo("submit.press", 0, 0.28, easeOutBack), 110);
        tweenTo("submit.glow", 1.4, 0.12);
        setTimeout(() => tweenTo("submit.glow", 0.15, 0.5), 260);
    };

    return { control: { sync: () => {} }, flash };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene
// ─────────────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.02, g: 0.03, b: 0.06, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.15, 9.2, { x: 0, y: -0.2, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    setCameraLimits(camera, { lowerRadiusLimit: 6, upperRadiusLimit: 16, lowerBetaLimit: 0.6, upperBetaLimit: Math.PI - 0.6 });

    addToScene(scene, createHemisphericLight([0.2, 1, -0.3], 0.55));
    addToScene(scene, createDirectionalLight([-0.5, -0.9, 0.7], 0.9));

    // Backing card + floor for depth.
    const card = createBox(engine, { width: 6.4, height: 6.6, depth: 0.25 });
    card.position.set(0, -0.1, 0.55);
    const cardMat = createStandardMaterial();
    cardMat.diffuseColor = [0.05, 0.06, 0.1];
    cardMat.emissiveColor = [0.02, 0.025, 0.045];
    cardMat.specularColor = [0.12, 0.14, 0.2];
    card.material = cardMat;
    addToScene(scene, card);

    const ground = createGround(engine, { width: 40, height: 40 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.03, 0.035, 0.06];
    groundMat.specularColor = [0.08, 0.09, 0.14];
    ground.material = groundMat;
    ground.position.y = -3.6;
    addToScene(scene, ground);

    // Title.
    const title = labelPlane(engine, "Create your account", 4.6, 0.7, 920, { align: "center", size: 92, weight: 800 });
    title.mesh.position.set(0, 2.65, -0.05);
    addToScene(scene, title.mesh);

    // Row labels (left column) + controls (right).
    const LX = -1.55; // label centre
    const CX = 1.35; // control centre
    const rows: Array<{ y: number; text: string }> = [
        { y: 1.55, text: "Email notifications" },
        { y: 0.55, text: "Accept terms" },
        { y: -0.5, text: "Plan" },
        { y: -1.65, text: "Team size" },
    ];
    for (const r of rows) {
        const l = labelPlane(engine, r.text, 2.7, 0.5, 620, { align: "right", size: 62, weight: 600, fg: "#c8d2f5" });
        l.mesh.position.set(LX, r.y, -0.02);
        addToScene(scene, l.mesh);
    }

    const controls: Control[] = [
        buildToggle(engine, scene, CX + 0.1, 1.55),
        buildCheckbox(engine, scene, CX - 0.35, 0.55),
        buildSelect(engine, scene, CX + 0.15, -0.5),
        buildRadioGroup(engine, scene, CX + 0.35, -1.6),
    ];
    const submit = buildSubmit(engine, scene, 0, -2.85);
    controls.push(submit.control);

    // Drive the tween engine each frame.
    let last = performance.now();
    onBeforeRender(scene, () => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        stepChannels(dt);
    });

    // ── The one sync path: read the real form, animate every 3D control. ──
    function syncAll(animate: boolean): void {
        const s = readState();
        for (const c of controls) c.sync(s, animate);
        readout.textContent = JSON.stringify(s);
    }
    form.addEventListener("change", () => syncAll(true));
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        submit.flash();
        const s = readState();
        readout.textContent = "✔ submitted\n" + JSON.stringify(s, null, 0);
    });

    await registerScene(scene);
    await startEngine(engine);
    for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r));
    const picker = createGpuPicker(scene);

    syncAll(false); // snap 3D to the form's initial state

    // ── Pointer: tap a control to actuate, drag to orbit. ──
    let downX = 0;
    let downY = 0;
    canvas.addEventListener("pointerdown", (e) => {
        downX = e.clientX;
        downY = e.clientY;
    });
    canvas.addEventListener("pointerup", async (e) => {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // orbit drag
        const rect = canvas.getBoundingClientRect();
        const info = await pickAsync(picker, e.clientX - rect.left, e.clientY - rect.top);
        if (!info.hit || !info.pickedMesh) return;
        pickHandlers.get(info.pickedMesh as Mesh)?.();
    });

    // ── Hover highlight (single-flight GPU pick on move). ──
    let hovering: string | null = null;
    let pickBusy = false;
    canvas.addEventListener("pointermove", async (e) => {
        if (pickBusy) return;
        pickBusy = true;
        const rect = canvas.getBoundingClientRect();
        try {
            const info = await pickAsync(picker, e.clientX - rect.left, e.clientY - rect.top);
            const group = info.hit && info.pickedMesh ? hoverGroup.get(info.pickedMesh as Mesh) ?? null : null;
            if (group !== hovering) {
                if (hovering) hoverApply.get(hovering)?.(false);
                if (group) hoverApply.get(group)?.(true);
                hovering = group;
                canvas.style.cursor = group ? "pointer" : "default";
            }
        } finally {
            pickBusy = false;
        }
    });

    (window as unknown as { __form3d: unknown }).__form3d = {
        readState,
        setInput,
        toggle: () => setInput("notifications", !readState().notifications),
    };
    canvas.dataset.ready = "true";
}

run().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    canvas.dataset.ready = "true";
});
