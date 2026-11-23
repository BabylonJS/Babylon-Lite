import { describe, expect, it, vi } from "vitest";
import { createPbrShadowFragment, preparePbrShadowFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/pbr-shadow-fragment";
import { createStandardShadowContext, createStdShadowFragment } from "../../../packages/babylon-lite/src/material/standard/fragments/std-shadow-fragment";
import { createShadowFragment, type ShadowLightSlot } from "../../../packages/babylon-lite/src/shader/fragments/shadow-fragment-core";
import { loadShadowFragmentFactory } from "../../../packages/babylon-lite/src/shader/fragments/shadow-fragment-builder";
import { setCsmPbrReceiverFactory, setCsmStdReceiverFactory } from "../../../packages/babylon-lite/src/shadow/csm-receiver-registry";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { ShaderFragment } from "../../../packages/babylon-lite/src/shader/fragment-types";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

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

    it("composes CSM and ESM/PCF receivers in light-slot order", async () => {
        const csmFragment = (slot: "AD" | "AS"): ShaderFragment => ({
            _id: "csm-shadow",
            _bindings: ["csmTex_3", "csmComp_3", "csmInfo_3"].map((name) => ({ _name: name, _type: { _kind: "uniform-buffer" }, _group: "shadow", _visibility: 0x2 })),
            _fragmentSlots: { [slot]: wgsl`shadowFactors[3] = 1.0;` },
        });
        const standardFactory = vi.fn(() => csmFragment("AD"));
        const pbrFactory = vi.fn(() => csmFragment("AS"));
        setCsmStdReceiverFactory(standardFactory);
        setCsmPbrReceiverFactory(pbrFactory);
        const slots: ShadowLightSlot[] = [
            { lightIndex: 0, shadowType: "esm" },
            { lightIndex: 3, shadowType: "csm" },
            { lightIndex: 5, shadowType: "pcf" },
        ];
        const light = (shadowType: ShadowLightSlot["shadowType"]) => ({ shadowGenerator: { _shadowType: shadowType } as ShadowGenerator });
        const lights = [light("esm"), {}, {}, light("csm"), {}, light("pcf")];
        // The bind group binds one texture/sampler/uniform triple per shadow light, in light-slot order.
        const bindings = ["shadowTex_0", "shadowSamp_0", "shadowInfo_0", "csmTex_3", "csmComp_3", "csmInfo_3", "shadowTex_5", "shadowComp_5", "shadowInfo_5"];

        const standard = (await createStandardShadowContext({} as EngineContext, lights))._fragment();
        const pbr = (await preparePbrShadowFragment(slots))(slots);

        expect(standard._bindings?.map((binding) => binding._name)).toEqual(bindings);
        expect(pbr._bindings?.map((binding) => binding._name)).toEqual(bindings);
        expect(standard._fragmentSlots?.AD).toContain("shadowFactors[3] = 1.0;");
        expect(pbr._fragmentSlots?.AS).toContain("shadowFactors[3] = 1.0;");
        expect(pbr._fragmentSlots?.AS).toContain("shadowFactors[5] = computeShadowPCF_5(");
        expect(standardFactory).toHaveBeenCalledExactlyOnceWith([{ lightIndex: 3 }]);
        expect(pbrFactory).toHaveBeenCalledExactlyOnceWith([{ lightIndex: 3 }]);
    });
});
