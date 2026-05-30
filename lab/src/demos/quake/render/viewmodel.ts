// First-person weapon viewmodel for the Quake E1M1 demo. Loads the v_shot.mdl
// alias model and renders it in world space, locked to the camera each frame so
// it reads as a held shotgun. Firing plays the model's muzzle frames (1..6) by
// streaming keyframe positions into the mesh GPU buffer, mirroring the monster
// animation path. No GPL code copied.

import { addToScene, createMeshFromData, createTexture2DFromPixels, type EngineContext, type Mesh, type SceneContext, type Texture2D } from "babylon-lite";

import { parseMdl, expandFrame, type MdlModel } from "./mdl.js";
import { createQuakeMaterial } from "./quake-material.js";
import type { Palette } from "../palette.js";

const MODEL_URL = "/librequake/progs/v_shot.mdl";
const FIRE_FRAMES = 6; // frames 1..6 are the muzzle animation; frame 0 is idle
const FIRE_FPS = 20;

// Placement relative to the camera basis (engine units). The v_shot model is
// authored at the eye (barrel +X forward, body hanging below), so only small
// nudges are needed: push forward slightly so the stock doesn't clip the near
// plane, and a touch right.
const DEPTH = 3; // forward
const SIDE = 2; // right
const VERT = 0; // up
const SCALE = 1;

type V4 = [number, number, number, number];

/** quaternion from axis (unit) + angle */
function quat(ax: number, ay: number, az: number, angle: number): V4 {
    const h = angle * 0.5;
    const s = Math.sin(h);
    return [ax * s, ay * s, az * s, Math.cos(h)];
}

function qmul(a: V4, b: V4): V4 {
    return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}

export class Viewmodel {
    private model: MdlModel | null = null;
    private mesh: Mesh | null = null;
    private scratch: Float32Array | null = null;
    private device: GPUDevice;
    private firing = 0; // seconds remaining in the fire animation
    private curFrame = 0;

    constructor(
        private readonly engine: EngineContext,
        private readonly scene: SceneContext,
        private readonly lightTex: Texture2D,
        private readonly palette: Palette,
        private readonly whiteUV: [number, number]
    ) {
        this.device = (engine as unknown as { device: GPUDevice }).device;
    }

    async load(): Promise<void> {
        const res = await fetch(MODEL_URL);
        if (!res.ok) throw new Error(`Failed to fetch ${MODEL_URL}: ${res.status}`);
        const model = parseMdl(await res.arrayBuffer(), this.palette);
        this.model = model;
        const corners = model.indices.length;
        const scratch = new Float32Array(corners * 3);
        expandFrame(model, 0, scratch);
        this.scratch = scratch;
        // The Quake world material samples a lightmap via uv2; use the atlas's
        // bright "white" texel so the viewmodel is fully lit and readable.
        const uv2 = new Float32Array(corners * 2);
        for (let i = 0; i < corners; i++) {
            uv2[i * 2] = this.whiteUV[0];
            uv2[i * 2 + 1] = this.whiteUV[1];
        }
        const mesh = createMeshFromData(this.engine, "viewmodel_shotgun", scratch.slice(), new Float32Array(corners * 3), model.indices.slice(), model.uvs.slice(), uv2);
        const skinTex = createTexture2DFromPixels(this.engine, model.skinRgba, model.skinWidth, model.skinHeight, {
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            minFilter: "linear",
            magFilter: "linear",
        });
        mesh.material = createQuakeMaterial("viewmodelMat", skinTex, this.lightTex);
        mesh.scaling.set(SCALE, SCALE, SCALE);
        addToScene(this.scene, mesh);
        this.mesh = mesh;
    }

    fire(): void {
        this.firing = FIRE_FRAMES / FIRE_FPS;
    }

    hide(): void {
        if (this.mesh) this.mesh.visible = false;
    }

    /** Lock the model to the camera and advance the fire animation. */
    update(camPos: [number, number, number], yaw: number, pitch: number, dt: number): void {
        const mesh = this.mesh;
        const model = this.model;
        const scratch = this.scratch;
        if (!mesh || !model || !scratch) return;

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
        let frame = 0;
        if (this.firing > 0) {
            this.firing -= dt;
            const elapsed = FIRE_FRAMES / FIRE_FPS - this.firing;
            frame = Math.min(FIRE_FRAMES, 1 + Math.floor(elapsed * FIRE_FPS));
        }
        if (frame !== this.curFrame) {
            this.curFrame = frame;
            expandFrame(model, frame, scratch);
            const gpu = (mesh as unknown as { _gpu: { positionBuffer: GPUBuffer } })._gpu;
            this.device.queue.writeBuffer(gpu.positionBuffer, 0, scratch.buffer, scratch.byteOffset, scratch.byteLength);
        }
    }
}
