// First-person weapon viewmodels for the Quake E1M1 demo. Loads each weapon's
// alias model (v_shot / v_shot2 / v_rock) and renders the *active* one in world
// space, locked to the camera each frame so it reads as a held weapon. Firing
// plays the model's muzzle frames (1..N) by streaming keyframe positions into
// the mesh GPU buffer, mirroring the monster animation path. Inactive weapons
// are toggled off with setMeshVisible. No GPL code copied.

import {
    addToScene,
    createMeshFromData,
    createTexture2DFromPixels,
    setMeshVisible,
    updateMeshPositions,
    type EngineContext,
    type Mesh,
    type SceneContext,
    type Texture2D,
} from "babylon-lite";

import { parseMdl, expandFrame, type MdlModel } from "./mdl.js";
import { createQuakeMaterial } from "./quake-material.js";
import type { Palette } from "../palette.js";
import type { WeaponId, WeaponDef } from "../combat/weapons.js";
import { demoAssetUrl } from "../../demo-asset-url.js";

// Placement relative to the camera basis (engine units). The view models are
// authored at the eye (barrel +X forward, body hanging below), so only small
// nudges are needed: push forward slightly so the stock doesn't clip the near
// plane, a touch right, and lift it up so the low-hanging models (the nailguns)
// aren't hidden behind the status bar.
const DEPTH = 3; // forward
const SIDE = 2; // right
const VERT = 2.2; // up
const SCALE = 1;

type V4 = [number, number, number, number];

/** quaternion from axis (unit) + angle */
function quat(ax: number, ay: number, az: number, angle: number): V4 {
    const h = angle * 0.5;
    const s = Math.sin(h);
    return [ax * s, ay * s, az * s, Math.cos(h)];
}

function qmul(a: V4, b: V4): V4 {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
}

interface WeaponEntry {
    def: WeaponDef;
    model: MdlModel;
    mesh: Mesh;
    scratch: Float32Array;
    firing: number; // seconds remaining in the fire animation
    curFrame: number;
}

export class Viewmodel {
    private readonly entries = new Map<WeaponId, WeaponEntry>();
    private active: WeaponId | null = null;

    constructor(
        private readonly engine: EngineContext,
        private readonly scene: SceneContext,
        private readonly lightTex: Texture2D,
        private readonly palette: Palette,
        private readonly whiteUV: [number, number]
    ) {}

    /** Load every weapon's viewmodel. The first def becomes the active weapon. */
    async load(defs: WeaponDef[]): Promise<void> {
        for (const def of defs) {
            const url = demoAssetUrl(`./librequake/${def.viewModel.file}`, import.meta.url);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
            const model = parseMdl(await res.arrayBuffer(), this.palette);
            const corners = model.indices.length;
            const scratch = new Float32Array(corners * 3);
            expandFrame(model, 0, scratch);
            // The Quake world material samples a lightmap via uv2; use the atlas's
            // bright "white" texel so the viewmodel is fully lit and readable.
            const uv2 = new Float32Array(corners * 2);
            for (let i = 0; i < corners; i++) {
                uv2[i * 2] = this.whiteUV[0];
                uv2[i * 2 + 1] = this.whiteUV[1];
            }
            const mesh = createMeshFromData(this.engine, `viewmodel_${def.id}`, scratch.slice(), new Float32Array(corners * 3), model.indices.slice(), model.uvs.slice(), uv2);
            const skinTex = createTexture2DFromPixels(this.engine, model.skinRgba, model.skinWidth, model.skinHeight, {
                addressModeU: "clamp-to-edge",
                addressModeV: "clamp-to-edge",
                minFilter: "linear",
                magFilter: "linear",
            });
            mesh.material = createQuakeMaterial(`viewmodelMat_${def.id}`, skinTex, this.lightTex);
            mesh.scaling.set(SCALE, SCALE, SCALE);
            addToScene(this.scene, mesh);
            this.entries.set(def.id, { def, model, mesh, scratch, firing: 0, curFrame: 0 });
        }
        if (defs.length > 0) this.select(defs[0]!.id);
    }

    /** Show the given weapon and hide all others. */
    select(id: WeaponId): void {
        if (!this.entries.has(id)) return;
        this.active = id;
        for (const [eid, e] of this.entries) setMeshVisible(e.mesh, eid === id);
    }

    fire(): void {
        if (!this.active) return;
        const e = this.entries.get(this.active);
        if (e) e.firing = e.def.viewModel.fireFrames / e.def.viewModel.fireFps;
    }

    hide(): void {
        for (const e of this.entries.values()) setMeshVisible(e.mesh, false);
    }

    /** Lock the active model to the camera and advance its fire animation. */
    update(camPos: [number, number, number], yaw: number, pitch: number, dt: number): void {
        if (!this.active) return;
        const e = this.entries.get(this.active);
        if (!e) return;
        const { mesh, model, scratch } = e;

        // Camera basis in engine space (Y-up). Forward includes pitch.
        const cp = Math.cos(pitch);
        const fx = Math.cos(yaw) * cp;
        const fy = Math.sin(pitch);
        const fz = Math.sin(yaw) * cp;
        // right = normalize(cross(forward, worldUp)); stays horizontal
        let rx = -fz;
        let rz = fx;
        const rl = Math.hypot(rx, rz) || 1;
        rx /= rl;
        rz /= rl;
        // up = cross(right, forward)
        const ux = -rz * fy;
        const uy = rz * fx - rx * fz;
        const uz = rx * fy;

        mesh.position.set(camPos[0] + fx * DEPTH + rx * SIDE + ux * VERT, camPos[1] + fy * DEPTH + uy * VERT, camPos[2] + fz * DEPTH + rz * SIDE + uz * VERT);

        // Orient: model forward is +X engine, up +Y. Yaw about Y then pitch about Z.
        const q = qmul(quat(0, 1, 0, -yaw), quat(0, 0, 1, pitch));
        mesh.rotationQuaternion.set(q[0], q[1], q[2], q[3]);

        // Advance fire animation.
        const frames = e.def.viewModel.fireFrames;
        const fps = e.def.viewModel.fireFps;
        let frame = 0;
        if (e.firing > 0) {
            e.firing -= dt;
            const elapsed = frames / fps - e.firing;
            frame = Math.min(frames, 1 + Math.floor(elapsed * fps));
        }
        if (frame !== e.curFrame) {
            e.curFrame = frame;
            expandFrame(model, frame, scratch);
            updateMeshPositions(this.engine, mesh, scratch);
        }
    }
}
