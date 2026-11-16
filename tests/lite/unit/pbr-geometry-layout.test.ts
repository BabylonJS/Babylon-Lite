import { describe, expect, it, vi } from "vitest";
import { buildPbrGeometryRenderable } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-renderable";
import { createPbrGeometryMaterialView } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createIdentityMat4 } from "../../../packages/babylon-lite/src/math/create-identity-mat4";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Mesh, MeshVbLayout } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshRebuildResources } from "../../../packages/babylon-lite/src/render/renderable";
import { composePbrGeometryShader } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-output-shader";

vi.mock("../../../packages/babylon-lite/src/material/pbr/pbr-geometry-output-shader", () => ({
    _ensurePbrGeometryExt: vi.fn(),
    composePbrGeometryShader: vi.fn(() => ({
        _meshUboSpec: { _totalBytes: 64 },
        _meshBGLDescriptor: { entries: [] },
        _vertexWGSL: "",
        _fragmentWGSL: "",
    })),
}));
vi.mock("../../../packages/babylon-lite/src/render/mesh-light-selection", () => ({ writeMeshLightSelection: () => 0 }));
vi.mock("../../../packages/babylon-lite/src/material/mesh-features", async (original) => ({
    ...(await original<object>()),
    _computeMeshFeatures: () => 0,
}));
vi.mock("../../../packages/babylon-lite/src/resource/uniform-buffer", () => ({
    createUniformBuffer: () => {
        throw new Error("stop after geometry resource selection");
    },
}));

describe("PBR geometry vertex-layout identity", () => {
    it("uses each mesh's layout and does not share composed resources across different strides", () => {
        vi.mocked(composePbrGeometryShader).mockClear();
        const device = {
            createBindGroupLayout: vi.fn(() => ({})),
            createPipelineLayout: vi.fn(() => ({})),
            createShaderModule: vi.fn(() => ({})),
        };
        const engine = { _device: device, _getSceneBGL: () => ({}), useFloatingOrigin: false } as unknown as EngineContext;
        const scene = {
            surface: { engine },
            lights: [],
            _pbrGeomContext: { _shadowLights: [], _sceneFeatures: 0, _composePbr: vi.fn() },
        } as unknown as SceneContext;
        const source = createPbrMaterial();
        const view = createPbrGeometryMaterialView(source, { attachments: [], emitColor: false });
        const first = { _p: { _stride: 24, _offset: 0 } } as MeshVbLayout;
        const second = { _p: { _stride: 32, _offset: 8 } } as MeshVbLayout;
        const mesh = {
            _gpu: { _vbLayout: first, _vbKey: "vb24,0" },
            worldMatrix: createIdentityMat4(),
            receiveShadows: false,
        } as unknown as Mesh;
        const resources = {} as MeshRebuildResources;
        const build = () => buildPbrGeometryRenderable(scene, mesh, view, resources);
        expect(build).toThrow("stop after geometry resource selection");
        expect(vi.mocked(composePbrGeometryShader).mock.calls[0]![8]).toBe(first);
        expect(vi.mocked(composePbrGeometryShader).mock.calls[0]![9]).toBe("vb24,0");
        Object.assign(mesh._gpu, { _vbLayout: second, _vbKey: "vb32,8" });
        expect(build).toThrow("stop after geometry resource selection");
        expect(composePbrGeometryShader).toHaveBeenCalledTimes(2);
        expect(vi.mocked(composePbrGeometryShader).mock.calls[1]![8]).toBe(second);
        expect(vi.mocked(composePbrGeometryShader).mock.calls[1]![9]).toBe("vb32,8");
        expect(build).toThrow("stop after geometry resource selection");
        expect(composePbrGeometryShader).toHaveBeenCalledTimes(2);
    });
});
