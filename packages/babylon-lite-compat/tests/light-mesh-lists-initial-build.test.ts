import { describe, expect, it, vi } from "vitest";
import { addToScene, createPbrMaterial, createPointLight, createSceneContext, createStandardMaterial, createTransformNode, registerScene } from "babylon-lite";
import type { EngineContext, Mesh as LiteMesh, SceneContext } from "babylon-lite";
import { DirectionalLight } from "../src/lights/lights";
import type { AbstractMesh } from "../src/meshes/meshes";
import { Mesh } from "../src/meshes/meshes";
import { Vector3 } from "../src/math/vector";
import type { Scene } from "../src/scene/scene";

function mockEngine(): EngineContext {
    const device = {
        createBuffer: vi.fn(() => ({ destroy: vi.fn(), getMappedRange: vi.fn(() => new ArrayBuffer(4096)), unmap: vi.fn() })),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => ({ code: descriptor.code })),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor),
        createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn((index: number) => ({ index })) })),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor),
        createSampler: vi.fn(() => ({})),
        createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(async () => null),
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
    } as unknown as GPUDevice;
    const engine = {
        canvas: { width: 800, height: 600 },
        msaaSamples: 4,
        maxDevicePixelRatio: Infinity,
        _device: device,
        _context: {},
        format: "bgra8unorm",
        _alphaMode: "opaque",
        _renderingContexts: [],
        _currentEncoder: {},
        scRT: {
            _colorView: {},
            _colorTexture: {},
            _depthTexture: null,
            _depthView: null,
            _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 800, height: 600 } },
            _width: 0,
            _height: 0,
            _eager: true,
        },
        _cbs: [],
        _disposables: [],
    } as unknown as EngineContext;
    Object.assign(engine, { engine, surfaces: [engine], _surfaces: [engine] });
    return engine;
}

/** `_buildGroup` is per material family, so a second group means a second family. */
function liteMesh(id: string, material: object): LiteMesh {
    return Object.assign(createTransformNode(id), { id, material, receiveShadows: false, morphTargets: null, _gpu: {} }) as unknown as LiteMesh;
}

/** The light mode the group baked for this mesh: 0 lights, one light, or the multi-light path. */
function bakedLightMode(scene: SceneContext, id: string): number | undefined {
    const renderable = scene._renderables.find((candidate) => (candidate as unknown as { mesh?: { id?: string } }).mesh?.id === id);
    return (renderable as unknown as { _gen?: unknown[] } | undefined)?._gen?.[2] as number | undefined;
}

type LateWork = () => Promise<void>;

/** The initial builders run under one `Promise.all`, and a real PBR build awaits its WGSL imports. */
async function until(condition: () => boolean): Promise<void> {
    for (let tick = 0; tick < 200 && !condition(); tick++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

describe("a mesh-list edit made during the scene's initial build", () => {
    it("reaches a material group that was already built when the edit landed", async () => {
        const engine = mockEngine();
        const lite = createSceneContext(engine, { defaultRenderTask: false });
        const lateWork: LateWork[] = [];
        // The compat Scene is the only stand-in: the light reads `_lite`, the started flag and the
        // engine's late-work queue from it. The scene, its groups, the build and the rebuild are real.
        const scene = {
            _hasStarted: true,
            _lite: lite,
            _registerLight: vi.fn(),
            _unregisterNode: vi.fn(),
            getEngine: () => ({ _registerLateWork: (work: LateWork) => lateWork.push(work) }),
        } as unknown as Scene;

        const light = new DirectionalLight("sun", new Vector3(0, -1, 0), scene);
        lite.lights.push(createPointLight([0, 3, 0]));

        const floor = liteMesh("floor", createPbrMaterial());
        const box = liteMesh("box", createStandardMaterial());
        addToScene(lite, floor);
        addToScene(lite, box);

        // Hold the second group's builder open, so the first group is fully built while the scene is
        // still unbuilt — the window `_hasStarted` is already true in.
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const second = lite._deferredBuilders[1]!;
        lite._deferredBuilders[1] = async () => {
            await gate;
            await second();
        };

        const registration = registerScene(lite);
        await until(() => bakedLightMode(lite, "floor") !== undefined);

        expect(lite._built).toBe(false);
        // Two lights reach the floor, so its group baked the multi-light permutation.
        expect(bakedLightMode(lite, "floor")).toBe(2);

        // The edit lands here, after the floor's group baked its light indices.
        light.excludedMeshes = [Mesh._fromLite(floor as never) as AbstractMesh];
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        // A rebuild is a documented no-op until `_built`, so the request has to be held, not issued.
        expect(lateWork).toHaveLength(1);
        expect(bakedLightMode(lite, "floor")).toBe(2);

        release();
        await registration;
        expect(lite._built).toBe(true);

        for (const work of lateWork.splice(0)) {
            await work();
        }

        // The floor's group was built before the edit, and the per-frame updater only revisits the
        // selection when the light count or the mesh's world matrix changes, so only the held rebuild
        // can carry the exclusion into it.
        expect(bakedLightMode(lite, "floor")).toBe(1);
    });
});
