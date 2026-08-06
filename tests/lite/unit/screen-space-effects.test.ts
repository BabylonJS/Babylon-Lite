/**
 * Unit tests for the screen-space contact-shadow / global-illumination effects
 * (see `docs/lite/architecture/52-screen-space-effects.md`).
 *
 * Split into three groups:
 *   1. Pure math/state functions (reset matrix, accumulation ramp, phase window,
 *      reprojection rejection, resolution scaling, config clamping) — no GPU device.
 *   2. WGSL-contract assertions — the generated shader source contains the documented
 *      history layouts and dual-surface/tangent-plane/hemisphere contracts, and the two
 *      producers stay free of each other's kind-specific helpers (tree-shake separation).
 *   3. Task-lifecycle integration tests against a mock GPU device — validation errors,
 *      the disabled/enabled identity transitions, and same-size source-identity rebuilds.
 */
import { describe, expect, it } from "vitest";

import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { getViewProjectionMatrix } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createRenderTarget, type RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { mat4Invert } from "../../../packages/babylon-lite/src/math/mat4-invert";
import {
    createScreenSpaceContactShadowsPostProcessTask,
    clampScreenSpaceContactShadowsConfig,
    screenSpaceContactShadowsProducerWGSL,
    SS_CONTACT_PRODUCER_UNIFORM_FLOATS,
} from "../../../packages/babylon-lite/src/post-process/screen-space-contact-shadows";
import {
    createScreenSpaceGlobalIlluminationPostProcessTask,
    clampScreenSpaceGlobalIlluminationConfig,
    screenSpaceGlobalIlluminationProducerWGSL,
    SS_GI_PRODUCER_UNIFORM_FLOATS,
} from "../../../packages/babylon-lite/src/post-process/screen-space-global-illumination";
import { screenSpaceRaymarchWGSL } from "../../../packages/babylon-lite/src/post-process/screen-space-raymarch-wgsl";
import {
    advanceAccumulation,
    advancePhaseWindow,
    assertScreenSpaceTargetNotAliasingSource,
    clampScreenSpaceResolutionScale,
    computeScreenSpaceScaledSize,
    computeTemporalWeight,
    decideScreenSpaceReset,
    identityChanged,
    isHistoryAccepted,
    phaseValue,
    resolveScreenSpaceSourceSize,
    screenSpaceTemporalResolveWGSL,
    SS_TEMPORAL_UNIFORM_FLOATS,
    type ScreenSpacePhaseWindow,
    type ScreenSpaceResetEvent,
} from "../../../packages/babylon-lite/src/post-process/screen-space-temporal";

function transformPoint(matrix: ArrayLike<number>, point: readonly [number, number, number]): [number, number, number, number] {
    const [x, y, z] = point;
    return [
        matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
        matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
        matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
        matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!,
    ];
}

function projectWorld(matrix: ArrayLike<number>, point: readonly [number, number, number]): [number, number, number] {
    const clip = transformPoint(matrix, point);
    return [(clip[0] / clip[3]) * 0.5 + 0.5, 0.5 - (clip[1] / clip[3]) * 0.5, clip[2] / clip[3]];
}

function reconstructWorld(matrix: ArrayLike<number>, uvDepth: readonly [number, number, number]): [number, number, number] {
    const clip = transformPoint(matrix, [uvDepth[0] * 2 - 1, 1 - uvDepth[1] * 2, uvDepth[2]]);
    return [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
}

function cross(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: readonly [number, number, number]): [number, number, number] {
    const length = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / length, v[1] / length, v[2] / length];
}

function dualSurfaceOccluded(rayDistance: number, discreteDistance: number, continuousDistance: number, bias: number, thickness: number): boolean {
    return (
        rayDistance > discreteDistance + bias &&
        rayDistance > continuousDistance + bias &&
        rayDistance - discreteDistance < thickness &&
        rayDistance - continuousDistance < thickness
    );
}

// ─── 1. Pure math/state ─────────────────────────────────────────────────────

describe("computeTemporalWeight", () => {
    it("uses the configured floor once enough samples have accumulated", () => {
        expect(computeTemporalWeight(1 / 32, 1)).toBe(1);
        expect(computeTemporalWeight(1 / 32, 2)).toBeCloseTo(0.5, 10);
        expect(computeTemporalWeight(1 / 32, 32)).toBeCloseTo(1 / 32, 10);
        expect(computeTemporalWeight(1 / 32, 64)).toBeCloseTo(1 / 32, 10); // floor, not 1/64
    });
});

describe("advanceAccumulation", () => {
    it("resets to 1 and otherwise increments, clamped at temporalSamples", () => {
        expect(advanceAccumulation(5, true, 32)).toBe(1);
        expect(advanceAccumulation(1, false, 32)).toBe(2);
        expect(advanceAccumulation(32, false, 32)).toBe(32);
        expect(advanceAccumulation(31, false, 32)).toBe(32);
    });
});

describe("advancePhaseWindow / phaseValue", () => {
    it("restart reopens the window at temporalSamples and zeroes the index", () => {
        const state: ScreenSpacePhaseWindow = { index: 9, remaining: 0 };
        const next = advancePhaseWindow(state, false, true, 16);
        expect(next).toEqual({ index: 0, remaining: 16 });
    });

    it("camera motion alone reopens the window but keeps advancing the index", () => {
        const state: ScreenSpacePhaseWindow = { index: 3, remaining: 0 };
        const next = advancePhaseWindow(state, true, false, 16);
        expect(next).toEqual({ index: 4, remaining: 16 });
    });

    it("drains by one frame per call while stationary, then freezes", () => {
        let state: ScreenSpacePhaseWindow = { index: 0, remaining: 2 };
        state = advancePhaseWindow(state, false, false, 16);
        expect(state).toEqual({ index: 1, remaining: 1 });
        state = advancePhaseWindow(state, false, false, 16);
        expect(state).toEqual({ index: 2, remaining: 0 });
        const frozen = advancePhaseWindow(state, false, false, 16);
        expect(frozen).toEqual({ index: 2, remaining: 0 }); // frozen: same reference-equal value
        expect(frozen).toBe(state);
    });

    it("phaseValue wraps into [0, 1) modulo temporalSamples", () => {
        expect(phaseValue(0, 8)).toBe(0);
        expect(phaseValue(4, 8)).toBe(0.5);
        expect(phaseValue(8, 8)).toBe(0);
        expect(phaseValue(9, 8)).toBe(0.125);
    });
});

describe("decideScreenSpaceReset (reset matrix)", () => {
    const base: ScreenSpaceResetEvent = {
        firstAllocation: false,
        targetReallocated: false,
        sourceIdentityChanged: false,
        resetVersionChanged: false,
        enabledTransitionedOn: false,
        singularInverse: false,
        cameraMoved: false,
    };

    it("first allocation invalidates history and restarts phase", () => {
        expect(decideScreenSpaceReset({ ...base, firstAllocation: true })).toEqual({ invalidateHistory: true, restartPhase: true });
    });
    it("owned-target reallocation invalidates history and restarts phase", () => {
        expect(decideScreenSpaceReset({ ...base, targetReallocated: true })).toEqual({ invalidateHistory: true, restartPhase: true });
    });
    it("source/depth identity change invalidates history and restarts phase", () => {
        expect(decideScreenSpaceReset({ ...base, sourceIdentityChanged: true })).toEqual({ invalidateHistory: true, restartPhase: true });
    });
    it("camera movement keeps history and lets the phase window advance without resetting its index", () => {
        expect(decideScreenSpaceReset({ ...base, cameraMoved: true })).toEqual({ invalidateHistory: false, restartPhase: false });
        expect(advancePhaseWindow({ index: 7, remaining: 0 }, true, false, 16)).toEqual({ index: 8, remaining: 16 });
    });
    it("resetVersion change invalidates history and restarts phase", () => {
        expect(decideScreenSpaceReset({ ...base, resetVersionChanged: true })).toEqual({ invalidateHistory: true, restartPhase: true });
    });
    it("disabled -> enabled invalidates history and restarts phase", () => {
        expect(decideScreenSpaceReset({ ...base, enabledTransitionedOn: true })).toEqual({ invalidateHistory: true, restartPhase: true });
    });
    it("singular inverse view-projection invalidates history and restarts phase", () => {
        expect(decideScreenSpaceReset({ ...base, singularInverse: true })).toEqual({ invalidateHistory: true, restartPhase: true });
    });
    it("an unrelated frame-graph rebuild with no events changes nothing", () => {
        expect(decideScreenSpaceReset(base)).toEqual({ invalidateHistory: false, restartPhase: false });
    });
});

describe("isHistoryAccepted (reprojection rejection)", () => {
    it("rejects when no valid distance was ever stored", () => {
        expect(isHistoryAccepted(10, 0)).toBe(false);
        expect(isHistoryAccepted(10, -1)).toBe(false);
    });
    it("accepts within the 4% relative threshold", () => {
        expect(isHistoryAccepted(100, 103.9)).toBe(true);
        expect(isHistoryAccepted(100, 96.1)).toBe(true);
    });
    it("rejects beyond the 4% relative threshold", () => {
        expect(isHistoryAccepted(100, 105)).toBe(false);
        expect(isHistoryAccepted(100, 95)).toBe(false);
    });
    it("uses a 0.001 floor for the denominator near zero expected distance", () => {
        // rel = 0.00005 / max(0, 0.001) = 0.05 > 0.04 threshold -> rejected.
        expect(isHistoryAccepted(0, 0.00005)).toBe(false);
        // rel = 0.00003 / 0.001 = 0.03 <= 0.04 threshold -> accepted.
        expect(isHistoryAccepted(0, 0.00003)).toBe(true);
    });
});

describe("identityChanged", () => {
    it("detects null <-> non-null and reference changes", () => {
        const a = {};
        const b = {};
        expect(identityChanged(null, null)).toBe(false);
        expect(identityChanged(null, a)).toBe(true);
        expect(identityChanged(a, null)).toBe(true);
        expect(identityChanged(a, a)).toBe(false);
        expect(identityChanged(a, b)).toBe(true);
    });
});

describe("resolution scale + sizing helpers", () => {
    it("clamps resolution scale to [0.25, 1]", () => {
        expect(clampScreenSpaceResolutionScale(2)).toBe(1);
        expect(clampScreenSpaceResolutionScale(0)).toBe(0.25);
        expect(clampScreenSpaceResolutionScale(0.6)).toBe(0.6);
    });
    it("scales and rounds dimensions, clamped to at least 1 pixel", () => {
        expect(computeScreenSpaceScaledSize(1000, 500, 0.5)).toEqual({ width: 500, height: 250 });
        expect(computeScreenSpaceScaledSize(1, 1, 0.25)).toEqual({ width: 1, height: 1 });
    });
    it("resolves size from built dimensions when available, else the descriptor", () => {
        const built = { _width: 64, _height: 32, _descriptor: { size: { width: 999, height: 999 } } } as unknown as RenderTarget;
        expect(resolveScreenSpaceSourceSize(built)).toEqual({ width: 64, height: 32 });
        const unbuilt = { _width: 0, _height: 0, _descriptor: { size: { width: 128, height: 72 } } } as unknown as RenderTarget;
        expect(resolveScreenSpaceSourceSize(unbuilt)).toEqual({ width: 128, height: 72 });
    });
});

describe("screen-space reconstruction math", () => {
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 5, { x: 0, y: 0, z: 0 });
    const viewProjection = getViewProjectionMatrix(camera, 16 / 9);
    const inverse = mat4Invert(viewProjection)!;

    it("round-trips world position through top-left UV and reverse-Z depth", () => {
        const world: [number, number, number] = [0.35, 0, 0.2];
        const reconstructed = reconstructWorld(inverse, projectWorld(viewProjection, world));
        expect(reconstructed[0]).toBeCloseTo(world[0], 5);
        expect(reconstructed[1]).toBeCloseTo(world[1], 5);
        expect(reconstructed[2]).toBeCloseTo(world[2], 5);
    });

    it("orders screen-right and screen-down derivatives into an outward +Y ground normal", () => {
        const center: [number, number, number] = [0, 0, 0];
        const right: [number, number, number] = [0.1, 0, 0];
        const zA: [number, number, number] = [0, 0, -0.1];
        const zB: [number, number, number] = [0, 0, 0.1];
        const centerUv = projectWorld(viewProjection, center);
        const down = projectWorld(viewProjection, zA)[1] > centerUv[1] ? zA : zB;
        const horizontal: [number, number, number] = [right[0] - center[0], right[1] - center[1], right[2] - center[2]];
        const vertical: [number, number, number] = [down[0] - center[0], down[1] - center[1], down[2] - center[2]];
        const normal = normalize(cross(horizontal, vertical));
        expect(normal[1]).toBeGreaterThan(0.99);
    });

    it("requires both depth estimates and the thickness slab for an intersection", () => {
        expect(dualSurfaceOccluded(1, 0.8, 0.82, 0.02, 0.5)).toBe(true);
        expect(dualSurfaceOccluded(1, 0.8, 1.2, 0.02, 0.5)).toBe(false);
        expect(dualSurfaceOccluded(2, 0.8, 0.82, 0.02, 0.5)).toBe(false);
    });

    it("gives separate geometry above a receiver positive tangent-plane clearance", () => {
        const receiver: [number, number, number] = [0, 0, 0];
        const candidate: [number, number, number] = [0.1, 0.2, 0.1];
        const normal: [number, number, number] = [0, 1, 0];
        const clearance = (candidate[0] - receiver[0]) * normal[0] + (candidate[1] - receiver[1]) * normal[1] + (candidate[2] - receiver[2]) * normal[2];
        expect(clearance).toBeCloseTo(0.2);
    });
});

describe("assertScreenSpaceTargetNotAliasingSource", () => {
    it("throws when target === source", () => {
        const rt = createRenderTarget({ format: "bgra8unorm", samples: 1, size: { width: 1, height: 1 } });
        expect(() => assertScreenSpaceTargetNotAliasingSource("test", rt, rt)).toThrow();
    });
    it("does not throw for null/undefined/different targets", () => {
        const source = createRenderTarget({ format: "bgra8unorm", samples: 1, size: { width: 1, height: 1 } });
        const target = createRenderTarget({ format: "bgra8unorm", samples: 1, size: { width: 1, height: 1 } });
        expect(() => assertScreenSpaceTargetNotAliasingSource("test", null, source)).not.toThrow();
        expect(() => assertScreenSpaceTargetNotAliasingSource("test", undefined, source)).not.toThrow();
        expect(() => assertScreenSpaceTargetNotAliasingSource("test", target, source)).not.toThrow();
    });
});

describe("clampScreenSpaceContactShadowsConfig", () => {
    it("applies documented defaults", () => {
        const clamped = clampScreenSpaceContactShadowsConfig({} as never);
        expect(clamped.resolutionScale).toBe(1);
        expect(clamped.intensity).toBe(0.6);
        expect(clamped.tint).toEqual([0.35, 0.38, 0.48]);
        expect(clamped.stepCount).toBe(8);
        expect(clamped.maxDistance).toBe(0.3);
        expect(clamped.thickness).toBe(0.35);
        expect(clamped.bias).toBe(0.03);
        expect(clamped.normalBias).toBe(0.035);
        expect(clamped.temporalWeight).toBeCloseTo(1 / 32, 10);
        expect(clamped.temporalSamples).toBe(32);
    });
    it("clamps out-of-range inputs", () => {
        const clamped = clampScreenSpaceContactShadowsConfig({ resolutionScale: 5, intensity: -1, stepCount: 0, temporalSamples: 10000, normalBias: 0 } as never);
        expect(clamped.resolutionScale).toBe(1);
        expect(clamped.intensity).toBe(0);
        expect(clamped.stepCount).toBe(1);
        expect(clamped.temporalSamples).toBe(256);
        expect(clamped.normalBias).toBe(0.001);
    });
});

describe("clampScreenSpaceGlobalIlluminationConfig", () => {
    it("applies documented defaults", () => {
        const clamped = clampScreenSpaceGlobalIlluminationConfig({} as never);
        expect(clamped.resolutionScale).toBe(0.5);
        expect(clamped.intensity).toBe(1);
        expect(clamped.stepCount).toBe(8);
        expect(clamped.rayLength).toBe(2);
        expect(clamped.thickness).toBe(0.45);
        expect(clamped.bias).toBe(0.05);
        expect(clamped.fadeStart).toBe(20);
        expect(clamped.fadeEnd).toBe(60);
        expect(clamped.edgeFade).toBeCloseTo(0.1, 10);
        expect(clamped.temporalWeight).toBeCloseTo(1 / 64, 10);
        expect(clamped.temporalSamples).toBe(64);
        expect(clamped.colorBleedGain).toBe(1);
        expect(clamped.colorBleedMax).toBe(0.45);
    });
    it("forces fadeEnd to be at least fadeStart + 0.001", () => {
        const clamped = clampScreenSpaceGlobalIlluminationConfig({ fadeStart: 50, fadeEnd: 10 } as never);
        expect(clamped.fadeStart).toBe(50);
        expect(clamped.fadeEnd).toBeCloseTo(50.001, 10);
    });
});

// ─── 2. WGSL contracts ───────────────────────────────────────────────────────

describe("screenSpaceRaymarchWGSL (shared library)", () => {
    const src = screenSpaceRaymarchWGSL();

    it("is a pure string factory (deterministic, no shared mutable state)", () => {
        expect(screenSpaceRaymarchWGSL()).toBe(src);
    });

    it("contains reverse-Z clear-depth rejection", () => {
        expect(src).toContain("fn ssIsClearDepth(depth:f32)->bool{return depth<=0.0;}");
    });

    it("contains the top-left UV <-> NDC reconstruction/projection pair", () => {
        expect(src).toMatch(/ndc=vec3f\(uv\.x\*2\.0-1\.0,1\.0-uv\.y\*2\.0,depth\)/);
        expect(src).toMatch(/vec3f\(ndc\.x\*0\.5\+0\.5,0\.5-ndc\.y\*0\.5,ndc\.z\)/);
    });

    it("contains manual bilinear continuous depth (no hardware depth filtering)", () => {
        expect(src).toContain("fn ssBilinearDepth(");
        expect(src).toContain("mix(dx0,dx1,frac.y)");
    });

    it("contains closest-neighbor normal reconstruction", () => {
        expect(src).toContain("fn ssNormalFromDepth(");
        expect(src).toContain("if(coord.x<=0)");
        expect(src).toContain("else if(coord.x>=dim.x-1)");
        expect(src).toContain("if(coord.y<=0)");
        expect(src).toContain("else if(coord.y>=dim.y-1)");
        expect(src).toContain("if(n2<=1e-12){return vec3f(0.0,1.0,0.0);}");
    });

    it("contains the dual-surface intersection contract (behind both estimates + thickness slab)", () => {
        expect(src).toContain("struct SsHit{hit:bool,uv:vec2f,rayDist:f32,surfaceDist:f32}");
        expect(src).toContain("let behindDiscrete=rayDist>discreteDist+bias;");
        expect(src).toContain("let behindContinuous=rayDist>continuousDist+bias;");
        expect(src).toContain("let withinThickness=(rayDist-discreteDist)<thickness&&(rayDist-continuousDist)<thickness;");
        expect(src).toContain("let hit=behindDiscrete&&behindContinuous&&withinThickness;");
    });

    it("contains decorrelated screen-space noise and a bounded [0,1) phase rotation", () => {
        expect(src).toContain("fn ssHash(value:u32)->u32{");
        expect(src).toContain("fn ssScreenSpaceNoise(coord:vec2f)->f32{");
        expect(src).toContain("fn ssPhaseAngle(coord:vec2f,phase:f32)->f32{");
        expect(src).toContain("fract(ssScreenSpaceNoise(coord)+phase)");
    });
});

describe("screen-space-contact-shadows producer WGSL", () => {
    const src = screenSpaceContactShadowsProducerWGSL();

    it("binds depth as texture_depth_2d with no color source (depth-only producer)", () => {
        expect(src).toContain("var ssDepth:texture_depth_2d;");
        expect(src).not.toContain("texture_2d<f32>");
    });

    it("contains the contact-shadow-specific tangent-plane clearance test", () => {
        expect(src).toContain("fn ssTangentPlaneClearance(candidateWorld:vec3f,receiverWorld:vec3f,receiverNormal:vec3f)->f32{");
        expect(src).toContain("return dot(candidateWorld-receiverWorld,receiverNormal);");
        expect(src).toContain("let clearanceFoot=ssContact.normalBias*0.35;");
        expect(src).toContain("smoothstep(clearanceFoot,ssContact.normalBias,clearance)");
    });

    it("stays free of the GI-only hemisphere sampler and fused filter (tree-shake separation)", () => {
        expect(src).not.toContain("ssCosineHemisphere");
        expect(src).not.toContain("ssFusedGiFilter");
    });

    it("includes the shared raymarch library exactly once", () => {
        const occurrences = src.split("fn ssDualSurfaceHit(").length - 1;
        expect(occurrences).toBe(1);
    });

    it("has a 192-byte (16-byte aligned) producer uniform layout", () => {
        expect(SS_CONTACT_PRODUCER_UNIFORM_FLOATS).toBe(48);
        expect((SS_CONTACT_PRODUCER_UNIFORM_FLOATS * 4) % 16).toBe(0);
    });
});

describe("screen-space-global-illumination producer WGSL", () => {
    const src = screenSpaceGlobalIlluminationProducerWGSL();

    it("binds depth as texture_depth_2d AND the lit scene color as texture_2d<f32>", () => {
        expect(src).toContain("var ssGiDepth:texture_depth_2d;");
        expect(src).toContain("var ssGiColor:texture_2d<f32>;");
    });

    it("contains cosine-weighted hemisphere sampling", () => {
        expect(src).toContain("fn ssCosineHemisphere(n:vec3f,u1:f32,u2:f32)->vec3f{");
        expect(src).toContain("ssScreenSpaceNoise(vec2f(coord)*0.731+vec2f(11.317,31.179))");
    });

    it("samples the already-lit source color at the hit UV, gated by receiver-distance and screen-edge fades", () => {
        expect(src).toContain("textureSampleLevel(ssGiColor,ssGiColorSampler,hit.uv,0.0)");
        expect(src).toMatch(/smoothstep\(ssGi\.fadeStart,ssGi\.fadeEnd,hit\.rayDist\)/);
        expect(src).toContain("ssGi.edgeFade");
    });

    it("stays free of the contact-shadow-only tangent-plane clearance test (tree-shake separation)", () => {
        expect(src).not.toContain("ssTangentPlaneClearance");
    });

    it("has a 192-byte (16-byte aligned) producer uniform layout", () => {
        expect(SS_GI_PRODUCER_UNIFORM_FLOATS).toBe(48);
        expect((SS_GI_PRODUCER_UNIFORM_FLOATS * 4) % 16).toBe(0);
    });
});

describe("screen-space temporal resolve WGSL", () => {
    it("has a 288-byte uniform layout with separate effect and depth dimensions", () => {
        expect(SS_TEMPORAL_UNIFORM_FLOATS).toBe(72);
        expect((SS_TEMPORAL_UNIFORM_FLOATS * 4) % 16).toBe(0);
        expect(screenSpaceTemporalResolveWGSL("color")).toContain("effectDims:vec2f,depthDims:vec2f");
    });

    it("scalar (contact-shadow) resolve uses the rg16float layout: value in .r, view distance in .g", () => {
        const src = screenSpaceTemporalResolveWGSL("scalar");
        expect(src).toContain("historyValue=hist.r;");
        expect(src).toContain("let storedPrev=hist.g;");
        expect(src).not.toContain("ssFusedGiFilter");
    });

    it("color (GI) resolve uses the rgba16float layout: color in .rgb, view distance in .a, plus the fused five-tap filter", () => {
        const src = screenSpaceTemporalResolveWGSL("color");
        expect(src).toContain("historyValue=hist.rgb;");
        expect(src).toContain("let storedPrev=hist.a;");
        expect(src).toContain("fn ssFusedGiFilter(");
        expect(src).toContain("agreement=max(0.0,1.0-abs(nDist-centerDist)/max(centerDist,1e-4));");
        expect(src).toContain("let spatialWeights=array<f32,8>(0.75,0.75,0.75,0.75,0.5,0.5,0.5,0.5);");
    });

    it("both kinds reject reprojected history beyond the 4% relative view-distance threshold and blend via mix()", () => {
        for (const kind of ["scalar", "color"] as const) {
            const src = screenSpaceTemporalResolveWGSL(kind);
            expect(src).toContain("relErr<=0.04");
            expect(src).toMatch(/mix\(historyValue,rawValue,weight\)/);
        }
    });

    it("both kinds clamp accepted history only after reprojection moves at least one texel", () => {
        for (const kind of ["scalar", "color"] as const) {
            const src = screenSpaceTemporalResolveWGSL(kind);
            expect(src).toContain("moved=length((reproj.xy-uv)*effectDims)>=1.0;");
            expect(src).toContain("if(moved){");
            expect(src).toContain("historyValue=clamp(historyValue,mn,mx);");
        }
    });
});

// ─── 3. Task lifecycle (mock GPU device) ────────────────────────────────────

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage" | "GPUShaderStage" | "GPUTextureUsage"> & {
    GPUBufferUsage?: { UNIFORM: number; COPY_DST: number };
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
    GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number; COPY_DST: number };
};
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 } as unknown as GPUBufferUsage;
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4, COPY_SRC: 0x1, COPY_DST: 0x2 } as unknown as GPUTextureUsage;

interface Capture {
    beginRenderPassCount: number;
    draws: number;
}

function makeFakeTexture(): GPUTexture {
    return {
        createView: (opts?: GPUTextureViewDescriptor) => ({ aspect: opts?.aspect ?? "all" }) as unknown as GPUTextureView,
        destroy: () => undefined,
    } as unknown as GPUTexture;
}

function makeMockEngine(capture: Capture): EngineContext {
    const pass = {
        setViewport: () => undefined,
        setScissorRect: () => undefined,
        setBindGroup: () => undefined,
        setPipeline: () => undefined,
        draw: () => {
            capture.draws++;
        },
        end: () => undefined,
    } as unknown as GPURenderPassEncoder;

    const device = {
        createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => d as unknown as GPUBindGroupLayout,
        createBindGroup: (d: GPUBindGroupDescriptor) => d as unknown as GPUBindGroup,
        createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => d as unknown as GPUPipelineLayout,
        createRenderPipeline: (d: GPURenderPipelineDescriptor) => d as unknown as GPURenderPipeline,
        createShaderModule: (d: GPUShaderModuleDescriptor) => d as unknown as GPUShaderModule,
        createSampler: (d: GPUSamplerDescriptor) => d as unknown as GPUSampler,
        createBuffer: (d: GPUBufferDescriptor) => ({ descriptor: d, destroy: () => undefined }) as unknown as GPUBuffer,
        createTexture: (d: GPUTextureDescriptor) =>
            ({
                descriptor: d,
                format: d.format,
                sampleCount: d.sampleCount ?? 1,
                createView: (opts?: GPUTextureViewDescriptor) => ({ aspect: opts?.aspect ?? "all" }) as unknown as GPUTextureView,
                destroy: () => undefined,
            }) as unknown as GPUTexture,
        queue: { writeBuffer: () => undefined },
    } as unknown as GPUDevice;

    const eng = {
        canvas: { width: 128, height: 64 } as HTMLCanvasElement,
        msaaSamples: 1,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        _device: device,
        _currentEncoder: {
            beginRenderPass: () => {
                capture.beginRenderPassCount++;
                return pass;
            },
        } as unknown as GPUCommandEncoder,
        scRT: {
            _colorTexture: makeFakeTexture(),
            _colorView: {},
            _depthTexture: null,
            _depthView: null,
            _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 128, height: 64 } },
            _width: 128,
            _height: 64,
            _eager: true,
        } as unknown as RenderTarget,
        _currentDelta: 0,
        _cbs: [],
    } as unknown as EngineContext;
    Object.assign(eng, { engine: eng, surfaces: [eng], _surfaces: [eng] });
    return eng;
}

function makeSceneColorDepthRT(width: number, height: number): RenderTarget {
    const rt = createRenderTarget({ format: "bgra8unorm", dFormat: "depth24plus-stencil8", samples: 1, size: { width, height } });
    rt._colorTexture = makeFakeTexture();
    rt._colorView = {} as GPUTextureView;
    rt._depthTexture = makeFakeTexture();
    rt._depthView = {} as GPUTextureView;
    rt._width = width;
    rt._height = height;
    return rt;
}

describe("createScreenSpaceContactShadowsPostProcessTask validation", () => {
    it("throws when sourceTexture is multisampled", () => {
        const capture: Capture = { beginRenderPassCount: 0, draws: 0 };
        const engine = makeMockEngine(capture);
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const source = createRenderTarget({ format: "bgra8unorm", dFormat: "depth24plus-stencil8", samples: 4, size: { width: 64, height: 64 } });
        expect(() => createScreenSpaceContactShadowsPostProcessTask({ sourceTexture: source, camera, lightDirection: { x: 0, y: -1, z: 0 } }, engine)).toThrow(/single-sample/);
    });

    it("throws when the depth source has no depth attachment", () => {
        const capture: Capture = { beginRenderPassCount: 0, draws: 0 };
        const engine = makeMockEngine(capture);
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const source = createRenderTarget({ format: "bgra8unorm", samples: 1, size: { width: 64, height: 64 } });
        expect(() => createScreenSpaceContactShadowsPostProcessTask({ sourceTexture: source, camera, lightDirection: { x: 0, y: -1, z: 0 } }, engine)).toThrow(/depth attachment/);
    });

    it("throws when targetTexture aliases sourceTexture", () => {
        const capture: Capture = { beginRenderPassCount: 0, draws: 0 };
        const engine = makeMockEngine(capture);
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const source = makeSceneColorDepthRT(64, 64);
        expect(() =>
            createScreenSpaceContactShadowsPostProcessTask({ sourceTexture: source, camera, lightDirection: { x: 0, y: -1, z: 0 }, targetTexture: source }, engine)
        ).toThrow(/targetTexture must differ/);
    });
});

describe("createScreenSpaceGlobalIlluminationPostProcessTask validation", () => {
    it("throws when sourceTexture is multisampled", () => {
        const capture: Capture = { beginRenderPassCount: 0, draws: 0 };
        const engine = makeMockEngine(capture);
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const source = createRenderTarget({ format: "bgra8unorm", dFormat: "depth24plus-stencil8", samples: 4, size: { width: 64, height: 64 } });
        expect(() => createScreenSpaceGlobalIlluminationPostProcessTask({ sourceTexture: source, camera }, engine)).toThrow(/single-sample/);
    });

    it("throws when targetTexture aliases sourceTexture", () => {
        const capture: Capture = { beginRenderPassCount: 0, draws: 0 };
        const engine = makeMockEngine(capture);
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const source = makeSceneColorDepthRT(64, 64);
        expect(() => createScreenSpaceGlobalIlluminationPostProcessTask({ sourceTexture: source, camera, targetTexture: source }, engine)).toThrow(/targetTexture must differ/);
    });
});

describe("screen-space contact shadows task lifecycle", () => {
    it("records and executes without throwing, producing draw calls while enabled", () => {
        const capture: Capture = { beginRenderPassCount: 0, draws: 0 };
        const engine = makeMockEngine(capture);
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const source = makeSceneColorDepthRT(64, 64);

        const task = createScreenSpaceContactShadowsPostProcessTask({ sourceTexture: source, camera, lightDirection: { x: 0.2, y: -1, z: 0.1 }, composition: "none" }, engine);
        task.record();
        const draws1 = task.execute!();
        expect(draws1).toBeGreaterThan(0);
        expect(task.outputTexture).toBe(task.shadowTexture);
    });

    it("clears identity exactly once on the enabled -> disabled transition, then stays quiet", () => {
        const capture: Capture = { beginRenderPassCount: 0, draws: 0 };
        const engine = makeMockEngine(capture);
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const source = makeSceneColorDepthRT(64, 64);

        const task = createScreenSpaceContactShadowsPostProcessTask({ sourceTexture: source, camera, lightDirection: { x: 0, y: -1, z: 0 }, composition: "none" }, engine);
        task.record();
        task.execute!(); // enabled, establishes baseline

        task.enabled = false;
        const passesBeforeDisable = capture.beginRenderPassCount;
        task.execute!(); // enabled -> disabled: clearIdentity runs (2 passes: stable + history)
        const afterFirstDisable = capture.beginRenderPassCount;
        expect(afterFirstDisable).toBeGreaterThan(passesBeforeDisable);

        task.execute!(); // still disabled: no further clear passes
        expect(capture.beginRenderPassCount).toBe(afterFirstDisable);
    });

    it("rebuilds bind groups without throwing when the depth GPUTexture identity changes at the same size", () => {
        const capture: Capture = { beginRenderPassCount: 0, draws: 0 };
        const engine = makeMockEngine(capture);
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const source = makeSceneColorDepthRT(64, 64);

        const task = createScreenSpaceContactShadowsPostProcessTask({ sourceTexture: source, camera, lightDirection: { x: 0, y: -1, z: 0 }, composition: "none" }, engine);
        task.record();
        task.execute!();

        // Simulate a same-sized device-recovery reallocation: new GPUTexture identity, same dimensions.
        source._depthTexture = makeFakeTexture();
        expect(() => task.execute!()).not.toThrow();
    });
});

describe("screen-space global illumination task lifecycle", () => {
    it("records and executes without throwing, producing draw calls while enabled", () => {
        const capture: Capture = { beginRenderPassCount: 0, draws: 0 };
        const engine = makeMockEngine(capture);
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const source = makeSceneColorDepthRT(64, 64);

        const task = createScreenSpaceGlobalIlluminationPostProcessTask({ sourceTexture: source, camera, composition: "none" }, engine);
        task.record();
        const draws1 = task.execute!();
        expect(draws1).toBeGreaterThan(0);
        expect(task.outputTexture).toBe(task.illuminationTexture);
    });

    it("supports the color-bleed composite mode", () => {
        const capture: Capture = { beginRenderPassCount: 0, draws: 0 };
        const engine = makeMockEngine(capture);
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const source = makeSceneColorDepthRT(64, 64);

        const task = createScreenSpaceGlobalIlluminationPostProcessTask({ sourceTexture: source, camera, composition: "color-bleed" }, engine);
        task.record();
        expect(() => task.execute!()).not.toThrow();
        expect(task.outputTexture).not.toBe(task.illuminationTexture);
    });
});
