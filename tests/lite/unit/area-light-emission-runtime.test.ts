import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import type { Material } from "../../../packages/babylon-lite/src/material/material.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { addToScene, createSceneContext, disposeScene, registerScene } from "../../../packages/babylon-lite/src/scene/scene.js";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node.js";
import { createRectAreaLight } from "../../../packages/babylon-lite/src/light/rect-area-light.js";
import { createPointLight } from "../../../packages/babylon-lite/src/light/point-light.js";
import { enableRectAreaLights, _installRectAreaEmission } from "../../../packages/babylon-lite/src/light/enable-rect-area-lights.js";
import { prepareEmissionLighting } from "../../../packages/babylon-lite/src/light/process-area-light-texture.js";
import { prepareAreaLightEmission, clearAreaLightEmission, bindAreaLightEmission } from "../../../packages/babylon-lite/src/light/area-light-emission.js";
import { MAX_LIGHTS, setMaxLights } from "../../../packages/babylon-lite/src/light/types.js";
import { acquireTexture } from "../../../packages/babylon-lite/src/resource/texture-acquire.js";
import { releaseTexture } from "../../../packages/babylon-lite/src/resource/texture-release.js";
import { _textureOwners } from "../../../packages/babylon-lite/src/resource/texture-owner-state.js";
import { cloneTexture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import { writeMeshLightSelection } from "../../../packages/babylon-lite/src/render/mesh-light-selection.js";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable.js";
import { createPbrGeometryMaterialView } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view.js";
import { buildPbrGeometryRenderable } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-renderable.js";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material.js";
import { buildStandardMeshRenderables } from "../../../packages/babylon-lite/src/material/standard/standard-renderable.js";
import { createStandardGeometryMaterialView } from "../../../packages/babylon-lite/src/material/standard/geometry-view.js";
import { buildStandardGeometryRenderable } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-renderable.js";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types.js";
import { rebuildSceneRenderables } from "../../../packages/babylon-lite/src/scene/scene-rebuild.js";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";

const originalCapacity = MAX_LIGHTS;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture() {
    const copies = vi.fn();
    const device = {
        limits: { maxTextureArrayLayers: 256 },
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            const size = descriptor.size as number[] | GPUExtent3DDict;
            const width = Array.isArray(size) ? size[0]! : size.width;
            const height = Array.isArray(size) ? size[1]! : (size.height ?? 1);
            const layers = Array.isArray(size) ? (size[2] ?? 1) : (size.depthOrArrayLayers ?? 1);
            return {
                width,
                height,
                depthOrArrayLayers: layers,
                dimension: descriptor.dimension ?? "2d",
                sampleCount: descriptor.sampleCount ?? 1,
                format: descriptor.format,
                mipLevelCount: descriptor.mipLevelCount ?? 1,
                usage: descriptor.usage,
                label: descriptor.label,
                createView: vi.fn((options?: GPUTextureViewDescriptor) => ({ label: descriptor.label, options })),
                destroy: vi.fn(),
            };
        }),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const data = new ArrayBuffer(Number(descriptor.size));
            return { size: Number(descriptor.size), label: descriptor.label, destroy: vi.fn(), getMappedRange: vi.fn(() => data), unmap: vi.fn() };
        }),
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => ({ descriptor })),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor),
        createCommandEncoder: vi.fn(() => ({ copyTextureToTexture: copies, finish: vi.fn() })),
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(async (): Promise<GPUError | null> => null),
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn(), submit: vi.fn() },
    };
    const engine = { _device: device, _renderingContexts: [], _disposables: [], format: "rgba8unorm", msaaSamples: 1 } as unknown as EngineContext;
    Object.assign(engine, { engine });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    const image = (): Texture2D => {
        const texture = device.createTexture({ size: [1024, 1024], format: "rgba8unorm", mipLevelCount: 11, usage: 7 });
        const result = {
            texture,
            view: texture.createView(),
            sampler: {},
            width: 1024,
            height: 1024,
            _areaLightImage: { device: engine._device, texture },
        } as unknown as Texture2D;
        acquireTexture(result);
        _installRectAreaEmission(prepareEmissionLighting);
        return result;
    };
    const slots = (): number[] => {
        const call = device.queue.writeBuffer.mock.calls
            .slice()
            .reverse()
            .find((args) => args[2] instanceof Uint32Array);
        return Array.from(call![2] as Uint32Array);
    };
    return { engine, scene, device, copies, image, slots };
}

function receiver(material: Material, id: string): Mesh {
    const _gpu = { positionBuffer: { destroy: vi.fn() }, normalBuffer: { destroy: vi.fn() }, uvBuffer: { destroy: vi.fn() }, indexBuffer: { destroy: vi.fn() } };
    return Object.assign(createTransformNode(id), { id, material, receiveShadows: false, morphTargets: null, _gpu }) as unknown as Mesh;
}

afterEach(() => {
    setMaxLights(originalCapacity);
    vi.unstubAllGlobals();
});

describe("scene-local compact emission image mapping and ownership", () => {
    it("maps solid/punctual/shared/distinct images by packed slot, never by position or receiver order", async () => {
        const { scene, engine, device, copies, image, slots } = fixture();
        const one = image();
        const two = image();
        const solid = createRectAreaLight([0, 0, 1], 2, 2);
        const a = createRectAreaLight([0, 0, 1], 2, 2);
        const b = createRectAreaLight([0, 0, 1], 2, 2);
        a.emissionTexture = one;
        b.emissionTexture = two;
        const clone = a._cloneNode!();
        clone.emissionTexture = cloneTexture2D(one, { uScale: 2 });
        b.includedOnlyMeshIds = new Set(["other"]);
        scene.lights.push(createPointLight([0, 0, 1]), solid, a, b, clone);
        const id = await prepareAreaLightEmission(scene);
        expect(slots().slice(0, 5)).toEqual([0, 0, 1, 2, 1]);
        const packed = new Float32Array(20 + MAX_LIGHTS);
        expect(writeMeshLightSelection(receiver(createStandardMaterial(), "receiver"), scene.lights, packed)).toBe(-4);
        expect(Array.from(new Uint32Array(packed.buffer).slice(20, 24))).toEqual([0, 1, 2, 4]);
        expect(copies).toHaveBeenCalledTimes(22);
        expect(copies.mock.calls[0]![0]).toMatchObject({ texture: one.texture, mipLevel: 0 });
        expect(copies.mock.calls[11]![0]).toMatchObject({ texture: two.texture, mipLevel: 0 });
        expect(copies.mock.calls[21]![2]).toEqual([1, 1, 1]);
        const allocation = device.createTexture.mock.results.at(-1)!.value;
        expect(allocation.depthOrArrayLayers).toBe(2);
        const disposers: (() => void)[] = [];
        const entries: GPUBindGroupEntry[] = [];
        expect(bindAreaLightEmission(id, engine._device, entries, 10, disposers)).toBe(13);
        bindAreaLightEmission(id, engine._device, [], 0, disposers);
        expect(disposers).toHaveLength(1);
        expect(entries.map((entry) => entry.binding)).toEqual([10, 11, 12]);
        releaseTexture(one);
        releaseTexture(two);
        disposeScene(scene);
        expect(allocation.destroy).not.toHaveBeenCalled();
        expect(() => bindAreaLightEmission(id, engine._device, [], 0, [])).toThrow(/owning scene/);
        disposers.forEach((dispose) => dispose());
        expect(allocation.destroy).toHaveBeenCalledTimes(1);
        expect(_textureOwners(one)).toBe(0);
        expect(_textureOwners(two)).toBe(0);
    });

    it("resnapshots reordered slots, isolates scenes, and keeps old bindings valid through clear/rebind", async () => {
        const f = fixture();
        const one = f.image();
        const two = f.image();
        const a = createRectAreaLight([0, 0, 1], 1, 1);
        const b = a._cloneNode!();
        a.emissionTexture = one;
        b.emissionTexture = two;
        f.scene.lights.push(a, b);
        const firstId = await prepareAreaLightEmission(f.scene);
        const other = createSceneContext(f.engine, { defaultRenderTask: false });
        other.lights.push(b, a);
        const secondId = await prepareAreaLightEmission(other);
        expect(secondId).not.toBe(firstId);
        const firstDisposers: (() => void)[] = [];
        const entries: GPUBindGroupEntry[] = [];
        bindAreaLightEmission(firstId, f.engine._device, entries, 0, firstDisposers);
        const initial = f.device.createTexture.mock.results.at(-2)!.value;
        const secondEntries: GPUBindGroupEntry[] = [];
        const secondDisposers: (() => void)[] = [];
        bindAreaLightEmission(secondId, f.engine._device, secondEntries, 0, secondDisposers);
        expect(entries[0]!.resource).not.toBe(secondEntries[0]!.resource);
        f.scene.lights.splice(0, 2, b, a);
        await prepareAreaLightEmission(f.scene);
        expect(f.copies.mock.calls.at(-22)![0]).toMatchObject({ texture: two.texture });
        expect(initial.destroy).not.toHaveBeenCalled();
        a.emissionTexture = null;
        await prepareAreaLightEmission(f.scene);
        expect(f.slots().slice(0, 2)).toEqual([1, 0]);
        b.emissionTexture = null;
        await prepareAreaLightEmission(f.scene);
        expect(() => bindAreaLightEmission(firstId, f.engine._device, [], 0, [])).toThrow(/prepare/);
        firstDisposers.forEach((dispose) => dispose());
        expect(initial.destroy).toHaveBeenCalledTimes(1);
        disposeScene(f.scene);
        disposeScene(other);
        secondDisposers.forEach((dispose) => dispose());
        expect(_textureOwners(one)).toBe(1);
        expect(_textureOwners(two)).toBe(1);
        releaseTexture(one);
        releaseTexture(two);
    });

    it("caps writers at MAX_LIGHTS, omits writerless maps, and doesn't allocate for unused maps", async () => {
        const f = fixture();
        const beyond = createRectAreaLight([0, 0, 1], 1, 1);
        beyond.emissionTexture = f.image();
        const writerless = beyond._cloneNode!();
        Object.defineProperty(writerless, "_writeLightUbo", { value: undefined });
        f.scene.lights.push(writerless, ...Array.from({ length: MAX_LIGHTS }, () => createPointLight([0, 0, 0])), beyond);
        f.device.createTexture.mockClear();
        await prepareAreaLightEmission(f.scene);
        expect(f.device.createTexture).not.toHaveBeenCalled();
        expect(_textureOwners(beyond.emissionTexture)).toBe(1);
        disposeScene(f.scene);
        releaseTexture(beyond.emissionTexture);
    });

    it("invalidates unchanged packed lists on capacity growth/shrink, including equal padded sizes, without retiring bound generations", async () => {
        setMaxLights(16);
        const f = fixture();
        const image = f.image();
        const light = createRectAreaLight([0, 0, 1], 1, 1);
        light.emissionTexture = image;
        f.scene.lights.push(light);
        try {
            const id = await prepareAreaLightEmission(f.scene);
            let disposers: (() => void)[] = [];
            let entries: GPUBindGroupEntry[] = [];
            bindAreaLightEmission(id, f.engine._device, entries, 0, disposers);
            for (const capacity of [32, 20, 19, 16]) {
                const previousTexture = f.device.createTexture.mock.results.at(-1)!.value;
                const previousMapping = (entries[2]!.resource as GPUBufferBinding).buffer;
                setMaxLights(capacity);
                expect(await prepareAreaLightEmission(f.scene)).toBe(id);
                const nextEntries: GPUBindGroupEntry[] = [];
                const nextDisposers: (() => void)[] = [];
                bindAreaLightEmission(id, f.engine._device, nextEntries, 0, nextDisposers);
                const nextMapping = (nextEntries[2]!.resource as GPUBufferBinding).buffer;
                expect(nextMapping).not.toBe(previousMapping);
                expect(nextMapping.size).toBe(Math.ceil(capacity / 4) * 16);
                expect(f.slots()).toEqual([1, ...Array<number>(Math.ceil(capacity / 4) * 4 - 1).fill(0)]);
                expect(previousTexture.destroy).not.toHaveBeenCalled();
                expect(previousMapping.destroy).not.toHaveBeenCalled();
                expect(_textureOwners(image)).toBe(3);
                disposers.forEach((dispose) => dispose());
                expect(previousTexture.destroy).toHaveBeenCalledTimes(1);
                expect(previousMapping.destroy).toHaveBeenCalledTimes(1);
                expect(_textureOwners(image)).toBe(2);
                entries = nextEntries;
                disposers = nextDisposers;
            }
            const finalMapping = (entries[2]!.resource as GPUBufferBinding).buffer;
            disposeScene(f.scene);
            expect(finalMapping.destroy).not.toHaveBeenCalled();
            disposers.forEach((dispose) => dispose());
            expect(finalMapping.destroy).toHaveBeenCalledTimes(1);
            expect(_textureOwners(image)).toBe(1);
        } finally {
            disposeScene(f.scene);
            releaseTexture(image);
        }
    });

    it("rejects binding an allocation prepared at a different capacity before acquiring a binding owner", async () => {
        setMaxLights(16);
        const f = fixture();
        const image = f.image();
        const light = createRectAreaLight([0, 0, 1], 1, 1);
        light.emissionTexture = image;
        f.scene.lights.push(light);
        try {
            const id = await prepareAreaLightEmission(f.scene);
            const entries: GPUBindGroupEntry[] = [];
            const disposers: (() => void)[] = [];
            setMaxLights(20);
            expect(() => bindAreaLightEmission(id, f.engine._device, entries, 0, disposers)).toThrow(/capacity.*enable.*rebuild/);
            expect(entries).toHaveLength(0);
            expect(disposers).toHaveLength(0);
            setMaxLights(16);
            expect(bindAreaLightEmission(id, f.engine._device, entries, 0, disposers)).toBe(3);
            disposeScene(f.scene);
            disposers.forEach((dispose) => dispose());
            expect(_textureOwners(image)).toBe(1);
        } finally {
            disposeScene(f.scene);
            releaseTexture(image);
        }
    });

    it("tracks texture assignment/clear once, shares cloned light images without ownership, and leaves light state scene-free", () => {
        const f = fixture();
        const texture = f.image();
        const light = createRectAreaLight([0, 0, 0], 1, 1);
        const version = light._lightVersion;
        light.emissionTexture = texture;
        light.emissionTexture = texture;
        expect(light._lightVersion).toBe(version + 1);
        const clone = light._cloneNode!();
        expect(clone.emissionTexture).toBe(texture);
        expect(_textureOwners(texture)).toBe(1);
        light.emissionTexture = null;
        expect(light._lightVersion).toBe(version + 2);
        expect(clone.emissionTexture).toBe(texture);
        expect(Object.keys(clone)).not.toContain("scene");
        releaseTexture(texture);
        disposeScene(f.scene);
    });

    it.each(["validation", "disposed", "device", "topology", "capacity-growth", "capacity-shrink"] as const)(
        "rejects %s during awaited upload, cleans all candidates, and doesn't retain pending work",
        async (failure) => {
            const f = fixture();
            const texture = f.image();
            const light = createRectAreaLight([0, 0, 1], 1, 1);
            light.emissionTexture = texture;
            f.scene.lights.push(light);
            const wait = deferred<GPUError | null>();
            f.device.popErrorScope.mockReturnValueOnce(wait.promise);
            const work = prepareAreaLightEmission(f.scene);
            const rejected = expect(work).rejects.toThrow(
                failure === "validation" ? /array upload failed/ : failure === "device" ? /device changed/ : failure === "disposed" ? /disposed/ : /changed during preparation/
            );
            if (failure === "disposed") {
                disposeScene(f.scene);
            } else if (failure === "device") {
                f.engine._device = fixture().engine._device;
            } else if (failure === "topology") {
                light.emissionTexture = null;
            } else if (failure === "capacity-growth" || failure === "capacity-shrink") {
                setMaxLights(failure === "capacity-growth" ? 32 : 12);
            }
            wait.resolve(failure === "validation" ? ({ message: "bad array" } as GPUError) : null);
            await rejected;
            const candidate = f.device.createTexture.mock.results.at(-1)!.value;
            expect(candidate.destroy).toHaveBeenCalledTimes(1);
            expect(f.device.createBuffer.mock.results.at(-1)!.value.destroy).toHaveBeenCalledTimes(1);
            expect(_textureOwners(texture)).toBe(1);
            if (failure === "validation" || failure === "capacity-growth" || failure === "capacity-shrink") {
                await expect(prepareAreaLightEmission(f.scene)).resolves.toBeTypeOf("number");
                expect(f.slots()).toHaveLength(Math.ceil(MAX_LIGHTS / 4) * 4);
                expect(f.slots()[0]).toBe(1);
            }
            disposeScene(f.scene);
            releaseTexture(texture);
        }
    );

    it("rejects invalid provenance and wrong devices before copying, and rejects a disposed first owner without registering a disposer", async () => {
        const f = fixture();
        const texture = f.image();
        const light = createRectAreaLight([0, 0, 1], 1, 1);
        light.emissionTexture = texture;
        f.scene.lights.push(light);
        texture._areaLightImage = undefined;
        await expect(prepareAreaLightEmission(f.scene)).rejects.toThrow(/processAreaLightTexture/);
        texture._areaLightImage = { texture: texture.texture, device: fixture().engine._device };
        await expect(prepareAreaLightEmission(f.scene)).rejects.toThrow(/different device/);
        expect(f.copies).not.toHaveBeenCalled();
        disposeScene(f.scene);
        const count = f.scene._disposables.length;
        await expect(prepareAreaLightEmission(f.scene)).rejects.toThrow(/disposed/);
        expect(f.scene._disposables).toHaveLength(count);
        releaseTexture(texture);
    });
});

describe("textured area bindings through real material builders", () => {
    it.each([20, 32])("pairs Standard and mixed PBR shaders/bindings after initial preparation at 16 then growth to %i before first compilation", async (capacity) => {
        setMaxLights(16);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new ArrayBuffer(65536)))
        );
        const f = fixture();
        const image = f.image();
        const emitter = createRectAreaLight([0, 0, 1], 2, 2);
        emitter.emissionTexture = image;
        addToScene(f.scene, emitter);
        try {
            await enableRectAreaLights(f.scene);
            expect(f.slots()).toEqual([1, ...Array<number>(15).fill(0)]);
            expect(f.device.createShaderModule).not.toHaveBeenCalled();
            expect(f.device.createRenderPipeline).not.toHaveBeenCalled();
            setMaxLights(capacity);
            f.scene.lights.unshift(...Array.from({ length: 16 }, () => createPointLight([0, 0, 1])));
            const standard = receiver(createStandardMaterial(), "standard");
            const pbr = receiver(createPbrMaterial(), "mixed-pbr");
            addToScene(f.scene, standard);
            addToScene(f.scene, pbr);
            await registerScene(f.scene);
            expect(f.scene._renderables).toHaveLength(2);
            for (const renderable of f.scene._renderables) {
                renderable.bind(f.engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 });
            }
            const shaders = f.device.createShaderModule.mock.calls.map(([descriptor]) => descriptor.code).filter((code) => code.includes("@fragment"));
            expect(shaders).toHaveLength(2);
            for (const code of shaders) {
                const declaredVectors = code.match(/struct areaEmissionSlotsUniforms\s*\{\s*slots:\s*array<vec4<u32>,\s*(\d+)>/);
                expect(Number(declaredVectors?.[1])).toBe(Math.ceil(capacity / 4));
                expect(code).toMatch(new RegExp(`lights:\\s*array<LightEntry,\\s*${capacity}>`));
                expect(code).toContain("areaEmissionSlots.slots[lightIndex / 4u][lightIndex % 4u]");
            }
            expect(shaders.some((code) => code.includes("let lightIndex = mli(li)"))).toBe(true);
            expect(shaders.some((code) => code.includes("input.vp, lightIndex)"))).toBe(true);
            const slots = f.slots();
            expect(slots).toHaveLength(Math.ceil(capacity / 4) * 4);
            expect(slots[16]).toBe(1);
            expect(slots.filter(Boolean)).toEqual([1]);
            for (const mesh of [standard, pbr]) {
                const selection = new Float32Array(20 + capacity);
                expect(writeMeshLightSelection(mesh, f.scene.lights, selection)).toBe(-17);
                expect(Array.from(new Uint32Array(selection.buffer).slice(20, 37))).toEqual(Array.from({ length: 17 }, (_, i) => i));
            }
            const mapping = f.device.createBuffer.mock.results.map((result) => result.value).filter((buffer) => buffer.label === "rect-area-emission-slots");
            expect(mapping.map((buffer) => buffer.size)).toEqual([64, Math.ceil(capacity / 4) * 16]);
            const upload = f.device.queue.writeBuffer.mock.calls.find(([buffer]) => buffer === mapping[1]);
            expect(upload![2]).toEqual(new Uint32Array(slots));
            expect((upload![2] as Uint32Array).byteLength).toBe(mapping[1]!.size);
            const emissionGroups = f.device.createBindGroup.mock.calls
                .map(([descriptor]) => Array.from(descriptor.entries))
                .filter((entries) => (entries.at(-1)?.resource as GPUBufferBinding).buffer === mapping[1]);
            expect(emissionGroups.map((entries) => entries.length).sort((a, b) => a - b)).toEqual([9, 13]);
            expect(f.copies).toHaveBeenCalledTimes(22);
        } finally {
            disposeScene(f.scene);
            releaseTexture(image);
        }
    });

    it("public full-scene rebuild synchronizes Standard and PBR groups through textured/solid/replace transitions", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new ArrayBuffer(65536)))
        );
        const f = fixture();
        const a = f.image();
        const b = f.image();
        const light = createRectAreaLight([0, 0, 1], 2, 2);
        f.scene.lights.push(light);
        const standard = receiver(createStandardMaterial(), "standard");
        const pbr = receiver(createPbrMaterial(), "pbr");
        f.scene.meshes.push(standard, pbr);
        f.scene._groups.set(standard.material!._buildGroup, [standard]);
        f.scene._groups.set(pbr.material!._buildGroup, [pbr]);
        f.scene._built = true;
        await enableRectAreaLights(f.scene);
        await rebuildSceneRenderables(f.scene);
        expect(f.scene._renderables).toHaveLength(2);
        light.emissionTexture = a;
        await enableRectAreaLights(f.scene);
        await rebuildSceneRenderables(f.scene);
        expect(f.scene._renderables).toHaveLength(2);
        expect(_textureOwners(a)).toBe(2);
        const firstAllocation = f.device.createTexture.mock.results.map((result) => result.value).find((texture) => texture.label === "rect-area-emission-array")!;
        light.emissionTexture = b;
        await enableRectAreaLights(f.scene);
        expect(firstAllocation.destroy).not.toHaveBeenCalled();
        await rebuildSceneRenderables(f.scene);
        disposeGpuResourceRetirements(f.engine);
        expect(firstAllocation.destroy).toHaveBeenCalledTimes(1);
        expect(_textureOwners(a)).toBe(1);
        expect(_textureOwners(b)).toBe(2);
        light.emissionTexture = null;
        await enableRectAreaLights(f.scene);
        await rebuildSceneRenderables(f.scene);
        disposeGpuResourceRetirements(f.engine);
        expect(_textureOwners(b)).toBe(1);
        expect(f.scene._renderables).toHaveLength(2);
        disposeScene(f.scene);
        releaseTexture(a);
        releaseTexture(b);
    });
    it.each(["standard", "pbr"] as const)("preserves selected slot IDs and emission bindings in %s forward, geometry and solid rebuilds", async (family) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new ArrayBuffer(65536)))
        );
        const f = fixture();
        const one = f.image();
        const two = f.image();
        const a = createRectAreaLight([0, 0, 1], 2, 2);
        const b = a._cloneNode!();
        a.emissionTexture = one;
        b.emissionTexture = two;
        a.excludedMeshIds = new Set(["single"]);
        const solid = a._cloneNode!();
        solid.emissionTexture = null;
        solid.excludedMeshIds = new Set(["single"]);
        f.scene.lights.push(createPointLight([0, 0, 1]), solid, a, b);
        f.scene.lights[0]!.excludedMeshIds = new Set(["single"]);
        await enableRectAreaLights(f.scene);
        const mat = family === "pbr" ? createPbrMaterial() : createStandardMaterial();
        if (family === "pbr") {
            Object.assign(mat, { metallicFactor: 0.8, roughnessFactor: 0.6 });
        } else {
            Object.assign(mat, { roughness: 0.6 });
        }
        const single = receiver(mat, "single");
        const mixed = receiver(mat, "mixed");
        f.scene._groups.set(mat._buildGroup, [single, mixed]);
        const build = async (): Promise<void> => {
            if (family === "pbr") {
                await buildPbrRenderables(f.scene, [single, mixed], undefined);
            } else {
                buildStandardMeshRenderables(f.scene, [single, mixed], { sceneShader: f.scene._lighting!._standard!(null) });
            }
        };
        await build();
        const resources = { _lifetimeDisposers: [] as (() => void)[] };
        if (family === "pbr") {
            const view = createPbrGeometryMaterialView(mat as ReturnType<typeof createPbrMaterial>, { attachments: [GeometryTextureType.WORLD_NORMAL], emitColor: true });
            buildPbrGeometryRenderable(f.scene, single, view, resources);
        } else {
            const view = createStandardGeometryMaterialView(mat as ReturnType<typeof createStandardMaterial>, { attachments: [GeometryTextureType.WORLD_NORMAL], emitColor: true });
            buildStandardGeometryRenderable(f.scene, single, view, resources);
        }
        const shaders = f.device.createShaderModule.mock.calls.map(([desc]) => desc.code).filter((code) => code.includes("@fragment"));
        expect(shaders.some((code) => code.includes("areaEmissionSlots.slots[lightIndex / 4u][lightIndex % 4u]"))).toBe(true);
        if (family === "pbr") {
            expect(shaders.some((code) => code.includes("let lightIndex = mli(0u)"))).toBe(true);
        } else {
            expect(shaders.some((code) => code.includes("input.vp, lightIndex)"))).toBe(true);
        }
        expect(shaders.some((code) => code.includes("var areaEmission:texture_2d_array<f32>"))).toBe(true);
        expect(shaders.some((code) => code.includes("areaEmissionForm(inverseLtc * basis,p0,p1,p2,p3, lightIndex)"))).toBe(true);
        const group = f.device.createBindGroup.mock.calls.at(-1)![0];
        expect(Array.from(group.entries)).toHaveLength(family === "pbr" ? 13 : 9);
        const oldOwners = resources._lifetimeDisposers.slice();
        a.emissionTexture = b.emissionTexture = null;
        clearAreaLightEmission(f.scene);
        await enableRectAreaLights(f.scene);
        f.device.createShaderModule.mockClear();
        await build();
        expect(f.device.createShaderModule.mock.calls.every(([desc]) => !desc.code.includes("areaEmissionForm"))).toBe(true);
        oldOwners.forEach((dispose) => dispose());
        for (const disposers of f.scene._meshDisposables.values()) {
            disposers.forEach((dispose) => dispose());
        }
        disposeScene(f.scene);
        releaseTexture(one);
        releaseTexture(two);
    });
});
