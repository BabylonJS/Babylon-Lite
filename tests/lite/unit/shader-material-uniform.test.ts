import { describe, expect, it } from "vitest";

import { createShaderMaterial, setShaderFloat, setShaderMatrix, setShaderUniform } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";

function material() {
    return createShaderMaterial({
        vertexSource: "@vertex fn mainVertex() -> @builtin(position) vec4f { return vec4f(); }",
        fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(); }",
        attributes: ["position"],
        uniforms: [
            { name: "amount", type: "f32" },
            { name: "tint", type: "vec3<f32>" },
            { name: "transform", type: "mat4x4<f32>" },
        ],
    });
}

describe("ShaderMaterial uniform updates", () => {
    it("does not dirty the UBO when the normalized value is unchanged", () => {
        const mat = material();

        setShaderFloat(mat, "amount", 0.1);
        const version = mat._uniformVersion;
        setShaderFloat(mat, "amount", 0.1);

        expect(mat._uniformVersion).toBe(version);
        expect(mat._uboVersion).toBe(version);
    });

    it("compares vectors and matrices without replacing their storage", () => {
        const mat = material();
        const tint = mat._uniformValues.get("tint")!.value;
        const transform = mat._uniformValues.get("transform")!.value;
        const matrix = new Float32Array(16);
        matrix[0] = 1;

        setShaderUniform(mat, "tint", [1, 0.5, 0.25]);
        setShaderMatrix(mat, "transform", matrix as unknown as Mat4);
        const version = mat._uniformVersion;
        setShaderUniform(mat, "tint", new Float32Array([1, 0.5, 0.25]));
        setShaderMatrix(mat, "transform", matrix as unknown as Mat4);

        expect(mat._uniformValues.get("tint")!.value).toBe(tint);
        expect(mat._uniformValues.get("transform")!.value).toBe(transform);
        expect(mat._uniformVersion).toBe(version);
    });
});
