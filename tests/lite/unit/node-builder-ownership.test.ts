import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { targetSignatureKey } from "../../../packages/babylon-lite/src/engine/render-target-signature";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { buildNodeGeometryRenderable } from "../../../packages/babylon-lite/src/material/node/node-geometry-renderable";
import type { NodeGeometryMaterialView } from "../../../packages/babylon-lite/src/material/node/node-geometry-view";
import type { NodeMaterial } from "../../../packages/babylon-lite/src/material/node/node-material";
import { buildNodeMeshRenderables } from "../../../packages/babylon-lite/src/material/node/node-renderable";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshRebuildResources } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

function resources(): MeshRebuildResources {
    return { _lifetimeDisposers: [] };
}

function createFixture(failBindGroup = false): {
    scene: SceneContext;
    mesh: Mesh;
    material: NodeMaterial;
    buffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }>;
} {
    const buffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }> = [];
    const device = {
        createBuffer: vi.fn(() => {
            const buffer = { destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
            buffers.push(buffer);
            return buffer;
        }),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
            if (failBindGroup) {
                throw new Error("node bind group failed");
            }
            return descriptor as unknown as GPUBindGroup;
        }),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const engine = { _device: device } as unknown as EngineContext;
    const pipeline = {} as GPURenderPipeline;
    const compile = {
        _pipeline: pipeline,
        _pipelineForMesh: vi.fn(() => pipeline),
        _meshBGL: {} as GPUBindGroupLayout,
        _nodeUboBinding: 1,
        _nodeUboSize: 16,
        _textureBindings: [],
        _envBindings: null,
        _shadowBindings: [],
        _meshUboFloats: 20,
        _esmShadowParamsBinding: null,
        _geometryGpBinding: null,
        _usesMeshAttributeFlags: false,
    };
    const material = {
        _renderFeatures: { features: 0 },
        _compile: compile,
        _uniformValues: new Map(),
        _vertexAttrNames: ["position"],
        _needsAlphaBlending: false,
        _uboDirty: false,
    } as unknown as NodeMaterial;
    const mesh = {
        material,
        children: [],
        receiveShadows: false,
        worldMatrix: new Float32Array(16),
        worldMatrixVersion: 0,
        _gpu: {
            positionBuffer: {} as GPUBuffer,
            indexBuffer: {} as GPUBuffer,
            indexCount: 3,
            indexFormat: "uint32",
        },
    } as unknown as Mesh;
    const scene = {
        surface: { engine },
        lights: [],
        _disposables: [],
        _meshDisposables: new Map(),
    } as unknown as SceneContext;
    return { scene, mesh, material, buffers };
}

describe("Node auxiliary ownership", () => {
    it("cleans a failed initial mesh upload while retaining the earlier node-buffer cleanup", () => {
        const { scene, mesh, material, buffers } = createFixture();
        const owned = resources();
        vi.mocked(scene.surface.engine._device.queue.writeBuffer)
            .mockImplementationOnce(() => undefined)
            .mockImplementationOnce(() => {
                throw new Error("node mesh upload failed");
            });
        expect(() => buildNodeMeshRenderables(scene, [mesh], material, owned)).toThrow("node mesh upload failed");
        expect(buffers[1]!.destroy).toHaveBeenCalledOnce();
        owned._lifetimeDisposers.forEach((dispose) => dispose());
        expect(buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
        expect(scene._disposables).toHaveLength(0);
        expect(scene.surface.engine._device.createBuffer).toHaveBeenCalledWith(expect.objectContaining({ label: "node-ubo", size: 16 }));
        expect(scene.surface.engine._device.createBuffer).toHaveBeenCalledWith(expect.objectContaining({ label: "node-mesh-ubo", size: 80 }));
    });

    it("routes normal-renderer UBOs only to the explicit lifetime sink", () => {
        const { scene, mesh, material, buffers } = createFixture();
        const owned = resources();

        const result = buildNodeMeshRenderables(scene, [mesh], material, owned);

        expect(owned._lifetimeDisposers).toHaveLength(2);
        expect(scene._disposables).toHaveLength(0);
        expect(result.renderables[0]!.mesh).toBe(mesh);
        owned._lifetimeDisposers.forEach((dispose) => dispose());
        expect(buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
    });

    it("does not assign one mesh identity to a merged opaque Node renderable", () => {
        const { scene, mesh, material } = createFixture();
        const secondMesh = { ...mesh, worldMatrix: new Float32Array(16) } as unknown as Mesh;
        const owned = resources();

        const result = buildNodeMeshRenderables(scene, [mesh, secondMesh], material, owned);

        expect(result.renderables).toHaveLength(1);
        expect(result.renderables[0]!.mesh).toBeUndefined();
        owned._lifetimeDisposers.forEach((dispose) => dispose());
    });

    it("splits opaque Node renderables whose meshes require different vertex layouts", () => {
        const { scene, mesh, material } = createFixture();
        Object.assign(mesh._gpu, { _vbKey: "first" });
        const secondMesh = {
            ...mesh,
            worldMatrix: new Float32Array(16),
            _gpu: { ...mesh._gpu, _vbKey: "second" },
        } as unknown as Mesh;
        const owned = resources();

        const result = buildNodeMeshRenderables(scene, [mesh, secondMesh], material, owned);

        expect(result.renderables).toHaveLength(2);
        result.renderables[0]!.bind(scene.surface.engine, {} as RenderTargetSignature);
        result.renderables[1]!.bind(scene.surface.engine, {} as RenderTargetSignature);
        const pipelineForMesh = (material._compile as unknown as { _pipelineForMesh: ReturnType<typeof vi.fn> })._pipelineForMesh;
        expect(pipelineForMesh).toHaveBeenNthCalledWith(1, mesh._gpu);
        expect(pipelineForMesh).toHaveBeenNthCalledWith(2, secondMesh._gpu);
        owned._lifetimeDisposers.forEach((dispose) => dispose());
    });

    it("invokes an installed vertex-feature binder before creating the mesh bind group", () => {
        const { scene, mesh, material } = createFixture();
        const featureBuffer = {} as GPUBuffer;
        const bindFeature = vi.fn((_engine: EngineContext, _mesh: Mesh, entries: GPUBindGroupEntry[]) => {
            entries.push({ binding: 2, resource: { buffer: featureBuffer } });
        });
        (material._compile as unknown as { _bindVertexFeature?: typeof bindFeature })._bindVertexFeature = bindFeature;
        const owned = resources();

        buildNodeMeshRenderables(scene, [mesh], material, owned);

        expect(bindFeature).toHaveBeenCalledWith(scene.surface.engine, mesh, expect.any(Array));
        const descriptor = vi.mocked(scene.surface.engine._device.createBindGroup).mock.calls[0]![0];
        expect(Array.from(descriptor.entries).at(-1)).toEqual({ binding: 2, resource: { buffer: featureBuffer } });
        owned._lifetimeDisposers.forEach((dispose) => dispose());
    });

    it("registers both normal-renderer UBOs before a later bind-group failure", () => {
        const { scene, mesh, material, buffers } = createFixture(true);
        const owned = resources();

        expect(() => buildNodeMeshRenderables(scene, [mesh], material, owned)).toThrow("node bind group failed");
        expect(owned._lifetimeDisposers).toHaveLength(2);
        expect(scene._disposables).toHaveLength(0);
        owned._lifetimeDisposers.forEach((dispose) => dispose());
        expect(buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
    });

    it("keeps normal-renderer UBOs scene-owned when no explicit sink is supplied", () => {
        const { scene, mesh, material, buffers } = createFixture();

        buildNodeMeshRenderables(scene, [mesh], material);

        expect(scene._disposables).toHaveLength(2);
        scene._disposables.forEach((dispose) => dispose());
        expect(buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
    });

    it("keeps shared geometry-view resources until the last explicit mesh owner retires", () => {
        const first = createFixture();
        const secondMesh = { ...first.mesh, worldMatrix: new Float32Array(16) } as unknown as Mesh;
        const sharedUBO = { destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
        const geometry = {
            _vertexWgsl: "",
            _fragmentWgsl: "",
            _geomState: {},
            _struct: "",
            _fsReturn: "",
            _needsGpUbo: false,
            _attrNames: [],
            _compileBySig: new Map(),
            _nodeUBO: sharedUBO,
            _nodeUBOReady: true,
            _owners: 0,
        };
        const view = {
            source: first.material,
            _geometry: geometry,
            _camera: null,
        } as unknown as NodeGeometryMaterialView;
        const firstOwner = resources();
        const secondOwner = resources();

        buildNodeGeometryRenderable(first.scene, first.mesh, view, firstOwner);
        buildNodeGeometryRenderable(first.scene, secondMesh, view, secondOwner);

        firstOwner._lifetimeDisposers.forEach((dispose) => dispose());
        expect(sharedUBO.destroy).not.toHaveBeenCalled();
        expect(view._geometry).toBe(geometry);

        secondOwner._lifetimeDisposers.forEach((dispose) => dispose());
        expect(sharedUBO.destroy).toHaveBeenCalledOnce();
        expect(view._geometry).toBeUndefined();
        expect(first.buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
    });

    it("rolls back explicitly-owned geometry resources after a bind-group failure", () => {
        const fixture = createFixture(true);
        const owner = resources();
        const sharedUBO = { destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
        const signature = {
            _colorFormat: "rgba8unorm",
            _depthStencilFormat: "depth24plus",
            _sampleCount: 1,
        } as RenderTargetSignature;
        const geometry = {
            _vertexWgsl: "",
            _fragmentWgsl: "",
            _geomState: {},
            _struct: "",
            _fsReturn: "",
            _needsGpUbo: false,
            _attrNames: [],
            _compileBySig: new Map([[targetSignatureKey(signature), fixture.material._compile]]),
            _nodeUBO: sharedUBO,
            _nodeUBOReady: true,
            _owners: 0,
        };
        const view = { source: fixture.material, _geometry: geometry, _camera: null } as unknown as NodeGeometryMaterialView;
        const renderable = buildNodeGeometryRenderable(fixture.scene, fixture.mesh, view, owner);

        expect(() => renderable.bind(fixture.scene.surface.engine, signature)).toThrow("node bind group failed");
        owner._lifetimeDisposers.forEach((dispose) => dispose());
        expect(sharedUBO.destroy).toHaveBeenCalledOnce();
        expect(fixture.buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
        expect(view._geometry).toBeUndefined();
    });

    it("preserves a replacement cache when the last owner of a detached cache retires", () => {
        const first = createFixture();
        const sharedUBO = { destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
        const geometry = {
            _vertexWgsl: "",
            _fragmentWgsl: "",
            _geomState: {},
            _struct: "",
            _fsReturn: "",
            _needsGpUbo: false,
            _attrNames: [],
            _compileBySig: new Map(),
            _nodeUBO: sharedUBO,
            _nodeUBOReady: true,
            _owners: 0,
        };
        const view = { source: first.material, _geometry: geometry, _camera: null } as unknown as NodeGeometryMaterialView;
        const owner = resources();
        buildNodeGeometryRenderable(first.scene, first.mesh, view, owner);

        const replacement = { ...geometry, _compileBySig: new Map([["replacement", {}]]), _nodeUBO: null, _owners: 0 };
        view._geometry = replacement;
        owner._lifetimeDisposers.forEach((dispose) => dispose());

        expect(sharedUBO.destroy).toHaveBeenCalledOnce();
        expect(view._geometry).toBe(replacement);
        expect(replacement._compileBySig.size).toBe(1);
    });

    it("keeps a shared cache alive when the second task owner retires before the first", () => {
        const first = createFixture();
        const secondMesh = { ...first.mesh, worldMatrix: new Float32Array(16) } as unknown as Mesh;
        const sharedUBO = { destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
        const geometry = {
            _vertexWgsl: "",
            _fragmentWgsl: "",
            _geomState: {},
            _struct: "",
            _fsReturn: "",
            _needsGpUbo: false,
            _attrNames: [],
            _compileBySig: new Map(),
            _nodeUBO: sharedUBO,
            _nodeUBOReady: true,
            _owners: 0,
        };
        const view = { source: first.material, _geometry: geometry, _camera: null } as unknown as NodeGeometryMaterialView;
        const firstOwner = resources();
        const secondOwner = resources();
        buildNodeGeometryRenderable(first.scene, first.mesh, view, firstOwner);
        buildNodeGeometryRenderable(first.scene, secondMesh, view, secondOwner);

        secondOwner._lifetimeDisposers.forEach((dispose) => dispose());
        expect(sharedUBO.destroy).not.toHaveBeenCalled();
        expect(view._geometry).toBe(geometry);

        firstOwner._lifetimeDisposers.forEach((dispose) => dispose());
        expect(sharedUBO.destroy).toHaveBeenCalledOnce();
        expect(view._geometry).toBeUndefined();
    });
});
