import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import {
    _computeProceduralSkyIrradiance,
    computeProceduralSkySunColor,
    loadProceduralSkyEnvironment,
    updateProceduralSkyEnvironment,
    type ProceduralSkyEnvironment,
    type ProceduralSkyEnvironmentOptions,
} from "../../../packages/babylon-lite/src/loader-env/procedural-sky-environment";
import type { EnvironmentTextures } from "../../../packages/babylon-lite/src/loader-env/load-env";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

const DEFAULT_OPTIONS: ProceduralSkyEnvironmentOptions = {
    sunDirection: [0.35, 0.82, 0.45],
    luminance: 1,
    turbidity: 10,
    rayleigh: 2,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.8,
};

const IRRADIANCE_GOLDEN = [
    1022222662, 1025834719, 1026437100, 1006552305, 1000032978, 1006721155, 1025043499, 1028924170, 1029698667, 1043443455, 1049152758, 1052504667, 1043131588, 1048928304,
    1052336156, 1043533338, 1049206427, 1052547521, 998580377, 995592169, 992678407, 1001181340, 1003380752, 1000655327, 995738215, 993396489, 990890102,
];

function createEnvironment(yieldTask?: () => Promise<void>) {
    const writeBuffer = vi.fn();
    const submit = vi.fn();
    const pass = {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
    };
    const device = {
        queue: { writeBuffer, submit },
        createCommandEncoder: vi.fn(() => ({
            beginComputePass: () => pass,
            finish: () => ({}) as GPUCommandBuffer,
        })),
    } as unknown as GPUDevice;
    const engine = { _device: device } as EngineContext;
    const irradianceSH = new Float32Array(27);
    const sphericalHarmonics = new Float32Array(36);
    const textures = { irradianceSH, sphericalHarmonics } as EnvironmentTextures;
    const scene = {
        surface: { engine },
        _envTextures: textures,
        _frameGraph: { _tasks: [] },
    } as unknown as SceneContext;
    const environment = {
        _scene: scene,
        _texture: {} as GPUTexture,
        _parameterBuffer: {} as GPUBuffer,
        _bindGroup: {} as GPUBindGroup,
        _pipeline: {} as GPUComputePipeline,
        _mipmaps: [],
        _textures: textures,
        _disposed: false,
        _revision: 0,
        _yield: yieldTask,
    } satisfies ProceduralSkyEnvironment;
    return { environment, irradianceSH, sphericalHarmonics, submit, writeBuffer };
}

describe("procedural sky environment", () => {
    it("preserves the synchronous irradiance result while yielding fixed chunks", async () => {
        const yieldTask = vi.fn(async () => undefined);
        const irradiance = await _computeProceduralSkyIrradiance(DEFAULT_OPTIONS, yieldTask);

        expect(Array.from(new Uint32Array(irradiance!.buffer))).toEqual(IRRADIANCE_GOLDEN);
        expect(yieldTask).toHaveBeenCalledTimes(96);
    });

    it("commits atomically after irradiance completes and preserves environment array identities", async () => {
        let releaseFirstYield!: () => void;
        let firstYield = true;
        const yieldTask = () =>
            firstYield
                ? new Promise<void>((resolve) => {
                      firstYield = false;
                      releaseFirstYield = resolve;
                  })
                : Promise.resolve();
        const { environment, irradianceSH, sphericalHarmonics, submit, writeBuffer } = createEnvironment(yieldTask);

        const updating = updateProceduralSkyEnvironment(environment, DEFAULT_OPTIONS);
        await Promise.resolve();
        expect(submit).not.toHaveBeenCalled();
        expect(writeBuffer).not.toHaveBeenCalled();

        releaseFirstYield();
        await expect(updating).resolves.toBe(true);
        expect(submit).toHaveBeenCalledOnce();
        expect(writeBuffer).toHaveBeenCalledOnce();
        expect(environment._scene._envTextures!.irradianceSH).toBe(irradianceSH);
        expect(environment._scene._envTextures!.sphericalHarmonics).toBe(sphericalHarmonics);
    });

    it("lets only the newest overlapping update commit", async () => {
        let secondUpdate: Promise<boolean> | undefined;
        let launched = false;
        const { environment, submit } = createEnvironment(() => {
            if (!launched) {
                launched = true;
                queueMicrotask(() => {
                    secondUpdate = updateProceduralSkyEnvironment(environment, { ...DEFAULT_OPTIONS, turbidity: 5 });
                });
            }
            return Promise.resolve();
        });

        await expect(updateProceduralSkyEnvironment(environment, DEFAULT_OPTIONS)).resolves.toBe(false);
        await expect(secondUpdate).resolves.toBe(true);
        expect(submit).toHaveBeenCalledOnce();
    });

    it("uses the same request snapshot for irradiance and GPU parameters", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { environment, writeBuffer } = createEnvironment(() => gate);
        const options = { ...DEFAULT_OPTIONS, sunDirection: [...DEFAULT_OPTIONS.sunDirection] as [number, number, number] };
        const updating = updateProceduralSkyEnvironment(environment, options);
        options.luminance = 5;
        options.sunDirection[1] = -0.82;
        release();
        await expect(updating).resolves.toBe(true);
        const parameters = writeBuffer.mock.calls[0]![2] as Float32Array;
        expect(parameters[3]).toBe(1);
        expect(parameters[1]).toBeGreaterThan(0);
        expect(Array.from(new Uint32Array(environment._textures.irradianceSH.buffer))).toEqual(IRRADIANCE_GOLDEN);
    });

    it("rejects replacement and post-registration loading before allocating resources", async () => {
        const options = { ...DEFAULT_OPTIONS, brdfUrl: "/brdf.png" };
        await expect(loadProceduralSkyEnvironment({ _envTextures: {} } as SceneContext, options)).rejects.toThrow(/without an existing environment/);
        await expect(loadProceduralSkyEnvironment({ _built: true } as SceneContext, options)).rejects.toThrow(/before the scene is registered/);
    });

    it.each([-1, 1])("keeps the Mie directional endpoint %i finite", async (mieDirectionalG) => {
        const options = { ...DEFAULT_OPTIONS, mieDirectionalG };
        expect(computeProceduralSkySunColor(options).every(Number.isFinite)).toBe(true);
        const irradiance = await _computeProceduralSkyIrradiance(options, async () => undefined);
        expect(irradiance && Array.from(irradiance).every(Number.isFinite)).toBe(true);
    });

    it.each([
        { ...DEFAULT_OPTIONS, rayleigh: -1 },
        { ...DEFAULT_OPTIONS, mieCoefficient: -0.001 },
        { ...DEFAULT_OPTIONS, turbidity: -1 },
        { ...DEFAULT_OPTIONS, rayleigh: 0, mieCoefficient: 0 },
        { ...DEFAULT_OPTIONS, sunDirection: [0, -1, 0] as const, rayleigh: 0 },
    ])("rejects atmospheric parameters that can produce invalid scattering", (options) => {
        expect(() => computeProceduralSkySunColor(options)).toThrow(/non-negative scattering/);
    });

    it.each([
        { ...DEFAULT_OPTIONS, rayleigh: 0 },
        { ...DEFAULT_OPTIONS, mieCoefficient: 0 },
    ])("allows one scattering component to be zero when the total remains positive", (options) => {
        expect(computeProceduralSkySunColor(options).every(Number.isFinite)).toBe(true);
    });
});
