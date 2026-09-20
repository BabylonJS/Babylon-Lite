import { describe, expect, it, vi } from "vitest";

describe("mesh-blending PBR opt-in support", () => {
    it("installs support only after a mesh-blending task is constructed successfully", async () => {
        vi.resetModules();
        const flags = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
        const { createRenderTarget } = await import("../../../packages/babylon-lite/src/engine/render-target");
        const { createMeshBlendingPostProcessTask } = await import("../../../packages/babylon-lite/src/post-process/mesh-blending");
        const sourceTexture = createRenderTarget({ format: "rgba16float", samples: 1, size: { width: 16, height: 16 } });
        const meshBlendTagTexture = createRenderTarget({ format: "r8uint", samples: 1, size: { width: 16, height: 16 } });
        const depthTexture = createRenderTarget({ format: "r32float", samples: 1, size: { width: 16, height: 16 } });
        const config = { sourceTexture, meshBlendTagTexture, depthTexture, camera: {} as never };

        expect(flags._getPbrExts().has("mesh-blend-normal")).toBe(false);
        expect(() => createMeshBlendingPostProcessTask({ ...config, quality: 99 as never }, {} as never)).toThrow(RangeError);
        expect(flags._getPbrExts().has("mesh-blend-normal")).toBe(false);

        const task = createMeshBlendingPostProcessTask(config, {} as never);
        expect(flags._getPbrExts().has("mesh-blend-normal")).toBe(true);
        task.dispose();
    });

    it("registers a tag-scoped, typed normal correction only after explicit installation", async () => {
        vi.resetModules();
        const support = await import("../../../packages/babylon-lite/src/post-process/mesh-blending-pbr-support");
        const flags = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
        const meshFeatures = await import("../../../packages/babylon-lite/src/material/mesh-features");
        const { GeometryTextureType } = await import("../../../packages/babylon-lite/src/frame-graph/geometry-types");
        const { _setActivePbrGeometryAttachments } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view");
        const { createPbrTemplate } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-template");
        const { composeShader } = await import("../../../packages/babylon-lite/src/shader/shader-composer");

        expect(flags._getPbrExts().has("mesh-blend-normal")).toBe(false);
        support._installMeshBlendingPbrSupport();

        const extension = flags._getPbrExts().get("mesh-blend-normal")!;
        const context = {
            _features: flags.PBR_HAS_NORMAL_MAP,
            _features2: 0,
            _meshFeatures: meshFeatures.MSH_HAS_TANGENTS,
            _hasIbl: true,
            _hasAnyNormal: true,
            _hasSpecularAA: false,
        };
        expect(extension.frag!(context)).toBeNull();

        const previousAttachments = _setActivePbrGeometryAttachments([GeometryTextureType.MESH_BLEND_TAG]);
        const fragment = extension.frag!(context)!;
        _setActivePbrGeometryAttachments(previousAttachments);
        const composed = composeShader(createPbrTemplate({ _normalMode: "tangent" }), [fragment]);

        expect(fragment._pc).toBeUndefined();
        expect(composed._vertexWGSL).toContain("meshBlendNormalWorld=transposeMat3(inverseMat3(meshBlendNormalWorld));");
        expect(composed._vertexWGSL).toContain("out.worldTangentNormal=(finalWorld*vec4<f32>(normalize(normal),0.0)).xyz;");
        expect(composed._fragmentWGSL).toContain("N=normalize(mat3x3<f32>(input.worldTangent,input.worldBitangent,input.worldTangentNormal)*normalMapNorm);");
    });
});
