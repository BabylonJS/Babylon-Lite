import { describe, expect, it, vi } from "vitest";

import { createCsmRefitGate, type CsmRefitCaster } from "../../../packages/babylon-lite/src/shadow/csm-refit-gate";

interface MutableCaster extends CsmRefitCaster {
    worldMatrixVersion: number;
}

function update(gate: ReturnType<typeof createCsmRefitGate<MutableCaster>>, nowMs = 0) {
    return gate.update(
        0,
        -1,
        0,
        nowMs,
        false,
        false,
        () => undefined,
        () => undefined
    );
}

describe("CSM refit gate", () => {
    it("does not refit when the same caster membership is re-supplied in a new array", () => {
        const caster = { worldMatrixVersion: 1 };
        const gate = createCsmRefitGate<MutableCaster>({ refitAngle: 0.05, refitMaxIntervalMs: 0, demoteQuietFrames: 100 });

        gate.syncCasters([caster]);
        expect(update(gate)).toEqual({ refit: true, renderDynamic: true });

        gate.syncCasters([caster]);
        expect(update(gate)).toEqual({ refit: false, renderDynamic: false });
    });

    it("redraws the dynamic overlay when caster changes cancel in the version sum", () => {
        const first = { worldMatrixVersion: 1 };
        const second = { worldMatrixVersion: 1 };
        const gate = createCsmRefitGate<MutableCaster>({ refitAngle: 0.05, refitMaxIntervalMs: 0, demoteQuietFrames: 100 });

        gate.syncCasters([first, second]);
        expect(update(gate)).toEqual({ refit: true, renderDynamic: true });

        first.worldMatrixVersion = 2;
        second.worldMatrixVersion = 0;
        expect(update(gate)).toEqual({ refit: false, renderDynamic: true });
    });

    it("demotes quiet casters only on a refit and promotes a changed static caster immediately", () => {
        const caster = { worldMatrixVersion: 1 };
        const onPromote = vi.fn();
        const onDemote = vi.fn();
        const gate = createCsmRefitGate<MutableCaster>({ refitAngle: 0.05, refitMaxIntervalMs: 0, demoteQuietFrames: 2 });

        gate.syncCasters([caster]);
        expect(gate.update(0, -1, 0, 0, false, false, onPromote, onDemote).refit).toBe(true);
        expect(gate.update(0, -1, 0, 1, false, false, onPromote, onDemote).refit).toBe(false);
        expect(gate.update(0, -1, 0, 2, false, false, onPromote, onDemote).refit).toBe(true);
        expect(onDemote).toHaveBeenCalledOnce();
        expect(gate.isDynamic(caster)).toBe(false);

        caster.worldMatrixVersion++;
        expect(gate.update(0, -1, 0, 3, false, false, onPromote, onDemote)).toEqual({ refit: true, renderDynamic: true });
        expect(onPromote).toHaveBeenCalledWith(caster);
        expect(gate.isDynamic(caster)).toBe(true);
    });

    it("forces a refit after angular drift or the configured wall-time interval", () => {
        const caster = { worldMatrixVersion: 1 };
        const angleGate = createCsmRefitGate<MutableCaster>({ refitAngle: 0.1, refitMaxIntervalMs: 0, demoteQuietFrames: 100 });
        angleGate.syncCasters([caster]);
        expect(update(angleGate)).toEqual({ refit: true, renderDynamic: true });
        expect(
            angleGate.update(
                0.05,
                -1,
                0,
                1,
                false,
                false,
                () => undefined,
                () => undefined
            ).refit
        ).toBe(false);
        expect(
            angleGate.update(
                0.2,
                -1,
                0,
                2,
                false,
                false,
                () => undefined,
                () => undefined
            ).refit
        ).toBe(true);

        const intervalGate = createCsmRefitGate<MutableCaster>({ refitAngle: Math.PI, refitMaxIntervalMs: 10, demoteQuietFrames: 100 });
        intervalGate.syncCasters([caster]);
        expect(update(intervalGate)).toEqual({ refit: true, renderDynamic: true });
        expect(
            intervalGate.update(
                0.01,
                -1,
                0,
                9,
                false,
                false,
                () => undefined,
                () => undefined
            ).refit
        ).toBe(false);
        expect(
            intervalGate.update(
                0.02,
                -1,
                0,
                10,
                false,
                false,
                () => undefined,
                () => undefined
            ).refit
        ).toBe(true);

        expect(
            intervalGate.update(
                0.02,
                -1,
                0,
                19,
                false,
                false,
                () => undefined,
                () => undefined
            ).refit
        ).toBe(false);
        expect(
            intervalGate.update(
                0.02,
                -1,
                0,
                20,
                false,
                false,
                () => undefined,
                () => undefined
            ).refit
        ).toBe(true);
    });
});

describe("CSM refit gate: lastRefitDriftOnly", () => {
    const step = (gate: ReturnType<typeof createCsmRefitGate<MutableCaster>>, x: number, nowMs: number, camera = false) =>
        gate.update(
            x,
            -1,
            0,
            nowMs,
            camera,
            false,
            () => undefined,
            () => undefined
        );

    it("is true only for a refit caused by the angle epsilon or the wall-time floor", () => {
        const caster = { worldMatrixVersion: 1 };
        const gate = createCsmRefitGate<MutableCaster>({ refitAngle: 0.05, refitMaxIntervalMs: 100, demoteQuietFrames: 100 });
        gate.syncCasters([caster]);
        expect(step(gate, 0, 0).refit).toBe(true);
        expect(gate.lastRefitDriftOnly()).toBe(false); // the very first refit is a full render
        expect(step(gate, 0, 10).refit).toBe(false);
        expect(gate.lastRefitDriftOnly()).toBe(false); // no refit, no drift-only claim
        expect(step(gate, 0.2, 20).refit).toBe(true); // angle epsilon crossed
        expect(gate.lastRefitDriftOnly()).toBe(true);
        expect(step(gate, 0.2, 130).refit).toBe(true); // wall-time floor, frozen sun
        expect(gate.lastRefitDriftOnly()).toBe(true);
        expect(step(gate, 0.2, 140).refit).toBe(false);
        expect(gate.lastRefitDriftOnly()).toBe(false);
    });

    it("is false when the camera, a promotion or a demotion took part in the refit, even with drift", () => {
        const caster = { worldMatrixVersion: 1 };
        const gate = createCsmRefitGate<MutableCaster>({ refitAngle: 0.05, refitMaxIntervalMs: 0, demoteQuietFrames: 2 });
        gate.syncCasters([caster]);
        step(gate, 0, 0); // first refit; the caster starts dynamic
        step(gate, 0, 1); // quiet frame 1
        // Quiet frame 2 with drift: the refit is drift-caused, but it APPLIES the pending demotion, so the
        // static partition changes inside it and the spread is refused.
        expect(step(gate, 0.2, 2).refit).toBe(true);
        expect(gate.isDynamic(caster)).toBe(false);
        expect(gate.lastRefitDriftOnly()).toBe(false);
        // Drift alone on the settled partition: spreadable.
        expect(step(gate, 0.4, 3).refit).toBe(true);
        expect(gate.lastRefitDriftOnly()).toBe(true);
        // Drift plus a camera change: full.
        expect(step(gate, 0.6, 4, true).refit).toBe(true);
        expect(gate.lastRefitDriftOnly()).toBe(false);
        // Drift plus a promotion (the static caster moved): full.
        caster.worldMatrixVersion++;
        expect(step(gate, 0.8, 5).refit).toBe(true);
        expect(gate.lastRefitDriftOnly()).toBe(false);
    });
});

describe("CSM refit gate: demotion applied inside a drift refit", () => {
    it("refuses the spread when a floor refit applies a demotion, even though demotionOverdue is unreachable", () => {
        // Production regime: the wall-time floor refits every few frames, so framesSinceRefit never reaches
        // demoteQuietFrames and demotionOverdue can never fire; a caster that went quiet is demoted INSIDE a
        // drift refit, and that refit must not be spread (the caster would vanish from the cascades not yet
        // re-rendered). Frames every 30 ms, floor 100 ms, demoteQuietFrames 5.
        const caster = { worldMatrixVersion: 1 };
        const gate = createCsmRefitGate<MutableCaster>({ refitAngle: 1, refitMaxIntervalMs: 100, demoteQuietFrames: 5 });
        gate.syncCasters([caster]);
        const onDemote = vi.fn();
        const step = (nowMs: number) => gate.update(0, -1, 0, nowMs, false, false, () => undefined, onDemote);
        expect(step(0).refit).toBe(true); // first refit: full
        let demotedAt = -1;
        for (let t = 30; t <= 600; t += 30) {
            const r = step(t);
            if (onDemote.mock.calls.length === 1 && demotedAt < 0) {
                demotedAt = t;
                expect(r.refit).toBe(true); // the demotion is applied by a floor refit...
                expect(gate.lastRefitDriftOnly()).toBe(false); // ...which therefore must not be spread
            } else if (r.refit) {
                expect(gate.lastRefitDriftOnly()).toBe(true); // every other floor refit is drift-only
            }
        }
        expect(demotedAt).toBeGreaterThan(0);
        expect(gate.isDynamic(caster)).toBe(false);
    });
});
