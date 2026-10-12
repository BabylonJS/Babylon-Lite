import { describe, expect, it } from "vitest";
import { emitShadow } from "../../../packages/babylon-lite/src/material/node/node-shadow";
import { prepareNodeShadowEmitter } from "../../../packages/babylon-lite/src/material/node/node-shadow-emitter";
import type { Varying } from "../../../packages/babylon-lite/src/shader/fragment-types";

const cases: readonly [string, Parameters<typeof emitShadow>[0]][] = [
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

function normalizeWhitespace(source: string): string {
    return source.replace(/\s+/g, " ").trim();
}

describe("Node shadow emission", () => {
    it.each(cases)("preserves bindings and shader tokens for %s", async (_name, slots) => {
        const varyings: Varying[] = [{ _name: "vPosFromLight_0", _type: "vec4<f32>" }];
        const result = emitShadow(slots, 7, varyings);
        const prepared = await prepareNodeShadowEmitter(slots);
        const preparedVaryings: Varying[] = [{ _name: "vPosFromLight_0", _type: "vec4<f32>" }];
        expect(prepared(slots, 7, preparedVaryings)).toEqual(result);
        expect(preparedVaryings).toEqual(varyings);
        expect({
            ...result,
            _wgslDecls: normalizeWhitespace(result._wgslDecls),
            _fragmentHelper: normalizeWhitespace(result._fragmentHelper),
            _vertexInject: normalizeWhitespace(result._vertexInject),
            varyings,
        }).toMatchSnapshot();
    });

    it("rejects a synchronous request for an algorithm that was not prepared", async () => {
        const prepared = await prepareNodeShadowEmitter([{ lightIndex: 0, shadowType: "pcf" }]);
        expect(() => prepared([{ lightIndex: 0, shadowType: "esm" }], 0, [])).toThrow("ESM shadow receiver was not prepared.");
    });
});
