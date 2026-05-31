// First-person creative controls: pointer-lock mouse-look, WASD walking with
// gravity + jump and voxel AABB collision (no flying), raycast-based block
// break/place, and hotbar selection. Drives the free camera and asks the chunk
// renderer to re-mesh edited chunks (plus the neighbours an edit can influence,
// including diagonals, for correct AO).

import { createFreeCamera, type FreeCamera, type SceneContext } from "babylon-lite";

import { Block, HOTBAR, blockDef, blockColor, isIndestructible } from "./blocks.js";
import { CHUNK_SX, CHUNK_SZ, WORLD_H } from "./constants.js";
import type { World } from "./world.js";
import type { ChunkRenderer } from "./chunk-renderer.js";
import type { Highlight } from "./highlight.js";
import type { Hud } from "./hud.js";
import type { ParticleSystem } from "./particles.js";
import { initAudio, playBreak, playPlace, playStep } from "./audio.js";
import { raycastVoxel, type RayHit } from "./raycast.js";
import type { FallingBlocks } from "./falling-blocks.js";
import type { WaterSim } from "./water-sim.js";

const REACH = 7;
const WALK_SPEED = 5.6; // blocks/sec
const SPRINT = 1.6;
const LOOK_SENS = 0.0022;
const GRAVITY = 30; // blocks/sec^2
const JUMP_VELOCITY = 9.2; // blocks/sec — clears a 1-block step
const MAX_FALL = 55;
// Swimming: while submerged the player floats with heavy drag. Holding jump
// (Space) drives a steady ascent; otherwise they sink gently. Velocities are
// eased toward the target each frame so motion feels buoyant, not snappy.
const SWIM_UP_SPEED = 4.6; // blocks/sec — ascent while holding Space in water
const SWIM_SINK_SPEED = 1.7; // blocks/sec — gentle passive sink
const WATER_DRAG = 9; // velocity-easing rate toward the swim target
const PLAYER_HALF_W = 0.3; // half collision width (0.6 wide, < 1 block)
const PLAYER_HEIGHT = 1.8;
const EYE_HEIGHT = 1.62; // feet -> camera

export class PlayerController {
    readonly camera: FreeCamera;
    private readonly world: World;
    private readonly renderer: ChunkRenderer;
    private readonly highlight: Highlight;
    private readonly hud: Hud;
    private readonly canvas: HTMLCanvasElement;
    private readonly particles: ParticleSystem;
    private readonly falling: FallingBlocks;
    private readonly water: WaterSim;

    private x: number;
    /** Y of the player's feet (bottom of the AABB). Eye/camera = feetY + EYE_HEIGHT. */
    private feetY: number;
    private z: number;
    private vy = 0;
    private onGround = false;
    private yaw = 0;
    private pitch = -0.2;
    private locked = false;
    private readonly keys = new Set<string>();
    private target: RayHit | null = null;
    /** Horizontal distance walked since the last footstep sound. */
    private stepAccum = 0;

    constructor(scene: SceneContext, world: World, renderer: ChunkRenderer, highlight: Highlight, hud: Hud, canvas: HTMLCanvasElement, particles: ParticleSystem, falling: FallingBlocks, water: WaterSim) {
        this.world = world;
        this.renderer = renderer;
        this.highlight = highlight;
        this.hud = hud;
        this.canvas = canvas;
        this.particles = particles;
        this.falling = falling;
        this.water = water;

        const spawn = world.findSpawn(8, 8);
        this.x = spawn.x;
        this.feetY = spawn.y;
        this.z = spawn.z;

        const eye = this.feetY + EYE_HEIGHT;
        this.camera = createFreeCamera({ x: this.x, y: eye, z: this.z }, { x: this.x + 1, y: eye, z: this.z });
        this.camera.nearPlane = 0.1;
        this.camera.farPlane = 1000;
        scene.camera = this.camera;

        this.bindEvents();
    }

    /** Snapshot the player's transform (for save/load). */
    getState(): { x: number; y: number; z: number; yaw: number; pitch: number } {
        return { x: this.x, y: this.feetY, z: this.z, yaw: this.yaw, pitch: this.pitch };
    }

    /** Restore the player's transform (used after loading a world). */
    setState(s: { x: number; y: number; z: number; yaw: number; pitch: number }): void {
        this.x = s.x;
        this.feetY = s.y;
        this.z = s.z;
        this.yaw = s.yaw;
        this.pitch = s.pitch;
        this.vy = 0;
        this.onGround = false;
    }

    private bindEvents(): void {
        const canvas = this.canvas;
        canvas.addEventListener("click", () => {
            if (!this.locked) void canvas.requestPointerLock();
            initAudio();
        });
        document.addEventListener("pointerlockchange", () => {
            this.locked = document.pointerLockElement === canvas;
            if (this.locked) this.hud.hideHelp();
        });
        document.addEventListener("mousemove", (e) => {
            if (!this.locked) return;
            this.yaw -= e.movementX * LOOK_SENS;
            this.pitch -= e.movementY * LOOK_SENS;
            this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
        });
        canvas.addEventListener("mousedown", (e) => {
            if (!this.locked) return;
            if (e.button === 0) this.breakBlock();
            else if (e.button === 2) this.placeBlock();
        });
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        window.addEventListener("keydown", (e) => {
            this.keys.add(e.code);
            if (e.code === "F3") {
                this.hud.toggleDebug();
                e.preventDefault();
            }
            if (e.code.startsWith("Digit")) {
                const raw = e.code.slice(5);
                const n = raw === "0" ? 10 : Number(raw);
                if (n >= 1 && n <= HOTBAR.length) this.hud.select(n - 1);
            }
            // Tab cycles the active hotbar slot (Shift+Tab cycles backwards).
            if (e.code === "Tab") {
                const dir = e.shiftKey ? -1 : 1;
                const next = (this.hud.selectedSlot + dir + HOTBAR.length) % HOTBAR.length;
                this.hud.select(next);
                e.preventDefault();
            }
            if (["Space", "ShiftLeft", "ArrowUp", "ArrowDown"].includes(e.code)) e.preventDefault();
        });
        window.addEventListener("keyup", (e) => this.keys.delete(e.code));
        window.addEventListener(
            "wheel",
            (e) => {
                if (!this.locked) return;
                const dir = Math.sign(e.deltaY);
                const next = (this.hud.selectedSlot + dir + HOTBAR.length) % HOTBAR.length;
                this.hud.select(next);
            },
            { passive: true }
        );
    }

    private forward(): [number, number, number] {
        const cp = Math.cos(this.pitch);
        return [cp * Math.cos(this.yaw), Math.sin(this.pitch), cp * Math.sin(this.yaw)];
    }

    private breakBlock(): void {
        if (!this.target) return;
        const { bx, by, bz } = this.target;
        const removed = this.world.getBlock(bx, by, bz);
        if (isIndestructible(removed)) return; // bedrock and other world-floor blocks can't be mined
        const aff = this.world.setBlock(bx, by, bz, Block.AIR);
        if (aff) {
            this.particles.burst(bx + 0.5, by + 0.5, bz + 0.5, blockColor(removed));
            playBreak();
            this.remeshAround(bx, bz);
            this.falling.onBreak(bx, by, bz);
            this.water.onBreak(bx, by, bz);
        }
    }

    private placeBlock(): void {
        if (!this.target) return;
        const { px, py, pz } = this.target;
        if (py < 0 || py >= WORLD_H) return;
        // Don't place a block overlapping the player's own body.
        if (this.intersectsPlayer(px, py, pz)) return;
        const block = HOTBAR[this.hud.selectedSlot] ?? Block.STONE;
        const aff = this.world.setBlock(px, py, pz, block);
        if (aff) {
            playPlace();
            this.remeshAround(px, pz);
            this.falling.onPlace(px, py, pz);
            this.water.onPlace(px, py, pz);
        }
    }

    /** Re-mesh the edited chunk (and a neighbour only when the edit is on the
     *  shared border). Delegated to the renderer's border-aware path so digging a
     *  block rebuilds ~1 chunk instead of a full 3x3 greedy+light neighbourhood. */
    private remeshAround(wx: number, wz: number): void {
        this.renderer.remeshEdit(wx, wz);
    }

    /** True if a solid (collidable) block occupies the given integer voxel. */
    private solidAt(bx: number, by: number, bz: number): boolean {
        if (by < 0) return true; // treat the void floor as solid so you can't fall forever
        if (by >= WORLD_H) return false;
        const d = blockDef(this.world.getBlock(bx, by, bz));
        return !!d && d.collidable;
    }

    /** Does the player's AABB at (x, fy, z) overlap any solid voxel? */
    private collides(x: number, fy: number, z: number): boolean {
        const minX = Math.floor(x - PLAYER_HALF_W);
        const maxX = Math.floor(x + PLAYER_HALF_W);
        const minY = Math.floor(fy);
        const maxY = Math.floor(fy + PLAYER_HEIGHT - 1e-4);
        const minZ = Math.floor(z - PLAYER_HALF_W);
        const maxZ = Math.floor(z + PLAYER_HALF_W);
        for (let bx = minX; bx <= maxX; bx++) {
            for (let by = minY; by <= maxY; by++) {
                for (let bz = minZ; bz <= maxZ; bz++) {
                    if (this.solidAt(bx, by, bz)) return true;
                }
            }
        }
        return false;
    }

    /** Would a block at integer voxel (px,py,pz) overlap the player's AABB? */
    private intersectsPlayer(px: number, py: number, pz: number): boolean {
        return (
            px >= Math.floor(this.x - PLAYER_HALF_W) &&
            px <= Math.floor(this.x + PLAYER_HALF_W) &&
            py >= Math.floor(this.feetY) &&
            py <= Math.floor(this.feetY + PLAYER_HEIGHT - 1e-4) &&
            pz >= Math.floor(this.z - PLAYER_HALF_W) &&
            pz <= Math.floor(this.z + PLAYER_HALF_W)
        );
    }

    /** True if the player's body is submerged enough to swim (water at the feet
     *  or chest cell). Water is non-collidable, so this only drives buoyancy. */
    private inWater(): boolean {
        const x = Math.floor(this.x);
        const z = Math.floor(this.z);
        return (
            this.world.getBlock(x, Math.floor(this.feetY), z) === Block.WATER ||
            this.world.getBlock(x, Math.floor(this.feetY + 0.9), z) === Block.WATER
        );
    }

    /** Horizontal move on one axis: apply only if it doesn't enter a wall (slides). */
    private moveHorizontal(dx: number, dz: number): void {
        if (dx !== 0 && !this.collides(this.x + dx, this.feetY, this.z)) this.x += dx;
        if (dz !== 0 && !this.collides(this.x, this.feetY, this.z + dz)) this.z += dz;
    }

    /** Vertical move with snap-to-contact; updates onGround / cancels vy on impact. */
    private moveVertical(dy: number): void {
        const ny = this.feetY + dy;
        if (!this.collides(this.x, ny, this.z)) {
            this.feetY = ny;
            this.onGround = false;
            return;
        }
        if (dy < 0) {
            // Landed: snap feet to the top face of the block below.
            this.feetY = Math.floor(ny) + 1;
            this.onGround = true;
        } else if (dy > 0) {
            // Bumped head: snap so the head sits just under the ceiling block.
            this.feetY = Math.floor(ny + PLAYER_HEIGHT) - PLAYER_HEIGHT;
        }
        this.vy = 0;
    }

    update(dt: number): void {
        const [fx, fy, fz] = this.forward();
        // Horizontal basis for WASD (look direction flattened to the ground plane).
        const flatLen = Math.hypot(fx, fz) || 1;
        const hx = fx / flatLen;
        const hz = fz / flatLen;
        const rx = hz;
        const rz = -hx;

        let mx = 0;
        let mz = 0;
        if (this.keys.has("KeyW")) {
            mx += hx;
            mz += hz;
        }
        if (this.keys.has("KeyS")) {
            mx -= hx;
            mz -= hz;
        }
        if (this.keys.has("KeyD")) {
            mx += rx;
            mz += rz;
        }
        if (this.keys.has("KeyA")) {
            mx -= rx;
            mz -= rz;
        }

        let dx = 0;
        let dz = 0;
        const len = Math.hypot(mx, mz);
        if (len > 0) {
            const sprint = this.keys.has("ShiftLeft") ? SPRINT : 1;
            const sp = (WALK_SPEED * sprint * dt) / len;
            dx = mx * sp;
            dz = mz * sp;
        }

        // Jump on ground, or swim while submerged. In water the body floats with
        // heavy drag: holding Space ascends, releasing sinks gently — so you can
        // dive in and climb back out instead of sinking helplessly.
        if (this.inWater()) {
            const target = this.keys.has("Space") ? SWIM_UP_SPEED : -SWIM_SINK_SPEED;
            this.vy += (target - this.vy) * Math.min(1, WATER_DRAG * dt);
            this.onGround = false;
        } else {
            if (this.keys.has("Space") && this.onGround) {
                this.vy = JUMP_VELOCITY;
                this.onGround = false;
            }
            // Gravity integration.
            this.vy = Math.max(this.vy - GRAVITY * dt, -MAX_FALL);
        }

        // Resolve movement axis-by-axis against the voxel grid.
        const beforeX = this.x;
        const beforeZ = this.z;
        this.moveHorizontal(dx, dz);
        this.moveVertical(this.vy * dt);
        this.feetY = Math.max(1, Math.min(WORLD_H - PLAYER_HEIGHT, this.feetY));

        // Footsteps: accumulate ground distance actually travelled and thud per step.
        if (this.onGround) {
            this.stepAccum += Math.hypot(this.x - beforeX, this.z - beforeZ);
            if (this.stepAccum >= 2.2) {
                this.stepAccum = 0;
                playStep();
            }
        } else {
            this.stepAccum = 0;
        }

        // Camera transform (eye sits above the feet).
        const eye = this.feetY + EYE_HEIGHT;
        this.camera.position.x = this.x;
        this.camera.position.y = eye;
        this.camera.position.z = this.z;
        this.camera.target.x = this.x + fx;
        this.camera.target.y = eye + fy;
        this.camera.target.z = this.z + fz;

        // Stream chunks around the player.
        this.renderer.update(this.x, this.z);

        // Targeted block + selection outline (ray from the eye).
        this.target = raycastVoxel(this.world, this.x, eye, this.z, fx, fy, fz, REACH);
        if (this.target) this.highlight.show(this.target.bx, this.target.by, this.target.bz);
        else this.highlight.hide();
    }

    debugText(fps: number, chunks: number, clock: string): string {
        const f = this.forward();
        return (
            `Voxel Sandbox (Babylon Lite)\n` +
            `xyz ${this.x.toFixed(1)} ${this.feetY.toFixed(1)} ${this.z.toFixed(1)}  ${this.onGround ? "grounded" : "airborne"}\n` +
            `chunk ${Math.floor(this.x / CHUNK_SX)},${Math.floor(this.z / CHUNK_SZ)}  facing ${f[0].toFixed(2)},${f[2].toFixed(2)}\n` +
            `fps ${fps.toFixed(0)}  active chunks ${chunks}  time ${clock}`
        );
    }
}
