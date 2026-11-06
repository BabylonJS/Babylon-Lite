import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MeshOpacity from "../../../packages/babylon-lite/src/mesh/opacity/mesh-opacity";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { validateMeshLoDMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-mesh-lod-material";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose";
import { cloneTransformNode, createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import { setSubtreeVisible } from "../../../packages/babylon-lite/src/scene/visibility";

let opacity: typeof MeshOpacity;

beforeEach(async () => {
    vi.resetModules();
    opacity = await import("../../../packages/babylon-lite/src/mesh/opacity/mesh-opacity");
});

function mesh(material: Mesh["material"] = createStandardMaterial()): Mesh {
    const buffer = (): GPUBuffer => ({ destroy: vi.fn() }) as unknown as GPUBuffer;
    const gpu: MeshGPU = {
        positionBuffer: buffer(),
        normalBuffer: buffer(),
        uvBuffer: buffer(),
        indexBuffer: buffer(),
        indexCount: 3,
        indexFormat: "uint16",
    };
    return Object.assign(createTransformNode("opacity-source"), {
        _gpu: gpu,
        material,
        visible: true,
        pickable: true,
        receiveShadows: true,
    }) as Mesh;
}

function unsupportedMaterial(family: "node" | "shader"): Material {
    return { _buildGroup: Object.assign(vi.fn(), { _materialFamily: family }) } as unknown as Material;
}

function scene(): SceneContext {
    return { _materialSwapQueue: [], _meshMaterialChange: vi.fn() } as unknown as SceneContext;
}

async function extensions(): Promise<readonly [readonly string[], readonly string[]]> {
    const standard = await import("../../../packages/babylon-lite/src/material/standard/standard-flags");
    const pbr = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
    return [standard._getStdExtsSorted().map((ext) => ext._id), pbr._getPbrExtsSorted().map((ext) => ext.id)];
}

function bindingEngine() {
    const writes: { buffer: GPUBuffer; value: number; bytes: number; offset: number }[] = [];
    const contents = new Map<GPUBuffer, Float32Array>();
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const buffer = { size: descriptor.size, destroy: vi.fn() } as unknown as GPUBuffer;
            contents.set(buffer, new Float32Array(Number(descriptor.size) / 4));
            return buffer;
        }),
        queue: {
            writeBuffer: vi.fn((buffer: GPUBuffer, destinationOffset: number, data: ArrayBuffer | ArrayBufferView, offset = 0, size?: number) => {
                const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data, offset, size);
                const values = new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
                contents.get(buffer)!.set(values, destinationOffset / 4);
                writes.push({ buffer, value: values[0]!, bytes: view.byteLength, offset: destinationOffset });
            }),
        },
    } as unknown as GPUDevice;
    return { engine: { _device: device } as EngineContext, device, writes, contents };
}

async function bindOpacity(
    target: Mesh,
    engine: EngineContext,
    route: "standard-main" | "standard-geometry" | "pbr-main" | "pbr-geometry",
    disposers: (() => void)[] = [],
    material: Mesh["material"] = target.material
) {
    const entries: GPUBindGroupEntry[] = [];
    let next: number;
    if (route.startsWith("standard")) {
        const standard = await import("../../../packages/babylon-lite/src/material/standard/standard-flags");
        const ext = standard._getStdExtsSorted().find((entry) => entry._id === "0-mesh-opacity")!;
        next = ext._bind!(target.material as StandardMaterialProps, entries, 7, target, { surface: { engine } } as SceneContext, disposers, route === "standard-geometry");
    } else {
        const pbr = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
        const ext = pbr._getPbrExtsSorted().find((entry) => entry.id === "z-mesh-opacity")!;
        const { _computeMeshFeatures } = await import("../../../packages/babylon-lite/src/material/mesh-features");
        const meshFeatures = _computeMeshFeatures(target);
        next = ext.bind!(
            {
                _engine: engine,
                _material: material,
                _mesh: target,
                _features: route === "pbr-main" ? (meshFeatures >>> 16) & pbr.PBR_HAS_ALPHA_BLEND : 0,
                _features2: 0,
                _meshFeatures: meshFeatures,
                _disposers: disposers,
            },
            entries,
            7
        );
    }
    return { entries, next, disposers, buffer: (entries[0]!.resource as GPUBufferBinding).buffer };
}

describe("native mesh-opacity public contract", () => {
    it("reads the default without mutating the mesh or installing extensions", async () => {
        const target = mesh();
        const before = Object.getOwnPropertyDescriptors(target);
        const registered = await extensions();
        expect(opacity.getMeshOpacity(target)).toBe(1);
        expect(Object.getOwnPropertyDescriptors(target)).toEqual(before);
        expect(await extensions()).toEqual(registered);
    });

    it("owns the live skip flag, clears it at fraction/one, and preserves it on failed assignments", () => {
        const target = mesh();
        expect(target).not.toHaveProperty("_skipColorDraw");
        for (const value of [0, 0.4, 0, 1]) {
            opacity.setMeshOpacity(target, value);
            expect(target._skipColorDraw).toBe(value === 0);
            expect(() => opacity.setMeshOpacity(target, NaN)).toThrow(RangeError);
            expect(target._skipColorDraw).toBe(value === 0);
            expect(opacity.getMeshOpacity(target)).toBe(value);
        }
        opacity.setMeshOpacity(target, 0);
        const clone = cloneTransformNode(target) as Mesh;
        expect(clone._skipColorDraw).toBe(true);
        opacity.setMeshOpacity(clone, 1);
        expect(clone._skipColorDraw).toBe(false);
        expect(target._skipColorDraw).toBe(true);
        expect(opacity.getMeshOpacity(target)).toBe(0);
    });

    it("keeps an opacity-zero mesh visible to accessibility projection and picking eligibility", async () => {
        const { createNullEngine } = await import("../../../packages/babylon-lite/src/engine/null-engine");
        const { createSceneContext, disposeScene } = await import("../../../packages/babylon-lite/src/scene/scene-core");
        const { createSceneAccessibility, getAccessibilityNode, setAccessibilityTag, updateSceneAccessibility } =
            await import("../../../packages/babylon-lite/src/accessibility/scene-accessibility");
        const target = mesh();
        const owner = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        setAccessibilityTag(target, { name: "opacity-source" });
        const projection = createSceneAccessibility(owner, { roots: [target] });
        const node = getAccessibilityNode(projection, target)!;
        for (const value of [0, 0.5, 1]) {
            opacity.setMeshOpacity(target, value);
            updateSceneAccessibility(projection);
            expect(target.visible).toBe(true);
            expect(target.pickable).toBe(true);
            expect(getAccessibilityNode(projection, target)).toBe(node);
            expect(node.hidden).toBe(false);
            expect(node._selfHidden).toBe(false);
        }
        disposeScene(owner);
    });

    describe("binding-owned mesh-opacity buffers", () => {
        it.each(["standard-main", "standard-geometry", "pbr-main", "pbr-geometry"] as const)("initializes and directly updates exactly one padded binding on %s", async (route) => {
            const target = mesh(route.startsWith("standard") ? createStandardMaterial() : createPbrMaterial());
            const fixture = bindingEngine();
            opacity.setMeshOpacity(target, 0.6);
            const binding = await bindOpacity(target, fixture.engine, route);
            expect(binding.next).toBe(8);
            expect(binding.entries).toEqual([{ binding: 7, resource: { buffer: binding.buffer } }]);
            expect(binding.buffer.size).toBe(16);
            expect(fixture.writes).toHaveLength(1);
            expect(fixture.writes[0]!.value).toBeCloseTo(0.6);
            expect(fixture.writes[0]!.bytes).toBe(8);
            vi.mocked(fixture.device.queue.writeBuffer).mockClear();
            for (const [value, writes] of [
                [0.4, 1],
                [0, 2],
                [0.3, 3],
                [0.3, 3],
                [1, 4],
            ] as const) {
                opacity.setMeshOpacity(target, value);
                expect(fixture.device.queue.writeBuffer).toHaveBeenCalledTimes(writes);
            }
            expect(fixture.device.createBuffer).toHaveBeenCalledTimes(1);
            expect(binding.buffer.destroy).not.toHaveBeenCalled();
            expect(fixture.writes.slice(1).map((write) => write.bytes)).toEqual([4, 4, 4, 4]);
            expect(fixture.writes.slice(1).map((write) => write.buffer)).toEqual([binding.buffer, binding.buffer, binding.buffer, binding.buffer]);
            for (const dispose of binding.disposers) {
                dispose();
            }
            expect(binding.buffer.destroy).toHaveBeenCalledTimes(1);
        });

        it.each(["standard-main", "standard-geometry", "pbr-main", "pbr-geometry"] as const)(
            "updates the retained %s binding across rapid 0.3 → 1 → 0.6 without draining the rebuild queue",
            async (route) => {
                const target = mesh(route.startsWith("standard") ? createStandardMaterial() : createPbrMaterial());
                const fixture = bindingEngine();
                opacity.setMeshOpacity(target, 0.3);
                const current = await bindOpacity(target, fixture.engine, route);
                const registry = await import("../../../packages/babylon-lite/src/scene/mesh-scene-registry");
                const owners = [scene(), scene()];
                owners.forEach((owner) => registry.registerMeshScene(owner, target));
                const dirty = vi.spyOn(registry, "markMeshRenderableDirty");
                vi.mocked(fixture.device.queue.writeBuffer).mockClear();
                opacity.setMeshOpacity(target, 1);
                expect(fixture.contents.get(current.buffer)![0]).toBe(1);
                expect(fixture.device.queue.writeBuffer).toHaveBeenCalledExactlyOnceWith(current.buffer, 0, expect.any(Float32Array));
                opacity.setMeshOpacity(target, 0.6);
                opacity.setMeshOpacity(target, 0.6);
                expect(dirty).toHaveBeenCalledTimes(2);
                owners.forEach((owner) => expect(owner._materialSwapQueue).toEqual([target]));
                expect(fixture.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
                expect(fixture.device.queue.writeBuffer).toHaveBeenLastCalledWith(current.buffer, 0, expect.any(Float32Array));
                expect(fixture.contents.get(current.buffer)![0]).toBeCloseTo(0.6);
                expect(fixture.device.createBuffer).toHaveBeenCalledTimes(1);
                const replacement = await bindOpacity(target, fixture.engine, route);
                expect(fixture.contents.get(replacement.buffer)![0]).toBeCloseTo(0.6);
                expect(replacement.buffer).not.toBe(current.buffer);
                [...current.disposers, ...replacement.disposers].forEach((dispose) => dispose());
                dirty.mockRestore();
            }
        );

        it.each(["standard-geometry", "pbr-geometry"] as const)("writes 1 to a retained off-scene geometry binding on %s", async (route) => {
            const target = mesh(route === "standard-geometry" ? createStandardMaterial() : createPbrMaterial());
            const fixture = bindingEngine();
            opacity.setMeshOpacity(target, 0.5);
            const binding = await bindOpacity(target, fixture.engine, route);
            vi.mocked(fixture.device.queue.writeBuffer).mockClear();
            opacity.setMeshOpacity(target, 1);
            expect(fixture.device.queue.writeBuffer).toHaveBeenCalledExactlyOnceWith(binding.buffer, 0, expect.any(Float32Array));
            expect(fixture.contents.get(binding.buffer)![0]).toBe(1);
            expect(fixture.writes.at(-1)!.bytes).toBe(4);
            binding.disposers.forEach((dispose) => dispose());
        });

        it("reuses one PBR buffer and record for repeated binds with the same lifetime and device", async () => {
            const target = mesh(createPbrMaterial());
            const fixture = bindingEngine();
            opacity.setMeshOpacity(target, 0.5);
            const current = await bindOpacity(target, fixture.engine, "pbr-main");
            for (let i = 0; i < 5; i++) {
                const rebound = await bindOpacity(target, fixture.engine, "pbr-main", current.disposers);
                expect(rebound.buffer).toBe(current.buffer);
                expect(rebound.entries).toEqual([{ binding: 7, resource: { buffer: current.buffer } }]);
                expect(rebound.next).toBe(8);
            }
            expect(fixture.device.createBuffer).toHaveBeenCalledTimes(1);
            expect(current.disposers).toHaveLength(1);
            expect(fixture.device.queue.writeBuffer).toHaveBeenCalledTimes(1);
            vi.mocked(fixture.device.queue.writeBuffer).mockClear();
            opacity.setMeshOpacity(target, 0.4);
            opacity.setMeshOpacity(target, 0.2);
            opacity.setMeshOpacity(target, 0.2);
            expect(fixture.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
            expect(fixture.contents.get(current.buffer)![0]).toBeCloseTo(0.2);

            const separate = await bindOpacity(target, fixture.engine, "pbr-main");
            expect(separate.buffer).not.toBe(current.buffer);
            expect(fixture.device.createBuffer).toHaveBeenCalledTimes(2);
            expect(separate.disposers).toHaveLength(1);
            expect(current.disposers).toHaveLength(1);
            vi.mocked(fixture.device.queue.writeBuffer).mockClear();
            opacity.setMeshOpacity(target, 0.1);
            expect(fixture.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
            expect(fixture.device.queue.writeBuffer).toHaveBeenCalledWith(current.buffer, 0, expect.any(Float32Array));
            expect(fixture.device.queue.writeBuffer).toHaveBeenCalledWith(separate.buffer, 0, expect.any(Float32Array));
            current.disposers[0]!();
            current.disposers[0]!();
            expect(current.buffer.destroy).toHaveBeenCalledTimes(1);
            vi.mocked(fixture.device.queue.writeBuffer).mockClear();
            opacity.setMeshOpacity(target, 0.05);
            expect(fixture.device.queue.writeBuffer).toHaveBeenCalledExactlyOnceWith(separate.buffer, 0, expect.any(Float32Array));
            separate.disposers[0]!();
            separate.disposers[0]!();
            expect(separate.buffer.destroy).toHaveBeenCalledTimes(1);
            vi.mocked(fixture.device.queue.writeBuffer).mockClear();
            opacity.setMeshOpacity(target, 0);
            expect(fixture.device.queue.writeBuffer).not.toHaveBeenCalled();
        });

        it("does not reuse a replaced device's buffer even with the same lifetime array", async () => {
            const target = mesh(createPbrMaterial());
            const old = bindingEngine();
            opacity.setMeshOpacity(target, 0.5);
            const stale = await bindOpacity(target, old.engine, "pbr-main");
            const replacement = bindingEngine();
            old.engine._device = replacement.device;
            const rebound = await bindOpacity(target, old.engine, "pbr-main", stale.disposers);
            expect(rebound.buffer).not.toBe(stale.buffer);
            expect(old.device.createBuffer).toHaveBeenCalledTimes(1);
            expect(replacement.device.createBuffer).toHaveBeenCalledTimes(1);
            expect(stale.disposers).toHaveLength(2);
            vi.mocked(old.device.queue.writeBuffer).mockClear();
            vi.mocked(replacement.device.queue.writeBuffer).mockClear();
            opacity.setMeshOpacity(target, 0.4);
            expect(old.device.queue.writeBuffer).not.toHaveBeenCalled();
            expect(replacement.device.queue.writeBuffer).toHaveBeenCalledExactlyOnceWith(rebound.buffer, 0, expect.any(Float32Array));
            stale.disposers.forEach((dispose) => dispose());
            expect(stale.buffer.destroy).toHaveBeenCalledTimes(1);
            expect(rebound.buffer.destroy).toHaveBeenCalledTimes(1);
        });

        it("retires only the removed scene's records and keeps another scene's main and geometry writable", async () => {
            const target = mesh();
            opacity.setMeshOpacity(target, 0.6);
            const a = bindingEngine();
            const b = bindingEngine();
            const bindingA = await bindOpacity(target, a.engine, "standard-main");
            const bindingB = await bindOpacity(target, b.engine, "standard-main");
            const geometryB = await bindOpacity(target, b.engine, "standard-geometry");
            bindingA.disposers.forEach((dispose) => dispose());
            vi.mocked(a.device.queue.writeBuffer).mockClear();
            vi.mocked(b.device.queue.writeBuffer).mockClear();
            opacity.setMeshOpacity(target, 0.4);
            expect(a.device.queue.writeBuffer).not.toHaveBeenCalled();
            expect(b.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
            expect(bindingA.buffer.destroy).toHaveBeenCalledTimes(1);
            expect(bindingB.buffer.destroy).not.toHaveBeenCalled();
            expect(geometryB.buffer.destroy).not.toHaveBeenCalled();
            // Mesh-GPU disposal is not an opacity-buffer owner; binding teardown is.
            disposeMeshGpu(target);
            expect(bindingB.buffer.destroy).not.toHaveBeenCalled();
            expect(() => opacity.setMeshOpacity(target, 0.2)).toThrow(/disposed/);
            [...bindingB.disposers, ...geometryB.disposers].forEach((dispose) => dispose());
            expect(bindingB.buffer.destroy).toHaveBeenCalledTimes(1);
            expect(geometryB.buffer.destroy).toHaveBeenCalledTimes(1);
        });

        it("deletes a record before destruction and makes repeated retirement harmless", async () => {
            const target = mesh();
            const fixture = bindingEngine();
            opacity.setMeshOpacity(target, 0.6);
            const binding = await bindOpacity(target, fixture.engine, "standard-main");
            vi.mocked(fixture.device.queue.writeBuffer).mockClear();
            vi.mocked(binding.buffer.destroy).mockImplementationOnce(() => {
                opacity.setMeshOpacity(target, 0.4);
                return undefined;
            });
            binding.disposers[0]!();
            binding.disposers[0]!();
            opacity.setMeshOpacity(target, 0.3);
            expect(binding.buffer.destroy).toHaveBeenCalledTimes(1);
            expect(fixture.device.queue.writeBuffer).not.toHaveBeenCalled();
        });

        it("immediately retires replaced-device records and initializes recovery bindings from the latest scalar", async () => {
            const target = mesh(createPbrMaterial());
            const old = bindingEngine();
            opacity.setMeshOpacity(target, 0.6);
            const stale = await bindOpacity(target, old.engine, "pbr-main");
            const replacement = bindingEngine();
            old.engine._device = replacement.device;
            vi.mocked(old.device.queue.writeBuffer).mockClear();
            opacity.setMeshOpacity(target, 1);
            opacity.setMeshOpacity(target, 0.4);
            expect(old.device.queue.writeBuffer).not.toHaveBeenCalled();
            expect(stale.buffer.destroy).toHaveBeenCalledTimes(1);
            const rebuilt = await bindOpacity(target, old.engine, "pbr-main");
            expect(replacement.writes[0]!.value).toBeCloseTo(0.4);
            stale.disposers.forEach((dispose) => dispose());
            vi.mocked(replacement.device.queue.writeBuffer).mockClear();
            opacity.setMeshOpacity(target, 0.2);
            expect(replacement.device.queue.writeBuffer).toHaveBeenCalledExactlyOnceWith(rebuilt.buffer, 0, expect.any(Float32Array));
            expect(stale.buffer.destroy).toHaveBeenCalledTimes(1);
            rebuilt.disposers.forEach((dispose) => dispose());
        });

        it.each([
            ["standard-main", "faded"],
            ["pbr-main", "faded"],
            ["standard-main", "reset-before"],
            ["pbr-main", "reset-before"],
            ["standard-main", "reset-after"],
            ["pbr-main", "reset-after"],
        ] as const)("retires lost %s records through rebuildRegisteredScenes (%s)", async (route, transition) => {
            const { rebuildRegisteredScenes } = await import("../../../packages/babylon-lite/src/engine/recovery-rebuild");
            const { registerMeshScene } = await import("../../../packages/babylon-lite/src/scene/mesh-scene-registry");
            const { _computeMeshFeatures } = await import("../../../packages/babylon-lite/src/material/mesh-features");
            const target = mesh(route === "pbr-main" ? createPbrMaterial() : createStandardMaterial());
            const old = bindingEngine();
            opacity.setMeshOpacity(target, 0.6);
            const stale = await bindOpacity(target, old.engine, route);
            const owner = Object.assign(scene(), {
                _kind: "scene",
                lights: [],
                shadowGenerators: [],
                meshes: [target],
                _renderables: [],
                _uniformUpdaters: [],
                _meshDisposables: new Map([[target, stale.disposers]]),
                _renderableVersion: 0,
                _frameGraph: { _tasks: [], build: vi.fn() },
            });
            let current: Awaited<ReturnType<typeof bindOpacity>> | undefined;
            const build = vi.fn(async () => {
                const features = _computeMeshFeatures(target);
                expect(stale.buffer.destroy).toHaveBeenCalledTimes(1);
                if (features & (1 << 22)) {
                    current = await bindOpacity(target, old.engine, route);
                    owner._meshDisposables.set(target, current.disposers);
                }
                return { rebuildSingle: vi.fn(), renderables: [] };
            });
            Object.assign(owner, { _groups: new Map([[build, [target]]]) });
            Object.assign(old.engine, { surfaces: [{ _renderingContexts: [owner] }] });
            registerMeshScene(owner, target);
            if (transition === "reset-before") {
                opacity.setMeshOpacity(target, 1);
            }
            const replacement = bindingEngine();
            old.engine._device = replacement.device;
            vi.mocked(old.device.queue.writeBuffer).mockClear();
            if (transition === "reset-after") {
                opacity.setMeshOpacity(target, 1);
                expect(stale.buffer.destroy).toHaveBeenCalledTimes(1);
            }
            await rebuildRegisteredScenes(old.engine);
            expect(build).toHaveBeenCalledOnce();
            expect(owner._frameGraph.build).toHaveBeenCalledOnce();
            stale.disposers.forEach((dispose) => dispose());
            expect(stale.buffer.destroy).toHaveBeenCalledTimes(1);
            owner._materialSwapQueue.length = 0;
            vi.mocked(replacement.device.queue.writeBuffer).mockClear();
            if (transition === "faded") {
                expect(current).toBeDefined();
                expect(replacement.device.createBuffer).toHaveBeenCalledTimes(1);
                opacity.setMeshOpacity(target, 0.2);
                expect(replacement.device.queue.writeBuffer).toHaveBeenCalledExactlyOnceWith(current!.buffer, 0, expect.any(Float32Array));
                current!.disposers.forEach((dispose) => dispose());
            } else {
                expect(current).toBeUndefined();
                expect(replacement.device.createBuffer).not.toHaveBeenCalled();
                opacity.setMeshOpacity(target, 0.5);
                expect(replacement.device.queue.writeBuffer).not.toHaveBeenCalled();
                expect(owner._materialSwapQueue).toEqual([target]);
            }
            expect(old.device.queue.writeBuffer).not.toHaveBeenCalled();
        });

        it("copies scalar state but never source binding records into a clone", async () => {
            const source = mesh();
            const fixture = bindingEngine();
            opacity.setMeshOpacity(source, 0.6);
            const sourceBinding = await bindOpacity(source, fixture.engine, "standard-main");
            const clone = cloneTransformNode(source) as Mesh;
            const cloneBinding = await bindOpacity(clone, fixture.engine, "standard-main");
            expect(cloneBinding.buffer).not.toBe(sourceBinding.buffer);
            vi.mocked(fixture.device.queue.writeBuffer).mockClear();
            opacity.setMeshOpacity(clone, 0.2);
            expect(fixture.device.queue.writeBuffer).toHaveBeenCalledExactlyOnceWith(cloneBinding.buffer, 0, expect.any(Float32Array));
            sourceBinding.disposers.forEach((dispose) => dispose());
            expect(cloneBinding.buffer.destroy).not.toHaveBeenCalled();
            cloneBinding.disposers.forEach((dispose) => dispose());
        });

        it("fails missing-disposer invariants before allocating and never registers a failed initial upload", async () => {
            const target = mesh();
            const fixture = bindingEngine();
            opacity.setMeshOpacity(target, 0.6);
            const standard = await import("../../../packages/babylon-lite/src/material/standard/standard-flags");
            const ext = standard._getStdExtsSorted().find((entry) => entry._id === "0-mesh-opacity")!;
            expect(() => ext._bind!(target.material as StandardMaterialProps, [], 2, target, { surface: { engine: fixture.engine } } as SceneContext)).toThrow(
                /Standard.*disposers/
            );
            const pbr = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
            expect(() =>
                pbr._getPbrExtsSorted().find((entry) => entry.id === "z-mesh-opacity")!.bind!(
                    { _engine: fixture.engine, _mesh: target, _material: target.material, _features: 0, _features2: 0, _meshFeatures: 0 },
                    [],
                    2
                )
            ).toThrow(/PBR.*disposers/);
            expect(fixture.device.createBuffer).not.toHaveBeenCalled();
            vi.mocked(fixture.device.queue.writeBuffer).mockImplementationOnce(() => {
                throw new Error("upload failed");
            });
            await expect(bindOpacity(target, fixture.engine, "standard-main")).rejects.toThrow("upload failed");
            const failed = vi.mocked(fixture.device.createBuffer).mock.results[0]!.value;
            expect(failed.destroy).toHaveBeenCalledTimes(1);
            vi.mocked(fixture.device.queue.writeBuffer).mockClear();
            opacity.setMeshOpacity(target, 0.4);
            expect(fixture.device.queue.writeBuffer).not.toHaveBeenCalled();
        });
    });

    it.each([
        [-3, 0],
        [-0, 0],
        [0, 0],
        [0.4, 0.4],
        [Number.MIN_VALUE, Number.MIN_VALUE],
        [1, 1],
        [1.2, 1],
        [Number.MAX_VALUE, 1],
    ])("clamps finite input %s to %s without changing material or visibility", (input, expected) => {
        const target = mesh();
        const material = target.material;
        const before = { ...material };
        opacity.setMeshOpacity(target, input);
        expect(opacity.getMeshOpacity(target)).toBe(expected);
        expect(target.material).toBe(material);
        expect(target.material).toEqual(before);
        expect(target.visible).toBe(true);
        expect(target.pickable).toBe(true);
    });

    it.each([NaN, Infinity, -Infinity, undefined, null, "0.5", true, {}])("rejects non-number/non-finite input %s before installation or mutation", async (input) => {
        const target = mesh();
        const before = Object.getOwnPropertyDescriptors(target);
        const registered = await extensions();
        expect(() => opacity.setMeshOpacity(target, input as number)).toThrow(RangeError);
        expect(opacity.getMeshOpacity(target)).toBe(1);
        expect(Object.getOwnPropertyDescriptors(target)).toEqual(before);
        expect(await extensions()).toEqual(registered);
    });

    it("preserves an existing opacity and empty scene queues after a failed assignment", async () => {
        const registry = await import("../../../packages/babylon-lite/src/scene/mesh-scene-registry");
        const target = mesh();
        const owner = scene();
        registry.registerMeshScene(owner, target);
        opacity.setMeshOpacity(target, 0.6);
        owner._materialSwapQueue.length = 0;
        expect(() => opacity.setMeshOpacity(target, NaN)).toThrow(RangeError);
        expect(opacity.getMeshOpacity(target)).toBe(0.6);
        expect(owner._materialSwapQueue).toEqual([]);
    });

    it.each(["node", "shader"] as const)("rejects %s materials atomically but permits opacity 1", async (family) => {
        const target = mesh(unsupportedMaterial(family));
        const before = Object.getOwnPropertyDescriptors(target);
        const registered = await extensions();
        expect(() => opacity.setMeshOpacity(target, 0.5)).toThrow(new RegExp(`opacity-source.*${family}.*standard.*pbr`));
        expect(Object.getOwnPropertyDescriptors(target)).toEqual(before);
        expect(await extensions()).toEqual(registered);
        expect(opacity.getMeshOpacity(target)).toBe(1);
        expect(() => opacity.setMeshOpacity(target, 1)).not.toThrow();
        expect(opacity.getMeshOpacity(target)).toBe(1);
    });

    it.each([0.5, 0, -3, 1, 2])("rejects a cast MeshLoD-shaped target at %s before any state or registry mutation", async (value) => {
        const target = Object.assign(createTransformNode("lod-instance"), {
            _asset: {},
            _material: {},
            _instanceId: 7,
            visible: true,
        });
        const before = Object.getOwnPropertyDescriptors(target);
        const registered = await extensions();
        const cast = target as unknown as Mesh;
        expect(() => opacity.setMeshOpacity(cast, value)).toThrow(/setMeshOpacity:.*lod-instance.*not a Lite Mesh.*MeshLoD/);
        expect(() => opacity.getMeshOpacity(cast)).toThrow(/getMeshOpacity:.*lod-instance.*not a Lite Mesh.*MeshLoD/);
        expect(Object.getOwnPropertyDescriptors(target)).toEqual(before);
        expect(await extensions()).toEqual(registered);
    });

    it("validates a non-finite value before the non-Mesh target error", () => {
        const target = createTransformNode("not-a-mesh") as unknown as Mesh;
        expect(() => opacity.setMeshOpacity(target, NaN)).toThrow(RangeError);
    });

    it("preserves shared Standard material alpha while assigning distinct mesh values", () => {
        const material = createStandardMaterial();
        material.alpha = 0.3;
        const before = { ...material };
        const faded = mesh(material);
        const twin = mesh(material);
        opacity.setMeshOpacity(faded, 0.5);
        expect(opacity.getMeshOpacity(faded)).toBe(0.5);
        expect(opacity.getMeshOpacity(twin)).toBe(1);
        expect(faded.material).toBe(material);
        expect(twin.material).toBe(material);
        expect(material).toEqual(before);
    });

    it("keeps loader-shaped PBR OPAQUE/MASK materials shared and unmodified", () => {
        for (const cutoff of [undefined, 0.5]) {
            const material = createPbrMaterial({
                alpha: 0.75,
                alphaBlend: false,
                _alphaCutOff: cutoff,
                baseColorFactor: [0.4, 0.6, 0.8, 1],
            });
            const before = { ...material, baseColorFactor: material.baseColorFactor!.slice() };
            const faded = mesh(material);
            const twin = mesh(material);
            opacity.setMeshOpacity(faded, 0.5);
            expect(opacity.getMeshOpacity(faded)).toBe(0.5);
            expect(opacity.getMeshOpacity(twin)).toBe(1);
            expect(faded.material).toBe(material);
            expect(twin.material).toBe(material);
            expect(material).toEqual(before);
        }
    });

    it.each(["OPAQUE", "BLEND", "MASK", "material-alpha"] as const)("initializes per-binding PBR %s policy while mesh transport contains only bit 22", async (policy) => {
        const material = createPbrMaterial({
            alphaBlend: policy === "BLEND",
            alpha: policy === "material-alpha" ? 0.6 : 1,
            _alphaCutOff: policy === "MASK" ? 0.5 : undefined,
            baseColorFactor: [0.4, 0.6, 0.8, 0.6],
        });
        const target = mesh(material);
        opacity.setMeshOpacity(target, 0.5);
        const { _computeMeshFeatures } = await import("../../../packages/babylon-lite/src/material/mesh-features");
        const { _computePbrMaterialFeatures } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-material-features");
        const { _getPbrExtsSorted, PBR_HAS_ALPHA_BLEND, PBR2_NO_COLOR_OUTPUT, PBR2_ESM_SHADOW_OUTPUT } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
        if (policy === "MASK") {
            const { setPbrAlphaCutoff } = await import("../../../packages/babylon-lite/src/material/pbr/set-alpha-cutoff");
            setPbrAlphaCutoff(material, 0.5);
        }
        material._renderFeatures = _computePbrMaterialFeatures(material);
        const features = _computeMeshFeatures(target);
        expect(features).toBe(1 << 22);
        const ext = _getPbrExtsSorted().find((entry) => entry.id === "z-mesh-opacity")!;
        for (const geometry of [false, true]) {
            const context = {
                _sceneFeatures: 0,
                _lightMode: 0,
                _features: geometry ? 0 : (features >>> 16) & PBR_HAS_ALPHA_BLEND,
                _features2: 0,
                _pi: 0,
                _meshFeatures: features,
                _uv2Mask: 0,
                _hasIbl: false,
                _hasAnyNormal: true,
                _hasSpecularAA: false,
            };
            expect(ext.frag!(context)!._fragmentSlots).toEqual(
                geometry
                    ? { BC: "alpha = select(alpha, 1.0, meshOpacity.policy > 0.5) * meshOpacity.value;" }
                    : { BC: "if (meshOpacity.policy > 0.5) { alpha = 1.0; }", FA: "finalAlpha = finalAlpha * meshOpacity.value;" }
            );
            for (const output of [PBR2_NO_COLOR_OUTPUT, PBR2_ESM_SHADOW_OUTPUT]) {
                expect(ext.frag!({ ...context, _features2: output })).toBeNull();
            }
            const fixture = bindingEngine();
            const bound = await bindOpacity(target, fixture.engine, geometry ? "pbr-geometry" : "pbr-main");
            expect(Array.from(fixture.contents.get(bound.buffer)!.slice(0, 2))).toEqual([0.5, policy === "OPAQUE" ? 1 : 0]);
            bound.disposers.forEach((dispose) => dispose());
        }
        opacity.setMeshOpacity(target, 1);
        expect(_computeMeshFeatures(target)).toBe(0);
    });

    it("follows OPAQUE → BLEND → OPAQUE → Standard material swaps through new bindings, not mesh features", async () => {
        const opaque = createPbrMaterial({ alphaBlend: false });
        const blended = createPbrMaterial({ alphaBlend: true });
        const target = mesh(opaque);
        const owner = scene();
        const { registerMeshScene } = await import("../../../packages/babylon-lite/src/scene/mesh-scene-registry");
        const { _computeMeshFeatures } = await import("../../../packages/babylon-lite/src/material/mesh-features");
        const { PBR_HAS_ALPHA_BLEND } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
        opaque._renderFeatures = { features: 0 };
        blended._renderFeatures = { features: PBR_HAS_ALPHA_BLEND };
        const fixture = bindingEngine();
        const bindings: Awaited<ReturnType<typeof bindOpacity>>[] = [];
        registerMeshScene(owner, target);
        opacity.setMeshOpacity(target, 0.5);
        for (const [material, expected] of [
            [opaque, 1],
            [blended, 0],
            [opaque, 1],
            [createStandardMaterial(), 0],
        ] as const) {
            target.material = material;
            expect(_computeMeshFeatures(target)).toBe(1 << 22);
            expect(opacity.getMeshOpacity(target)).toBe(0.5);
            expect(owner._materialSwapQueue).toEqual([target]);
            const bound = await bindOpacity(target, fixture.engine, material._buildGroup._materialFamily === "pbr" ? "pbr-main" : "standard-main");
            expect(fixture.contents.get(bound.buffer)![1]).toBe(expected);
            expect(bindings.every((previous) => previous.buffer !== bound.buffer)).toBe(true);
            bindings.push(bound);
        }
        expect(bindings.map((bound) => fixture.contents.get(bound.buffer)![1])).toEqual([1, 0, 1, 0]);
        bindings.forEach((bound) => bound.disposers.forEach((dispose) => dispose()));
    });

    it("preserves creation-time policy on reuse and writes only four opacity bytes at offset zero, including reset to 1", async () => {
        const material = createPbrMaterial();
        material._renderFeatures = { features: 0 };
        const target = mesh(material);
        const fixture = bindingEngine();
        opacity.setMeshOpacity(target, 0.5);
        const first = await bindOpacity(target, fixture.engine, "pbr-main");
        expect(Array.from(fixture.contents.get(first.buffer)!.slice(0, 2))).toEqual([0.5, 1]);
        const { PBR_HAS_ALPHA_BLEND } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
        material._renderFeatures = { features: PBR_HAS_ALPHA_BLEND };
        const reused = await bindOpacity(target, fixture.engine, "pbr-main", first.disposers);
        expect(reused.buffer).toBe(first.buffer);
        expect(first.disposers).toHaveLength(1);
        expect(fixture.device.createBuffer).toHaveBeenCalledTimes(1);
        expect(fixture.writes).toHaveLength(1);
        for (const value of [0.3, 1]) {
            opacity.setMeshOpacity(target, value);
            expect(fixture.writes.at(-1)).toMatchObject({ buffer: first.buffer, offset: 0, bytes: 4 });
            expect(fixture.contents.get(first.buffer)![0]).toBeCloseTo(value);
            expect(fixture.contents.get(first.buffer)![1]).toBe(1);
        }
        expect(fixture.writes).toHaveLength(3);
        first.disposers.forEach((dispose) => dispose());
        expect(first.buffer.destroy).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["BLEND", "OPAQUE", 0],
        ["OPAQUE", "BLEND", 1],
    ] as const)("uses a forward %s view's own flags over its %s source", async (viewPolicy, sourcePolicy, expected) => {
        const { PBR_HAS_ALPHA_BLEND } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
        const { createMaterialView } = await import("../../../packages/babylon-lite/src/material/material-view");
        const { _computeMeshFeatures } = await import("../../../packages/babylon-lite/src/material/mesh-features");
        const source = createPbrMaterial({ alphaBlend: sourcePolicy === "BLEND" });
        source._renderFeatures = { features: sourcePolicy === "BLEND" ? PBR_HAS_ALPHA_BLEND : 0, features2: 0 };
        const view = createMaterialView(source, {
            features: viewPolicy === "BLEND" ? source._renderFeatures.features | PBR_HAS_ALPHA_BLEND : source._renderFeatures.features & ~PBR_HAS_ALPHA_BLEND,
            features2: source._renderFeatures.features2,
        });
        expect(Object.hasOwn(view, "_renderFeatures")).toBe(true);
        expect(view.source).toBe(source);
        const target = mesh(source);
        opacity.setMeshOpacity(target, 0.5);
        expect((_computeMeshFeatures(target) >>> 16) & PBR_HAS_ALPHA_BLEND).toBe(PBR_HAS_ALPHA_BLEND);
        const fixture = bindingEngine();
        const own = await bindOpacity(target, fixture.engine, "pbr-main");
        const forward = await bindOpacity(target, fixture.engine, "pbr-main", [], view);
        expect(fixture.contents.get(forward.buffer)![1]).toBe(expected);
        expect(fixture.contents.get(own.buffer)![1]).toBe(sourcePolicy === "OPAQUE" ? 1 : 0);
        expect(forward.buffer).not.toBe(own.buffer);
        for (const bound of [own, forward]) {
            bound.disposers.forEach((dispose) => dispose());
        }
    });

    it("uses a geometry view's BLEND source rather than its stripped blend flags, and defaults missing source features to policy zero", async () => {
        const material = createPbrMaterial({ alphaBlend: true });
        const { PBR_HAS_ALPHA_BLEND } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
        const { createPbrGeometryMaterialView } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view");
        const { GeometryTextureType } = await import("../../../packages/babylon-lite/src/frame-graph/geometry-types");
        material._renderFeatures = { features: PBR_HAS_ALPHA_BLEND };
        const target = mesh(material);
        opacity.setMeshOpacity(target, 0.5);
        const fixture = bindingEngine();
        const view = createPbrGeometryMaterialView(material, { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false });
        expect(view._renderFeatures.features & PBR_HAS_ALPHA_BLEND).toBe(0);
        const geometry = await bindOpacity(target, fixture.engine, "pbr-geometry", [], view);
        const missing = createPbrMaterial();
        expect(missing._renderFeatures).toBeUndefined();
        const absent = await bindOpacity(target, fixture.engine, "pbr-main", [], missing);
        for (const bound of [geometry, absent]) {
            expect(fixture.contents.get(bound.buffer)![1]).toBe(0);
            bound.disposers.forEach((dispose) => dispose());
        }
    });

    it("does not make a shared opaque PBR material ineligible for a MeshLoD batch", () => {
        const material = createPbrMaterial({ alpha: 1, alphaBlend: false });
        const before = { ...material };
        opacity.setMeshOpacity(mesh(material), 0.5);
        expect(material).toEqual(before);
        expect(material.alphaBlend).toBe(false);
        expect(() => validateMeshLoDMaterial(material)).not.toThrow();
    });

    it("keeps opacity zero independent of visibility, pickability, and shadow receipt", () => {
        const target = mesh();
        opacity.setMeshOpacity(target, 0);
        expect(target.visible).toBe(true);
        expect(target.pickable).toBe(true);
        expect(target.receiveShadows).toBe(true);
        setSubtreeVisible(target, false);
        opacity.setMeshOpacity(target, 0.3);
        expect(target.visible).toBe(false);
        expect(opacity.getMeshOpacity(target)).toBe(0.3);
        setSubtreeVisible(target, true);
        expect(opacity.getMeshOpacity(target)).toBe(0.3);
    });

    it("queues each owning scene only on crossings of 1, not fractional or zero transitions", async () => {
        const registry = await import("../../../packages/babylon-lite/src/scene/mesh-scene-registry");
        const target = mesh();
        const owners = [scene(), scene()];
        for (const owner of owners) {
            registry.registerMeshScene(owner, target);
        }
        for (const [value, rebuild] of [
            [0.6, true],
            [0.4, false],
            [0, false],
            [0.3, false],
            [0.3, false],
            [1, true],
            [2, false],
        ] as const) {
            opacity.setMeshOpacity(target, value);
            for (const owner of owners) {
                expect(owner._materialSwapQueue).toEqual(rebuild ? [target] : []);
                expect(owner._meshMaterialChange).not.toHaveBeenCalled();
                owner._materialSwapQueue.length = 0;
            }
        }
        registry.unregisterMeshScene(owners[0]!, target);
        opacity.setMeshOpacity(target, 0.5);
        expect(owners[0]!._materialSwapQueue).toEqual([]);
        expect(owners[1]!._materialSwapQueue).toEqual([target]);
    });

    it("rejects a registered unsupported material swap before changing material or queue", async () => {
        const registry = await import("../../../packages/babylon-lite/src/scene/mesh-scene-registry");
        const target = mesh();
        const owner = scene();
        registry.registerMeshScene(owner, target);
        opacity.setMeshOpacity(target, 0.5);
        owner._materialSwapQueue.length = 0;
        const previous = target.material;
        expect(() => {
            target.material = unsupportedMaterial("node");
        }).toThrow(/standard.*pbr/);
        expect(target.material).toBe(previous);
        expect(owner._materialSwapQueue).toEqual([]);
        expect(owner._meshMaterialChange).not.toHaveBeenCalled();
    });

    it("accepts pending null material, then rejects an unsupported raw material at scene registration", async () => {
        const registry = await import("../../../packages/babylon-lite/src/scene/mesh-scene-registry");
        const target = mesh(null as unknown as Mesh["material"]);
        opacity.setMeshOpacity(target, 0.5);
        target.material = unsupportedMaterial("shader");
        const owner = scene();
        expect(() => registry.registerMeshScene(owner, target)).toThrow(/standard.*pbr/);
        expect(registry._getMeshScenes(target)).toBeUndefined();
        expect(owner._materialSwapQueue).toEqual([]);
        expect(opacity.getMeshOpacity(target)).toBe(0.5);
    });

    it.each(["before", "after"] as const)("preserves an existing material validator installed %s opacity", async (order) => {
        const registry = await import("../../../packages/babylon-lite/src/scene/mesh-scene-registry");
        const previous = vi.fn();
        const target = mesh();
        if (order === "before") {
            registry._installMeshMaterialValidator(previous);
        }
        opacity.setMeshOpacity(target, 0.5);
        if (order === "after") {
            registry._installMeshMaterialValidator(previous);
        }
        const owner = scene();
        registry.registerMeshScene(owner, target);
        expect(previous).toHaveBeenCalledExactlyOnceWith(target, target.material);
        previous.mockClear();
        const unsupported = unsupportedMaterial("shader");
        expect(() => {
            target.material = unsupported;
        }).toThrow(/standard.*pbr/);
        if (order === "before") {
            expect(previous).toHaveBeenCalledExactlyOnceWith(target, unsupported);
        } else {
            // Previous-first chaining short-circuits after the earlier validator throws.
            expect(previous).not.toHaveBeenCalled();
        }
        expect(owner._materialSwapQueue).toEqual([]);
        previous.mockClear();
        const supported = createStandardMaterial();
        target.material = supported;
        expect(previous).toHaveBeenCalledExactlyOnceWith(target, supported);
        expect(owner._materialSwapQueue).toEqual([target]);
    });

    it.each(["before", "after"] as const)("preserves the real indexed-indirect borrow validator installed %s opacity", async (order) => {
        const registry = await import("../../../packages/babylon-lite/src/scene/mesh-scene-registry");
        const { setMeshIndexedIndirect } = await import("../../../packages/babylon-lite/src/mesh/mesh-indexed-indirect-borrow");
        const { createStorageBuffer, disposeStorageBuffer } = await import("../../../packages/babylon-lite/src/resource/storage-buffer");
        const fixture = bindingEngine();
        Object.assign(fixture.device, { limits: { maxBufferSize: 1 << 24 } });
        const vertices = createStorageBuffer(fixture.engine, 48, { vertex: true });
        const argumentsBuffer = createStorageBuffer(fixture.engine, 20, { writable: true, indirect: true });
        const borrowed = mesh(unsupportedMaterial("shader"));
        Object.assign(borrowed._gpu, { _ownsVertexBuffers: false, positionBuffer: vertices._buffer });
        const faded = mesh();
        if (order === "before") {
            setMeshIndexedIndirect(borrowed, argumentsBuffer);
        }
        opacity.setMeshOpacity(faded, 0.5);
        if (order === "after") {
            setMeshIndexedIndirect(borrowed, argumentsBuffer);
        }
        const owner = Object.assign(scene(), { _meshDisposables: new Map(), _renderableVersion: 0 });
        registry.registerMeshScene(owner, borrowed);
        registry.registerMeshScene(owner, faded);
        const borrowedMaterial = borrowed.material;
        const fadedMaterial = faded.material;
        expect(() => {
            borrowed.material = createStandardMaterial();
        }).toThrow(/unbind arguments/);
        expect(() => {
            faded.material = unsupportedMaterial("shader");
        }).toThrow(/standard.*pbr/);
        expect(borrowed.material).toBe(borrowedMaterial);
        expect(faded.material).toBe(fadedMaterial);
        expect(owner._materialSwapQueue).toEqual([]);
        setMeshIndexedIndirect(borrowed, null);
        disposeStorageBuffer(argumentsBuffer);
        disposeStorageBuffer(vertices);
    });

    it("copies native opacity through the real clone path without coupling later assignments", () => {
        const source = mesh();
        opacity.setMeshOpacity(source, 0.6);
        const clone = cloneTransformNode(source) as Mesh;
        expect(opacity.getMeshOpacity(clone)).toBe(0.6);
        expect(clone.material).toBe(source.material);
        opacity.setMeshOpacity(clone, 0.2);
        expect(opacity.getMeshOpacity(source)).toBe(0.6);
        expect(opacity.getMeshOpacity(clone)).toBe(0.2);
        disposeMeshGpu(source);
        expect(() => opacity.setMeshOpacity(source, 1)).toThrow(/opacity-source.*disposed/);
        expect(opacity.getMeshOpacity(source)).toBe(0.6);
        expect(() => opacity.setMeshOpacity(clone, 0.4)).not.toThrow();
        expect(source._gpu.positionBuffer.destroy).not.toHaveBeenCalled();
        disposeMeshGpu(clone);
    });

    it("rejects a disposed real Mesh with the disposed error, not the MeshLoD error", async () => {
        const target = mesh();
        disposeMeshGpu(target);
        const before = Object.getOwnPropertyDescriptors(target);
        const registered = await extensions();
        for (const value of [0, 0.5, 1]) {
            expect(() => opacity.setMeshOpacity(target, value)).toThrow(/opacity-source.*disposed/);
            expect(Object.getOwnPropertyDescriptors(target)).toEqual(before);
        }
        expect(await extensions()).toEqual(registered);
        expect(opacity.getMeshOpacity(target)).toBe(1);
    });
});
