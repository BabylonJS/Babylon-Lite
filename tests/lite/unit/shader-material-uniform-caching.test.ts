import { describe, expect, it, vi } from "vitest";
import type { ShaderCustomUniformWriter, ShaderSystemUniformWriter } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";

const installed = vi.hoisted(() => ({
    system: undefined as ShaderSystemUniformWriter | undefined,
    custom: undefined as ShaderCustomUniformWriter | undefined,
}));

vi.mock("../../../packages/babylon-lite/src/material/shader/shader-renderable.js", () => ({
    _installShaderUniformWriters(system: ShaderSystemUniformWriter, custom: ShaderCustomUniformWriter) {
        installed.system = system;
        installed.custom = custom;
    },
}));

import { enableShaderMaterialUniformCaching } from "../../../packages/babylon-lite/src/material/shader/enable-shader-material-uniform-caching";
import { createShaderMaterial, setShaderFloat } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { UboSpec } from "../../../packages/babylon-lite/src/shader/fragment-types";

describe("ShaderMaterial uniform caching", () => {
    it("installs cached writers and skips unchanged vector serialization", () => {
        const material = createShaderMaterial({
            vertexSource: "@vertex fn mainVertex(input:VertexInput)->@builtin(position) vec4<f32>{return vec4<f32>(input.position,1.0);}",
            fragmentSource: "@fragment fn mainFragment()->@location(0) vec4<f32>{return vec4<f32>(1.0);}",
            attributes: ["position"],
            uniforms: [
                { name: "tint", type: "vec4<f32>", defaultValue: [1, 1, 1, 1] },
                { name: "amount", type: "f32", defaultValue: 0 },
            ],
        });
        const spec = {
            _offsets: new Map([
                ["tint", 0],
                ["amount", 16],
            ]),
        } as unknown as UboSpec;
        const data = new ArrayBuffer(32);
        const bytes = new Uint8Array(data);
        const writeBuffer = vi.fn();
        const engine = { _device: { queue: { writeBuffer } } } as unknown as EngineContext;
        const ubo = {} as GPUBuffer;
        const set = vi.spyOn(Float32Array.prototype, "set");

        enableShaderMaterialUniformCaching();
        expect(installed.system).toBeTypeOf("function");
        expect(installed.custom).toBeTypeOf("function");

        installed.custom!(engine, material, spec, data, ubo, bytes);
        expect(set).toHaveBeenCalledTimes(1);
        expect(writeBuffer).toHaveBeenCalledTimes(1);

        set.mockClear();
        setShaderFloat(material, "amount", 0.5);
        installed.custom!(engine, material, spec, data, ubo, bytes);
        expect(set).not.toHaveBeenCalled();
        expect(writeBuffer).toHaveBeenCalledTimes(2);

        installed.custom!(engine, material, spec, data, ubo, bytes);
        expect(writeBuffer).toHaveBeenCalledTimes(2);
        set.mockRestore();
    });
});
