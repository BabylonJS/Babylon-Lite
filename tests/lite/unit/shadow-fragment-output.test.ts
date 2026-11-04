import { describe, expect, it, vi } from "vitest";
import { createPbrShadowFragment, preparePbrShadowFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/pbr-shadow-fragment";
import { createStdShadowFragment } from "../../../packages/babylon-lite/src/material/standard/fragments/std-shadow-fragment";
import { createShadowFragment, type ShadowLightSlot } from "../../../packages/babylon-lite/src/shader/fragments/shadow-fragment-core";
import { loadShadowFragmentFactory } from "../../../packages/babylon-lite/src/shader/fragments/shadow-fragment-builder";
import { setCsmPbrReceiverFactory, setCsmStdReceiverFactory } from "../../../packages/babylon-lite/src/shadow/csm-receiver-registry";
import type { ShaderFragment } from "../../../packages/babylon-lite/src/shader/fragment-types";

const cases: readonly [string, ShadowLightSlot[]][] = [
    ["empty", []],
    ["esm", [{ lightIndex: 0, shadowType: "esm" }]],
    ["pcf", [{ lightIndex: 0, shadowType: "pcf" }]],
    [
        "mixed",
        [
            { lightIndex: 0, shadowType: "esm" },
            { lightIndex: 1, shadowType: "pcf" },
        ],
    ],
    [
        "non-contiguous",
        [
            { lightIndex: 1, shadowType: "pcf" },
            { lightIndex: 4, shadowType: "esm" },
        ],
    ],
];

describe.each([
    ["Standard", createStdShadowFragment],
    ["PBR", createPbrShadowFragment],
] as const)("%s shadow fragment exact output", (_family, createFragment) => {
    it.each(cases)("%s", async (_name, slots) => {
        const createFallback = await loadShadowFragmentFactory(slots);
        expect(createFragment(slots, createFallback)).toMatchSnapshot();
    });
});

describe("prepared shadow receiver algorithms", () => {
    it.each(cases)("keeps the combined core API identical to the prepared Standard path for %s", async (_name, slots) => {
        const createFallback = await loadShadowFragmentFactory(slots);
        expect(createShadowFragment("std-shadow", slots)).toEqual(createStdShadowFragment(slots, createFallback));
    });

    it("rejects an unprepared PCF path from an ESM-only factory", async () => {
        const create = await loadShadowFragmentFactory([{ lightIndex: 0, shadowType: "esm" }]);
        expect(() => create("shadow", [{ lightIndex: 0, shadowType: "pcf" }])).toThrow("PCF shadow receiver was not prepared.");
    });

    it("rejects an unprepared ESM path from a PCF-only factory", async () => {
        const create = await loadShadowFragmentFactory([{ lightIndex: 0, shadowType: "pcf" }]);
        expect(() => create("shadow", [{ lightIndex: 0, shadowType: "esm" }])).toThrow("ESM shadow receiver was not prepared.");
    });

    it("preserves CSM precedence and forwards only CSM slots", async () => {
        const standardFragment = { _id: "std-csm" } as ShaderFragment;
        const pbrFragment = { _id: "pbr-csm" } as ShaderFragment;
        const standardFactory = vi.fn(() => standardFragment);
        const pbrFactory = vi.fn(() => pbrFragment);
        setCsmStdReceiverFactory(standardFactory);
        setCsmPbrReceiverFactory(pbrFactory);
        const slots: ShadowLightSlot[] = [
            { lightIndex: 0, shadowType: "esm" },
            { lightIndex: 3, shadowType: "csm" },
            { lightIndex: 5, shadowType: "pcf" },
        ];

        expect(createStdShadowFragment(slots)).toBe(standardFragment);
        const createPbr = await preparePbrShadowFragment(slots);
        expect(createPbr(slots)).toBe(pbrFragment);
        expect(standardFactory).toHaveBeenCalledExactlyOnceWith([{ lightIndex: 3 }]);
        expect(pbrFactory).toHaveBeenCalledExactlyOnceWith([{ lightIndex: 3 }]);
    });
});
