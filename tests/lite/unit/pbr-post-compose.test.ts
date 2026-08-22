import { beforeEach, describe, expect, it, vi } from "vitest";

describe("PBR post-compose extensions", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("applies every registered post-compose patch in registration order", async () => {
        const { createPbrComposer } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-compose");
        const { _registerPbrExt } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");

        for (const marker of ["first", "second"]) {
            _registerPbrExt({
                id: marker,
                phase: "fragment",
                frag: () => ({
                    _id: marker,
                    _pc: (composed) => ({
                        ...composed,
                        _fragmentWGSL: `${composed._fragmentWGSL}\n// ${marker}`,
                    }),
                }),
            });
        }

        const composePbr = createPbrComposer({
            _singleLightWGSL: "",
            _getSingleLightBlock: null,
            _multiLightWGSL: "",
            _multiLightLoop: "",
            _toneMappingHelpers: "",
            _toneMappingCall: "",
            _fogHelper: "",
            _fogBlock: "",
            _createPbrTemplateExt: null,
            _flatNormalWgsl: "",
            _createPbrShadowFragment: null,
            _shadowLights: [],
            _createThinInstanceFragment: null,
        });
        const result = composePbr(0);

        expect(result._fragmentWGSL).toMatch(/\/\/ first[\s\S]*\/\/ second/);
    });
});
