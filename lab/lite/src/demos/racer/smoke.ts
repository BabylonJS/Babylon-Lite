/**
 * Racer drift smoke — the kit's tyre-smoke effect, reproduced with Lite's
 * camera-facing billboard sprites (the CC0 `smoke.png` puff). Puffs spawn at the
 * rear wheels while the car drifts, then rise, expand and fade.
 *
 * Emission is gated on the vehicle's `driftIntensity` (kit: `|speed − accel| +
 * |lean|·2 > 0.25`), matching `effect_trails()` in the original `vehicle.gd`.
 */

import type { BillboardSpriteHandle, EngineContext, FacingBillboardSpriteSystem, SceneContext } from "babylon-lite";
import {
    addBillboardSprite,
    addFacingBillboardSystem,
    billboardBlendAlpha,
    createFacingBillboardSystem,
    loadSpriteAtlas,
    removeBillboardSprite,
    updateBillboardSprite,
} from "babylon-lite";

const CAPACITY = 96; // max simultaneous puffs
const DRIFT_THRESHOLD = 0.25; // kit's `drift_intensity > 0.25`
const SPAWN_RATE = 46; // puffs/second at full intensity (across both rear wheels)
const SMOKE_COLOR: readonly [number, number, number] = [0.86, 0.86, 0.9];

/** World-space emit point (a rear wheel). */
export interface EmitPoint {
    x: number;
    y: number;
    z: number;
}

interface Puff {
    handle: BillboardSpriteHandle;
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    age: number;
    life: number;
    peakAlpha: number;
    size0: number;
    size1: number;
}

/** A pool of billboard smoke puffs emitted from the car's rear wheels while drifting. */
export class DriftSmoke {
    private readonly _system: FacingBillboardSpriteSystem;
    private readonly _live: Puff[] = [];
    private _accum = 0;

    private constructor(system: FacingBillboardSpriteSystem) {
        this._system = system;
    }

    /** Load the smoke sprite and register a facing-billboard system with the scene. */
    static async create(engine: EngineContext, scene: SceneContext, url: string): Promise<DriftSmoke> {
        const atlas = await loadSpriteAtlas(engine, url, { gridSize: [256, 256], sampling: "linear" });
        const system = createFacingBillboardSystem(atlas, { capacity: CAPACITY, blendMode: billboardBlendAlpha });
        addFacingBillboardSystem(scene, system);
        return new DriftSmoke(system);
    }

    /**
     * Advance the effect one frame.
     * @param dt Seconds since the last frame.
     * @param intensity Vehicle drift intensity (emits above the kit's 0.25 threshold).
     * @param emit World-space emit points (the rear wheels).
     */
    update(dt: number, intensity: number, emit: readonly EmitPoint[]): void {
        // Spawn new puffs proportionally to how hard the car is drifting.
        if (intensity > DRIFT_THRESHOLD && emit.length > 0) {
            this._accum += SPAWN_RATE * Math.min(1, (intensity - DRIFT_THRESHOLD) / 0.5) * dt;
            while (this._accum >= 1 && this._live.length < CAPACITY) {
                this._accum -= 1;
                this._spawn(emit[(Math.random() * emit.length) | 0]!);
            }
        } else {
            this._accum = 0;
        }

        // Integrate + fade live puffs; recycle the dead ones.
        for (let i = this._live.length - 1; i >= 0; i--) {
            const p = this._live[i]!;
            p.age += dt;
            const t = p.age / p.life;
            if (t >= 1) {
                removeBillboardSprite(p.handle);
                this._live.splice(i, 1);
                continue;
            }
            p.vy += dt * 0.4; // gentle buoyancy
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;
            const size = p.size0 + (p.size1 - p.size0) * t;
            const fade = t < 0.2 ? t / 0.2 : (1 - t) / 0.8; // quick fade-in, slow fade-out
            const a = p.peakAlpha * fade;
            updateBillboardSprite(p.handle, { position: [p.x, p.y, p.z], sizeWorld: [size, size], color: [SMOKE_COLOR[0], SMOKE_COLOR[1], SMOKE_COLOR[2], a] });
        }
    }

    private _spawn(at: EmitPoint): void {
        const x = at.x + (Math.random() - 0.5) * 0.18;
        const y = at.y + (Math.random() - 0.5) * 0.1;
        const z = at.z + (Math.random() - 0.5) * 0.18;
        const size0 = 0.3 + Math.random() * 0.15;
        const handle = addBillboardSprite(this._system, {
            position: [x, y, z],
            sizeWorld: [size0, size0],
            frame: 0,
            color: [SMOKE_COLOR[0], SMOKE_COLOR[1], SMOKE_COLOR[2], 0],
        });
        this._live.push({
            handle,
            x,
            y,
            z,
            vx: (Math.random() - 0.5) * 0.5,
            vy: 0.5 + Math.random() * 0.5,
            vz: (Math.random() - 0.5) * 0.5,
            age: 0,
            life: 0.55 + Math.random() * 0.35,
            peakAlpha: 0.4 + Math.random() * 0.15,
            size0,
            size1: 1.0 + Math.random() * 0.5,
        });
    }
}
