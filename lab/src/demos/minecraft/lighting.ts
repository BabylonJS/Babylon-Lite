// Day-night light manager. A single source of truth for the world's lighting:
// it owns a time-of-day phase, advances it each frame, and derives the sun
// direction plus all dependent colours (sun, ambient sky light, fog/horizon,
// zenith). It then fans those out to the sky dome, the voxel materials and the
// scene clear colour so everything stays consistent (fog === horizon === clear).
//
// timeOfDay is in [0,1): 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.

import type { SceneContext } from "babylon-lite";

import type { Sky } from "./sky.js";
import type { ChunkRenderer } from "./chunk-renderer.js";

type Vec3 = [number, number, number];

// Palette keyframes (linear-ish sRGB). Night values are floored so the world is
// always readable; fog/zenith never reach pure black.
const DAY_AMBIENT: Vec3 = [0.45, 0.48, 0.55];
const NIGHT_AMBIENT: Vec3 = [0.12, 0.14, 0.22];
const SUNSET_AMBIENT_TINT: Vec3 = [0.12, 0.05, 0.02];

const DAY_SUN: Vec3 = [0.55, 0.5, 0.42];
const SUNSET_SUN: Vec3 = [0.85, 0.42, 0.16];

const DAY_FOG: Vec3 = [0.7, 0.82, 0.92];
const NIGHT_FOG: Vec3 = [0.03, 0.04, 0.09];
const SUNSET_FOG: Vec3 = [0.8, 0.52, 0.4];

const DAY_ZENITH: Vec3 = [0.28, 0.5, 0.86];
const NIGHT_ZENITH: Vec3 = [0.02, 0.03, 0.08];
const SUNSET_ZENITH: Vec3 = [0.3, 0.3, 0.55];

function clamp01(x: number): number {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function add3(a: Vec3, b: Vec3, scale: number): Vec3 {
    return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

export interface LightingOptions {
    /** Real seconds for one full day-night cycle. */
    dayLengthSec?: number;
    /** Starting time-of-day in [0,1). Defaults to mid-morning. */
    startTimeOfDay?: number;
}

export interface LightingSnapshot {
    sunDir: Vec3;
    sunColor: Vec3;
    ambientColor: Vec3;
    fogColor: Vec3;
    zenithColor: Vec3;
}

export class Lighting {
    private readonly dayLength: number;
    private timeOfDay: number;

    private _sunDir: Vec3 = [0, 1, 0];
    private _sunColor: Vec3 = [0, 0, 0];
    private _ambient: Vec3 = [0, 0, 0];
    private _fog: Vec3 = [0, 0, 0];
    private _zenith: Vec3 = [0, 0, 0];

    constructor(opts: LightingOptions = {}) {
        this.dayLength = opts.dayLengthSec ?? 150;
        this.timeOfDay = ((opts.startTimeOfDay ?? 0.32) % 1 + 1) % 1;
        this.recompute();
    }

    /** Current time-of-day in [0,1) (for save/load). */
    get time(): number {
        return this.timeOfDay;
    }
    set time(t: number) {
        this.timeOfDay = ((t % 1) + 1) % 1;
        this.recompute();
    }

    /** Advance the clock and recompute all lighting values. */
    tick(dtSec: number): void {
        this.timeOfDay = (this.timeOfDay + dtSec / this.dayLength) % 1;
        this.recompute();
    }

    private recompute(): void {
        // Sun orbits east (+x at sunrise) -> overhead at noon -> west at sunset,
        // with a small fixed tilt on z so faces aren't lit perfectly axis-aligned.
        const theta = (this.timeOfDay - 0.25) * Math.PI * 2;
        const sx = Math.cos(theta);
        const sy = Math.sin(theta);
        const sz = 0.3;
        const inv = 1 / Math.hypot(sx, sy, sz);
        this._sunDir = [sx * inv, sy * inv, sz * inv];
        const elev = this._sunDir[1];

        const day = smoothstep(-0.05, 0.25, elev);
        // Twilight peaks when the sun sits near the horizon, faded out deep at night.
        const nearHorizon = clamp01(1 - Math.abs(elev) / 0.25);
        const twilight = nearHorizon * nearHorizon * smoothstep(-0.2, -0.04, elev);

        // Ambient sky light: cool night -> bright day, with a warm dusk/dawn tint.
        this._ambient = add3(lerp3(NIGHT_AMBIENT, DAY_AMBIENT, day), SUNSET_AMBIENT_TINT, twilight);

        // Direct sun: warm at the horizon, white-ish at noon, off below the horizon.
        const sunIntensity = smoothstep(-0.05, 0.15, elev);
        const warmToWhite = smoothstep(0.08, 0.35, elev);
        this._sunColor = lerp3(SUNSET_SUN, DAY_SUN, warmToWhite).map((c) => c * sunIntensity) as Vec3;

        // Fog/horizon (kept identical to the scene clear colour for a seamless edge).
        const fog = lerp3(NIGHT_FOG, DAY_FOG, day);
        this._fog = lerp3(fog, SUNSET_FOG, twilight * 0.7);

        const zenith = lerp3(NIGHT_ZENITH, DAY_ZENITH, day);
        this._zenith = lerp3(zenith, SUNSET_ZENITH, twilight * 0.5);
    }

    snapshot(): LightingSnapshot {
        return { sunDir: this._sunDir, sunColor: this._sunColor, ambientColor: this._ambient, fogColor: this._fog, zenithColor: this._zenith };
    }

    /** Push the current lighting to the sky dome, voxel materials and clear colour. */
    applyTo(sky: Sky, renderer: ChunkRenderer, scene: SceneContext): void {
        sky.setSun(this._sunDir);
        sky.setColors(this._fog, this._zenith);
        renderer.setSun(this._sunDir, this._sunColor);
        renderer.setAmbient(this._ambient);
        renderer.setFog(this._fog);
        scene.clearColor = { r: this._fog[0], g: this._fog[1], b: this._fog[2], a: 1 };
    }

    /** 24-hour clock string for the HUD (e.g. "06:45"). */
    clockText(): string {
        const mins = Math.floor(this.timeOfDay * 24 * 60);
        const hh = Math.floor(mins / 60);
        const mm = mins % 60;
        return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }
}
