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

    it("forces a refit after angular drift or the configured drift interval", () => {
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
    });
});
