import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import type { ShaderUniformOption } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import type { DrawUpdateContext } from "../../../packages/babylon-lite/src/render/renderable";
import type { UniformCopyBatch } from "../../../packages/babylon-lite/src/render/uniform-copy-batch";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import { multiplyMat4IntoBuffer } from "../../../packages/babylon-lite/src/math/multiply-mat4-into-buffer";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

interface Upload {
    buffer: GPUBuffer;
    bytes: Uint8Array;
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

async function fixture(uniforms: readonly ShaderUniformOption[], cached: boolean, batched = false, textured = false) {
    const cameraModule = await import("../../../packages/babylon-lite/src/camera/camera");
    const { createFreeCamera } = await import("../../../packages/babylon-lite/src/camera/free-camera");
    const { initMeshTransform } = await import("../../../packages/babylon-lite/src/mesh/mesh");
    const materialModule = await import("../../../packages/babylon-lite/src/material/shader/shader-material");
    const { buildShaderMaterialRenderables } = await import("../../../packages/babylon-lite/src/material/shader/shader-renderable");
    const { getOrCreateShaderPipelineBindings } = await import("../../../packages/babylon-lite/src/material/shader/shader-pipeline");
    if (cached) {
        const { enableShaderMaterialUniformCaching } = await import("../../../packages/babylon-lite/src/material/shader/enable-shader-material-uniform-caching");
        enableShaderMaterialUniformCaching();
    }
    const uploads: Upload[] = [];
    const copies: Upload[] = [];
    const snapshot = (buffer: GPUBuffer, data: ArrayBuffer | ArrayBufferView, offset = 0, size?: number): Upload => {
        const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        return { buffer, bytes: bytes.slice(offset, size === undefined ? undefined : offset + size) };
    };
    const buffers: GPUBuffer[] = [];
    const createBindGroup = vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup);
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const buffer = { label: descriptor.label, size: descriptor.size, destroy: vi.fn() } as unknown as GPUBuffer;
            buffers.push(buffer);
            return buffer;
        }),
        createBindGroup,
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        queue: {
            writeBuffer: vi.fn((buffer: GPUBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView, offset?: number, size?: number) => {
                uploads.push(snapshot(buffer, data, offset, size));
            }),
        },
    } as unknown as GPUDevice;
    const engine = { _device: device, canvas: { width: 128, height: 64 } } as unknown as EngineContext;
    const material = materialModule.createShaderMaterial({
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        attributes: ["position"],
        uniforms,
        samplers: textured ? ["color"] : [],
    });
    const texture = {
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        texture: { destroy: vi.fn() } as unknown as GPUTexture,
        width: 1,
        height: 1,
    } satisfies Texture2D;
    if (textured) {
        materialModule.setShaderTexture(material, "color", texture);
    }
    const mesh = initMeshTransform({
        name: "dependencies",
        children: [],
        material,
        receiveShadows: false,
        _gpu: {
            positionBuffer: {} as GPUBuffer,
            normalBuffer: {} as GPUBuffer,
            uvBuffer: {} as GPUBuffer,
            indexBuffer: {} as GPUBuffer,
            indexCount: 3,
            indexFormat: "uint32",
        },
    });
    mesh.position.x = 10;
    const camera = createFreeCamera({ x: 2, y: 3, z: -4 }, { x: 0, y: 0, z: 0 });
    const scene = { surface: { engine }, camera, _meshDisposables: new Map() } as unknown as SceneContext;
    const worldQuery = vi.spyOn(mesh, "worldMatrix", "get");
    const worldVersionQuery = vi.spyOn(mesh, "worldMatrixVersion", "get");
    const cameraVersionQuery = vi.spyOn(camera, "worldMatrixVersion", "get");
    const changeKey = vi.spyOn(cameraModule, "_cameraChangeKey");
    const aspectQuery = vi.spyOn(cameraModule, "getEffectiveAspectRatio");
    const viewQuery = vi.spyOn(cameraModule, "getViewMatrix");
    const projectionQuery = vi.spyOn(cameraModule, "getProjectionMatrix");
    const vpQuery = vi.spyOn(cameraModule, "getViewProjectionMatrix");
    const batch = {
        queue: vi.fn((buffer: GPUBuffer, data: ArrayBufferView) => {
            copies.push(snapshot(buffer, data));
        }),
    } as unknown as UniformCopyBatch;
    const result = buildShaderMaterialRenderables(scene, [mesh], batched ? () => batch : undefined);
    const signature = { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature;
    const binding = result.renderables[0]!.bind(engine, signature);
    const systemBuffer = buffers.find((buffer) => buffer.label === "shader-system-ubo")!;
    const spec = getOrCreateShaderPipelineBindings(engine, material).systemSpec;
    const context: { -readonly [K in keyof DrawUpdateContext]: DrawUpdateContext[K] } = { targetWidth: 128, targetHeight: 64 };
    const systemWrites = () => [...uploads, ...copies].filter((upload) => upload.buffer === systemBuffer);
    const clear = () => {
        uploads.length = copies.length = 0;
        vi.clearAllMocks();
    };
    const update = () => binding.update!(context);
    // Mirrors scene-core: flagging floating origin also invalidates the view/view-projection caches.
    const setFloatingOrigin = (target: typeof camera, enabled: boolean) => {
        target._useFloatingOrigin = enabled;
        target._viewVer = -1;
        target._vpVer = -1;
    };
    const warm = () => {
        update();
        clear();
    };
    const reference = () => {
        const bytes = new Float32Array(spec._totalBytes / 4);
        const active = context._camera ?? scene.camera;
        const fresh = active
            ? {
                  ...active,
                  _viewCache: new Float32Array(16),
                  _projCache: new Float32Array(16),
                  _vpCache: new Float32Array(16),
                  _viewVer: undefined,
                  _projVer: undefined,
                  _vpVer: undefined,
              }
            : null;
        const world = new Float32Array(mesh.worldMatrix);
        if (fresh?._useFloatingOrigin) {
            for (let i = 12; i < 15; i++) {
                world[i] = mesh.worldMatrix[i]! - fresh.worldMatrix[i]!;
            }
        }
        const aspect = fresh ? cameraModule.getEffectiveAspectRatio(fresh, context.targetWidth, context.targetHeight) : 1;
        const view = fresh ? new Float32Array(cameraModule.getViewMatrix(fresh)) : null;
        const projection = fresh ? new Float32Array(cameraModule.getProjectionMatrix(fresh, aspect)) : null;
        const vp = fresh ? new Float32Array(cameraModule.getViewProjectionMatrix(fresh, aspect)) : null;
        for (const decl of material.uniformDecls) {
            const offset = spec._offsets.get(decl.name);
            if (offset === undefined) {
                continue;
            }
            const index = offset / 4;
            switch (decl.name) {
                case "world":
                    bytes.set(world, index);
                    break;
                case "view":
                    if (view) {
                        bytes.set(view, index);
                    }
                    break;
                case "projection":
                    if (projection) {
                        bytes.set(projection, index);
                    }
                    break;
                case "viewProjection":
                    if (vp) {
                        bytes.set(vp, index);
                    }
                    break;
                case "worldView":
                    if (view) {
                        multiplyMat4IntoBuffer(bytes, index, view, 0, world, 0);
                    }
                    break;
                case "worldViewProjection":
                    if (vp) {
                        multiplyMat4IntoBuffer(bytes, index, vp, 0, world, 0);
                    }
                    break;
                case "cameraPosition":
                    if (fresh && !fresh._useFloatingOrigin) {
                        bytes.set(Array.from(fresh.worldMatrix).slice(12, 15), index);
                    }
                    break;
                case "screenSize":
                    bytes.set([context.targetWidth, context.targetHeight], index);
                    break;
                case "alphaCutoff":
                    bytes[index] = material._uniformValues.get("alphaCutoff")?.value[0] ?? 0.4;
                    break;
            }
        }
        return new Uint8Array(bytes.buffer);
    };
    const expectWrite = () => {
        const writes = systemWrites();
        expect(writes).toHaveLength(1);
        expect(writes[0]!.bytes.byteLength).toBe(spec._totalBytes);
        expect(writes[0]!.bytes).toEqual(reference());
    };
    return {
        ...materialModule,
        binding,
        result,
        scene,
        engine,
        material,
        mesh,
        camera,
        createFreeCamera,
        systemBuffer,
        spec,
        context,
        systemWrites,
        clear,
        warm,
        update,
        setFloatingOrigin,
        expectWrite,
        uploads,
        copies,
        createBindGroup,
        texture,
        worldQuery,
        worldVersionQuery,
        cameraVersionQuery,
        changeKey,
        aspectQuery,
        viewQuery,
        projectionQuery,
        vpQuery,
    };
}

describe.each([false, true])("ShaderMaterial system dependencies (cached=%s)", (cached) => {
    it.each([{ uniforms: [] }, { uniforms: ["world"] }] satisfies { uniforms: ShaderUniformOption[] }[])(
        "skips irrelevant camera/target/alpha work for $uniforms",
        async ({ uniforms }) => {
            const f = await fixture(uniforms, cached);
            expect(f.viewQuery).not.toHaveBeenCalled();
            expect(f.projectionQuery).not.toHaveBeenCalled();
            expect(f.vpQuery).not.toHaveBeenCalled();
            expect(f.aspectQuery).not.toHaveBeenCalled();
            if (uniforms.length === 0) {
                expect(f.worldQuery).not.toHaveBeenCalled();
            }
            f.warm();
            f.camera.position.x += 1;
            f.context.targetWidth *= 2;
            f.camera.viewport = { x: 0, y: 0, width: 0.5, height: 1 };
            f.update();
            expect(f.systemWrites()).toHaveLength(0);
            expect(f.changeKey).not.toHaveBeenCalled();
            expect(f.cameraVersionQuery).not.toHaveBeenCalled();
            expect(f.aspectQuery).not.toHaveBeenCalled();
            expect(f.worldQuery).not.toHaveBeenCalled();
            if (uniforms.length === 0) {
                expect(f.worldVersionQuery).not.toHaveBeenCalled();
            }
        }
    );

    it.each(["view", "projection", "viewProjection", "cameraPosition"] as const)("does not query or upload mesh transforms for %s", async (name) => {
        const f = await fixture([name], cached);
        expect(f.worldQuery).not.toHaveBeenCalled();
        f.warm();
        f.mesh.position.x += 1;
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
        expect(f.worldQuery).not.toHaveBeenCalled();
        expect(f.worldVersionQuery).not.toHaveBeenCalled();
    });

    it("keeps view and camera position independent of viewport/target aspect but follows the camera change key", async () => {
        const f = await fixture(["view", "cameraPosition"], cached);
        f.warm();
        f.camera.viewport = { x: 0, y: 0, width: 0.5, height: 1 };
        f.context.targetWidth *= 2;
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
        expect(f.changeKey).toHaveBeenCalledWith(f.camera);
        expect(f.aspectQuery).not.toHaveBeenCalled();
        f.camera.position.x += 1;
        f.update();
        f.expectWrite();
        f.clear();
        f.camera.fov *= 0.5;
        f.update();
        f.expectWrite();
    });

    it("invalidates projection on camera change key, projection edits and aspect", async () => {
        const f = await fixture(["projection"], cached);
        f.warm();
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
        expect(f.changeKey).toHaveBeenCalledWith(f.camera);
        f.camera.position.x += 1;
        f.update();
        f.expectWrite();
        f.clear();
        f.camera.fov *= 0.5;
        f.update();
        f.expectWrite();
        f.clear();
        f.camera.viewport = { x: 0, y: 0, width: 0.5, height: 1 };
        f.update();
        f.expectWrite();
        f.clear();
        f.context.targetWidth *= 2;
        f.update();
        f.expectWrite();
        f.clear();
        f.context.targetWidth *= 2;
        f.context.targetHeight *= 2;
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
    });

    it("uses target dimensions, not camera or viewport state, for screenSize", async () => {
        const f = await fixture(["screenSize"], cached);
        f.warm();
        f.camera.position.x += 1;
        f.camera.viewport = { x: 0, y: 0, width: 0.5, height: 1 };
        f.mesh.position.x += 1;
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
        expect(f.cameraVersionQuery).not.toHaveBeenCalled();
        expect(f.aspectQuery).not.toHaveBeenCalled();
        expect(f.worldVersionQuery).not.toHaveBeenCalled();
        f.context.targetWidth += 1;
        f.update();
        f.expectWrite();
    });

    it("keys alphaCutoff by its value only", async () => {
        const f = await fixture(["alphaCutoff", { name: "time", type: "f32" }], cached);
        f.warm();
        f.setShaderFloat(f.material, "time", 1);
        f.camera.position.x += 1;
        f.mesh.position.x += 1;
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
        expect(f.worldVersionQuery).not.toHaveBeenCalled();
        expect(f.cameraVersionQuery).not.toHaveBeenCalled();
        f.setShaderFloat(f.material, "alphaCutoff", 0.25);
        f.update();
        f.expectWrite();
        f.clear();
        f.setShaderFloat(f.material, "alphaCutoff", 0.25);
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
    });

    it("tracks world parents and floating-origin camera motion/toggles/alternate cameras", async () => {
        const f = await fixture(["world"], cached);
        f.warm();
        const { createSceneNode } = await import("../../../packages/babylon-lite/src/scene/scene-node");
        const parent = createSceneNode("parent", 4);
        f.mesh.parent = parent;
        f.update();
        f.expectWrite();
        f.clear();
        parent.position.x += 3;
        f.update();
        f.expectWrite();
        f.clear();
        f.setFloatingOrigin(f.camera, true);
        f.update();
        f.expectWrite();
        f.clear();
        f.camera.position.x += 1;
        f.update();
        f.expectWrite();
        f.clear();
        const alternate = f.createFreeCamera({ x: 9, y: 0, z: -4 }, { x: 0, y: 0, z: 0 });
        f.setFloatingOrigin(alternate, true);
        f.context._camera = alternate;
        f.update();
        f.expectWrite();
        f.clear();
        f.setFloatingOrigin(alternate, false);
        f.update();
        f.expectWrite();
        f.clear();
        alternate.position.x += 1;
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
    });

    it("retains exact baseline bytes for all uniforms, null camera, resize and FO toggles", async () => {
        const f = await fixture(["world", "view", "projection", "viewProjection", "worldView", "worldViewProjection", "cameraPosition", "screenSize", "alphaCutoff"], cached);
        f.clear();
        f.update();
        f.expectWrite();
        f.clear();
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
        for (const mutate of [
            () => {
                f.camera.position.x += 3;
            },
            () => {
                f.mesh.position.y += 2;
            },
            () => {
                f.setFloatingOrigin(f.camera, true);
            },
            () => {
                f.setFloatingOrigin(f.camera, false);
            },
            () => {
                f.context.targetWidth += 17;
            },
            () => {
                f.camera.viewport = { x: 0.25, y: 0, width: 0.5, height: 1 };
            },
            () => {
                f.context._camera = f.createFreeCamera({ x: -3, y: 5, z: 7 }, { x: 0, y: 0, z: 0 });
            },
            () => {
                f.context._camera = undefined;
                f.scene.camera = null;
            },
        ]) {
            f.clear();
            mutate();
            f.update();
            f.expectWrite();
        }
    });

    it.each([false, true])("preserves initialization, rebuild, binding refresh and disposal (batched=%s)", async (batched) => {
        const f = await fixture(["world", { name: "amount", type: "f32" }], cached, batched, true);
        expect(f.uploads.filter((upload) => upload.buffer === f.systemBuffer)).toHaveLength(1);
        f.warm();
        f.texture.view = {} as GPUTextureView;
        f.setShaderTexture(f.material, "color", f.texture);
        f.update();
        expect(f.createBindGroup).toHaveBeenCalledTimes(1);
        expect(f.systemWrites()).toHaveLength(0);
        f.clear();
        f.mesh.position.x += 1;
        f.update();
        f.expectWrite();
        expect(batched ? f.copies : f.uploads).toHaveLength(1);
        f.clear();
        const rebuilt = f.result.rebuildSingle!(f.scene, f.mesh);
        expect(f.uploads.filter((upload) => upload.buffer.label === "shader-system-ubo")).toHaveLength(1);
        const binding = rebuilt.bind(f.engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature);
        f.clear();
        binding.update!(f.context);
        expect([...f.uploads, ...f.copies].filter((upload) => upload.buffer.label === "shader-system-ubo")).toHaveLength(1);
        for (const dispose of f.scene._meshDisposables.get(f.mesh)!) {
            dispose();
        }
        f.clear();
        f.mesh.position.x += 1;
        f.update();
        binding.update!(f.context);
        expect(f.systemWrites()).toHaveLength(0);
        expect(f.worldVersionQuery).not.toHaveBeenCalled();
    });

    it("snapshots caller declarations so layout and dependencies cannot drift", async () => {
        const uniform = { name: "world", type: "mat4x4<f32>" } as const;
        const uniforms: ShaderUniformOption[] = [uniform];
        const f = await fixture(uniforms, cached);
        Object.assign(uniform, { name: "view" });
        uniforms.length = 0;
        expect(f.material.uniformDecls[0]!.name).toBe("world");
        f.warm();
        f.mesh.position.x += 1;
        f.update();
        f.expectWrite();
    });

    it.each(["worldView", "worldViewProjection"] as const)("invalidates both transform dependencies for %s", async (name) => {
        const f = await fixture([name], cached);
        f.warm();
        f.mesh.position.x += 1;
        f.update();
        f.expectWrite();
        f.clear();
        f.camera.position.y += 1;
        f.update();
        f.expectWrite();
        f.clear();
        f.setFloatingOrigin(f.camera, true);
        f.update();
        f.expectWrite();
        f.clear();
        f.setFloatingOrigin(f.camera, false);
        f.update();
        f.expectWrite();
    });

    it.each(["projection", "viewProjection", "worldViewProjection"] as const)("reuploads %s for injected per-view XR projections", async (name) => {
        const f = await fixture([name], cached);
        const { createXrCamera, updateXrCameraForView } = await import("../../../packages/babylon-lite/src/xr/xr-camera");
        const xr = createXrCamera("left");
        const viewport = { x: 0, y: 0, width: 1, height: 1 };
        // One camera renders both eyes: the second injection advances only worldMatrixVersion.
        const eye = (x: number, focal: number) => {
            const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
            const projectionMatrix = new Float32Array([focal, 0, 0, 0, 0, focal, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]);
            return { projectionMatrix, transform: { matrix } } as unknown as XRView;
        };
        f.context._camera = xr;
        for (const view of [eye(-0.03, 1), eye(0.03, 2)]) {
            updateXrCameraForView(xr, view, f.context.targetWidth, f.context.targetHeight, viewport);
            const injected = new Float32Array(xr._projCache!);
            f.clear();
            f.update();
            const writes = f.systemWrites();
            expect(writes).toHaveLength(1);
            const uploaded = new Float32Array(writes[0]!.bytes.slice().buffer, f.spec._offsets.get(name)!, 16);
            expect(new Float32Array(xr._projCache!)).toEqual(injected);
            const expected = new Float32Array(16);
            if (name === "projection") {
                expected.set(injected);
            } else if (name === "viewProjection") {
                expected.set(xr._vpCache!);
            } else {
                multiplyMat4IntoBuffer(expected, 0, xr._vpCache!, 0, new Float32Array(f.mesh.worldMatrix), 0);
            }
            expect(uploaded).toEqual(expected);
        }
    });

    it("invalidates projection plane/orthographic edits and alternate camera identity", async () => {
        const f = await fixture(["projection"], cached);
        f.warm();
        for (const mutate of [
            () => {
                f.camera.nearPlane *= 2;
            },
            () => {
                f.camera.farPlane *= 2;
            },
            () => {
                f.context._camera = f.createFreeCamera({ x: 2, y: 3, z: -4 }, { x: 0, y: 0, z: 0 });
            },
        ]) {
            mutate();
            f.update();
            f.expectWrite();
            f.clear();
        }
        f.context._camera = undefined;
        f.update();
        f.clear();
        const { enableOrthographicCamera } = await import("../../../packages/babylon-lite/src/camera/orthographic");
        enableOrthographicCamera(f.camera, { left: -2, right: 2, top: 2, bottom: -2 });
        f.update();
        f.expectWrite();
        f.clear();
        f.camera.ortho!.left = -4;
        f.update();
        f.expectWrite();
    });

    it("does not reupload the empty padding block on the first update", async () => {
        const f = await fixture([], cached, true);
        expect(f.systemWrites()).toHaveLength(1);
        expect(f.systemWrites()[0]!.bytes).toEqual(new Uint8Array(16));
        f.clear();
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
        expect(f.worldVersionQuery).not.toHaveBeenCalled();
        expect(f.cameraVersionQuery).not.toHaveBeenCalled();
    });
});
