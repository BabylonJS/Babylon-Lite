import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";

function meshWithWorldMatrix(worldMatrix: number[]): Mesh {
    return {
        worldMatrix,
        _gpu: {
            tangentBuffer: null,
            colorBuffer: null,
            uv2Buffer: null,
        },
    } as unknown as Mesh;
}

describe("mesh-blending PBR opt-in support", () => {
    it("registers non-uniform normal correction only after explicit installation", async () => {
        vi.resetModules();
        const support = await import("../../../packages/babylon-lite/src/post-process/mesh-blending-pbr-support");
        const flags = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
        const meshFeatures = await import("../../../packages/babylon-lite/src/material/mesh-features");
        const { createPbrTemplate } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-template");
        const { composeShader } = await import("../../../packages/babylon-lite/src/shader/shader-composer");

        expect(flags._getPbrExts().has("mesh-blending-non-uniform-normal")).toBe(false);
        support._installMeshBlendingPbrSupport();

        const uniform = meshWithWorldMatrix([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
        const nonUniform = meshWithWorldMatrix([4.5, 0, 0, 0, 0, 3.9, 0, 0, 0, 0, 13.5, 0, 0, 0, 0, 1]);
        for (const hook of flags._getPbrSceneHooks()) {
            await hook({} as never, {} as never, [uniform, nonUniform]);
        }

        expect((uniform as Mesh & { _primitiveFeatures?: number })._primitiveFeatures ?? 0).toBe(0);
        expect((nonUniform as Mesh & { _primitiveFeatures?: number })._primitiveFeatures).toBe(support._MESH_BLENDING_NON_UNIFORM_SCALING);

        const extension = flags._getPbrExts().get("mesh-blending-non-uniform-normal")!;
        const fragment = extension.frag!({
            _features: flags.PBR_HAS_NORMAL_MAP,
            _features2: 0,
            _meshFeatures: support._MESH_BLENDING_NON_UNIFORM_SCALING | meshFeatures.MSH_HAS_TANGENTS,
            _hasIbl: true,
            _hasAnyNormal: true,
            _hasSpecularAA: false,
        })!;
        const composed = fragment._pc!(composeShader(createPbrTemplate({ _normalMode: "tangent" }), [fragment]));

        expect(composed._vertexWGSL).toContain("normalWorld=transposeMat3(inverseMat3(normalWorld));");
        expect(composed._vertexWGSL).toContain("out.worldTangentNormal=(finalWorld*vec4<f32>(N_local,0.0)).xyz;");
        expect(composed._fragmentWGSL).toContain("mat3x3<f32>(input.worldTangent,input.worldBitangent,input.worldTangentNormal)");
    });
});
