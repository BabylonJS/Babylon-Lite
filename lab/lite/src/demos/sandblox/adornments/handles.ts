/**
 * Handles — per-face drag handles, the classic resize adornment .
 *
 * Six ball handles floating off the
 * adornee's faces. Grabbing one and dragging emits `drag` events with the
 * cursor's travel projected onto that face's normal axis, rounded to whole
 * studs — each emission is one snap increment (the Resize tool plays its
 * click per event).
 *
 * Rendering: ONE thin-instanced sphere mesh, 6 instances (count 0 when
 * hidden). Input: registers a Mouse "down" handler at construction time —
 * BEFORE any tool subscribes — and consumes the event when a handle is
 * grabbed so tools never see it.
 */

import type { EngineContext, Mesh, SceneContext } from "babylon-lite";
import {
    addToScene,
    createSphere,
    createStandardMaterial,
    enableThinInstanceGpuCulling,
    getViewProjectionMatrix,
    mat4Compose,
    onBeforeRender,
    setThinInstanceCount,
    setThinInstanceMatrix,
    setThinInstances,
} from "babylon-lite";

import type { Mouse, MouseRayEvent } from "../mouse.js";
import type { Part } from "../part.js";
import type { FaceId, Ray } from "../ray-helpers.js";
import { FACE_NORMALS } from "../ray-helpers.js";

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Handle ball diameter in studs. */
const HANDLE_D = 0.9;
/** Gap between the part surface and the handle center, in studs. */
const HANDLE_GAP = 1.0;
/** Classic Studio handle blue. */
const HANDLE_COLOR: readonly [number, number, number] = [0.35, 0.6, 1.0];

const FACES: readonly FaceId[] = ["right", "left", "top", "bottom", "back", "front"];

// ── Pure math (unit-tested) ──────────────────────────────────────────────────

/**
 * Parameter of the closest point on the line `p + t·n` to the given ray.
 * Returns null when the ray is (near-)parallel to the axis.
 */
export function axisDragParam(ray: Ray, p: readonly [number, number, number], n: readonly [number, number, number]): number | null {
    const wx = ray.origin[0] - p[0];
    const wy = ray.origin[1] - p[1];
    const wz = ray.origin[2] - p[2];
    const b = ray.dir[0] * n[0] + ray.dir[1] * n[1] + ray.dir[2] * n[2];
    const d0 = ray.dir[0] * wx + ray.dir[1] * wy + ray.dir[2] * wz;
    const e = n[0] * wx + n[1] * wy + n[2] * wz;
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-6) {
        return null;
    }
    return (e - b * d0) / denom;
}

/** Ray vs sphere (center c, radius r): smallest positive hit distance or -1. */
export function raySphere(ray: Ray, c: readonly [number, number, number], r: number): number {
    const ox = ray.origin[0] - c[0];
    const oy = ray.origin[1] - c[1];
    const oz = ray.origin[2] - c[2];
    const b = ox * ray.dir[0] + oy * ray.dir[1] + oz * ray.dir[2];
    const disc = b * b - (ox * ox + oy * oy + oz * oz - r * r);
    if (disc < 0) {
        return -1;
    }
    const t = -b - Math.sqrt(disc);
    return t >= 0 ? t : -b + Math.sqrt(disc) >= 0 ? 0 : -1;
}

// ── Handles ──────────────────────────────────────────────────────────────────

export interface HandleDragEvent {
    readonly face: FaceId;
    /** Whole-stud travel along the face normal since the grab. */
    readonly distanceStuds: number;
}

type HandlesEventName = "dragStart" | "drag" | "dragEnd";

/** Classic center-dot: small cyan square per handle, drawn ALWAYS ON TOP
 *  (screen-space DOM) so handles
 *  stay visible when the 3D balls clip into neighboring parts. Picking is
 *  pure ray-math and already ignores occlusion — the dots make that
 *  affordance visible. */
const DOT_CSS = `
.sandblox-handle-dot {
    position: fixed;
    width: 7px;
    height: 7px;
    background: #19d7ff;
    border: 1px solid rgba(8, 61, 79, 0.9);
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 999;
    display: none;
}
`;

export class Handles {
    private readonly _mesh: Mesh;
    private readonly _mouse: Mouse;
    private readonly _scene: SceneContext;
    private readonly _canvas: HTMLCanvasElement;
    private readonly _dots: HTMLDivElement[] = [];
    private _adornee: Part | null = null;
    private readonly _handlers = new Map<HandlesEventName, Set<(e: HandleDragEvent) => void>>();
    private readonly _centers: [number, number, number][] = FACES.map(() => [0, 0, 0]);

    // Active drag state
    private _dragFace: FaceId | null = null;
    private _dragOrigin: [number, number, number] = [0, 0, 0];
    private _dragStartParam = 0;
    private _lastDist = 0;

    private readonly _onAdorneeChange = (): void => this._refresh();
    private readonly _onDown = (e: MouseRayEvent): void => this._down(e);
    private readonly _onMove = (e: MouseRayEvent): void => this._move(e);
    private readonly _onUp = (): void => this._up();

    constructor(engine: EngineContext, scene: SceneContext, mouse: Mouse, canvas: HTMLCanvasElement) {
        this._mouse = mouse;
        this._scene = scene;
        this._canvas = canvas;

        const mat = createStandardMaterial();
        mat.disableLighting = true;
        mat.diffuseColor = [1, 1, 1];
        mat.emissiveColor = [...HANDLE_COLOR] as [number, number, number];

        this._mesh = createSphere(engine, { diameter: 1, segments: 12 });
        this._mesh.material = mat;
        setThinInstances(this._mesh, new Float32Array(6 * 16), 6);
        setThinInstanceCount(this._mesh, 0);
        enableThinInstanceGpuCulling(this._mesh); // → per-frame direct draw (see part-renderer.ts)
        addToScene(scene, this._mesh);

        // Always-on-top center dots (one per face handle)
        const style = document.createElement("style");
        style.textContent = DOT_CSS;
        document.head.appendChild(style);
        for (let i = 0; i < 6; i++) {
            const dot = document.createElement("div");
            dot.className = "sandblox-handle-dot";
            document.body.appendChild(dot);
            this._dots.push(dot);
        }
        onBeforeRender(scene, () => this._updateDots());

        // Constructor-time registration = runs before any tool's handler.
        mouse.on("down", this._onDown);
        mouse.on("move", this._onMove);
        mouse.on("up", this._onUp);
    }

    get adornee(): Part | null {
        return this._adornee;
    }

    set adornee(part: Part | null) {
        if (part === this._adornee) {
            return;
        }
        this._adornee?.offChange(this._onAdorneeChange);
        this._adornee = part;
        part?.onChange(this._onAdorneeChange);
        this._refresh();
    }

    get dragging(): boolean {
        return this._dragFace !== null;
    }

    on(event: HandlesEventName, handler: (e: HandleDragEvent) => void): void {
        let set = this._handlers.get(event);
        if (!set) {
            set = new Set();
            this._handlers.set(event, set);
        }
        set.add(handler);
    }

    off(event: HandlesEventName, handler: (e: HandleDragEvent) => void): void {
        this._handlers.get(event)?.delete(handler);
    }

    dispose(): void {
        this.adornee = null;
        this._mouse.off("down", this._onDown);
        this._mouse.off("move", this._onMove);
        this._mouse.off("up", this._onUp);
        this._handlers.clear();
    }

    // ── Private ──────────────────────────────────────────────────────────

    private _refresh(): void {
        const part = this._adornee;
        if (!part || part.destroyed) {
            if (part?.destroyed) {
                this._adornee = null;
            }
            setThinInstanceCount(this._mesh, 0);
            return;
        }
        const b = part.getAABB();
        const c = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
        const half = [(b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2, (b.maxZ - b.minZ) / 2];

        for (let i = 0; i < 6; i++) {
            const n = FACE_NORMALS[FACES[i]!];
            const center = this._centers[i]!;
            for (let a = 0; a < 3; a++) {
                center[a] = c[a]! + n[a]! * (half[a]! + HANDLE_GAP);
            }
            const m = mat4Compose(center[0]!, center[1]!, center[2]!, 0, 0, 0, 1, HANDLE_D, HANDLE_D, HANDLE_D);
            setThinInstanceMatrix(this._mesh, i, m);
        }
        setThinInstanceCount(this._mesh, 6);
        this._mesh.boundMin = [b.minX - HANDLE_GAP - HANDLE_D, b.minY - HANDLE_GAP - HANDLE_D, b.minZ - HANDLE_GAP - HANDLE_D];
        this._mesh.boundMax = [b.maxX + HANDLE_GAP + HANDLE_D, b.maxY + HANDLE_GAP + HANDLE_D, b.maxZ + HANDLE_GAP + HANDLE_D];
    }

    private _down(e: MouseRayEvent): void {
        if (!this._adornee || e.button !== 0 || !e.ray) {
            return;
        }
        // Grab test against all six handle balls; nearest wins.
        let best = -1;
        let bestT = Infinity;
        for (let i = 0; i < 6; i++) {
            const t = raySphere(e.ray, this._centers[i]!, HANDLE_D / 2 + 0.15);
            if (t >= 0 && t < bestT) {
                bestT = t;
                best = i;
            }
        }
        if (best < 0) {
            return;
        }
        const face = FACES[best]!;
        const n = FACE_NORMALS[face];
        this._dragFace = face;
        this._dragOrigin = [...this._centers[best]!] as [number, number, number];
        this._dragStartParam = axisDragParam(e.ray, this._dragOrigin, n) ?? 0;
        this._lastDist = 0;
        e.consumed = true; // tools never see this down
        this._emit("dragStart", { face, distanceStuds: 0 });
    }

    private _move(e: MouseRayEvent): void {
        if (!this._dragFace || !e.ray) {
            return;
        }
        const n = FACE_NORMALS[this._dragFace];
        const param = axisDragParam(e.ray, this._dragOrigin, n);
        if (param === null) {
            return;
        }
        const dist = Math.round(param - this._dragStartParam);
        if (dist !== this._lastDist) {
            this._lastDist = dist;
            this._emit("drag", { face: this._dragFace, distanceStuds: dist });
        }
        e.consumed = true; // hovering elsewhere must not retarget tools mid-resize
    }

    private _up(): void {
        if (!this._dragFace) {
            return;
        }
        const face = this._dragFace;
        this._dragFace = null;
        this._emit("dragEnd", { face, distanceStuds: this._lastDist });
    }

    private _emit(event: HandlesEventName, e: HandleDragEvent): void {
        const set = this._handlers.get(event);
        if (set) {
            for (const h of set) {
                h(e);
            }
        }
    }

    /** Project each handle center to CSS pixels (same NDC convention as
     *  ray-helpers, reverse-Z irrelevant here — w-divide only). */
    private _updateDots(): void {
        const cam = this._scene.camera;
        if (this._adornee === null || !cam) {
            for (const d of this._dots) {
                d.style.display = "none";
            }
            return;
        }
        const w = this._canvas.width || 1;
        const h = this._canvas.height || 1;
        const vp = getViewProjectionMatrix(cam, w / h);
        const rect = this._canvas.getBoundingClientRect();
        const cssW = this._canvas.clientWidth || w;
        const cssH = this._canvas.clientHeight || h;
        for (let i = 0; i < 6; i++) {
            const c = this._centers[i]!;
            const dot = this._dots[i]!;
            const cw = vp[3]! * c[0] + vp[7]! * c[1] + vp[11]! * c[2] + vp[15]!;
            if (cw <= 0) {
                dot.style.display = "none"; // behind the camera
                continue;
            }
            const ndcX = (vp[0]! * c[0] + vp[4]! * c[1] + vp[8]! * c[2] + vp[12]!) / cw;
            const ndcY = (vp[1]! * c[0] + vp[5]! * c[1] + vp[9]! * c[2] + vp[13]!) / cw;
            dot.style.display = "block";
            dot.style.left = `${rect.left + (ndcX * 0.5 + 0.5) * cssW}px`;
            dot.style.top = `${rect.top + (0.5 - ndcY * 0.5) * cssH}px`;
        }
    }
}
