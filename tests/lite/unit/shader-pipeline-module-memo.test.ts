import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import { enableShaderMaterialFinalColor } from "../../../packages/babylon-lite/src/material/shader/enable-shader-material-final-color";
import { createShaderMaterial, type ShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { clearShaderPipelineCache, enableShaderPipelineCache } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline-cache";
import { getOrCreateShaderPipeline, getOrCreateShaderPipelineBindings } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

// The cross-material cache resolves shader modules by exact code. Once a material's modules are resolved for a variant,
// a rebind must not recompose the prelude nor look the code up again: the cache memoizes each material or view separately
// and invalidates the resolution with its shader bindings (device / cache generation).

function makeEngine() {
    const device = {
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
    } as unknown as GPUDevice;
    return { engine: { _device: device } as unknown as EngineContext, device };
}

const vertex = wgsl`
struct VertexInput { @location(0) position: vec3<f32> }
struct VertexOutput { @builtin(position) position: vec4<f32> }
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput; out.position = vec4<f32>(input.position, 1.0); return out;
}`;
const fragment = (tint: string) => wgsl`
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> { return vec4<f32>(${tint}, 1.0); }`;

const colorSig = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus", _sampleCount: 1 } as unknown as RenderTargetSignature;
const depthOnlySig = { _depthStencilFormat: "depth24plus", _sampleCount: 1 } as unknown as RenderTargetSignature;

type CacheMaterial = ShaderMaterial & {
    _shaderPipelineCache?: { getModule: (...args: unknown[]) => unknown };
};

function prepare(materials: ShaderMaterial[]) {
    clearShaderPipelineCache();
    clearSceneBGLCache();
    const { engine } = makeEngine();
    enableShaderPipelineCache(
        engine,
        materials.map((material) => ({ material }))
    );
    const cache = (materials[0] as CacheMaterial)._shaderPipelineCache!;
    const getModule = vi.spyOn(cache, "getModule");
    return { engine, getModule };
}

describe("ShaderMaterial module memo (rebinds do not recompose or look up resolved modules)", () => {
    it("resolves a color pass with two getModule calls, then none on an identical rebind", () => {
        const material = createShaderMaterial({ vertexSource: vertex, fragmentSource: fragment("1.0, 0.0, 0.0"), attributes: ["position"] });
        const { engine, getModule } = prepare([material]);
        const bindings = getOrCreateShaderPipelineBindings(engine, material);
        const first = getOrCreateShaderPipeline(engine, colorSig, material, bindings);
        expect(getModule).toHaveBeenCalledTimes(2);
        const second = getOrCreateShaderPipeline(engine, colorSig, material, bindings);
        expect(getModule).toHaveBeenCalledTimes(2);
        expect(second).toBe(first);
    });

    it("resolves a pass without fragment with a single getModule call, kept apart from the color variant", () => {
        const material = createShaderMaterial({ vertexSource: vertex, fragmentSource: fragment("0.0, 1.0, 0.0"), attributes: ["position"] });
        const { engine, getModule } = prepare([material]);
        const bindings = getOrCreateShaderPipelineBindings(engine, material);
        getOrCreateShaderPipeline(engine, depthOnlySig, material, bindings);
        expect(getModule).toHaveBeenCalledTimes(1);
        getOrCreateShaderPipeline(engine, depthOnlySig, material, bindings);
        expect(getModule).toHaveBeenCalledTimes(1);
        getOrCreateShaderPipeline(engine, colorSig, material, bindings);
        expect(getModule).toHaveBeenCalledTimes(3);
    });

    it("keeps thin-instance variants apart and its key free of separator collisions", () => {
        const material = createShaderMaterial({ vertexSource: vertex, fragmentSource: fragment("0.0, 0.0, 1.0"), attributes: ["position"] });
        const { engine, getModule } = prepare([material]);
        const bindings = getOrCreateShaderPipelineBindings(engine, material);
        const instanceLayout = { arrayStride: 64, stepMode: "instance", attributes: [] } as unknown as GPUVertexBufferLayout;
        const instanced = [...bindings.vertexBuffers, instanceLayout];
        // variant "a|" with attrs "b" versus variant "a" with attrs "|b": a naive "|"-joined key gives "a||b" for both and collides.
        getOrCreateShaderPipeline(engine, colorSig, material, bindings, "a|", instanced, "b");
        expect(getModule).toHaveBeenCalledTimes(2);
        getOrCreateShaderPipeline(engine, colorSig, material, bindings, "a", instanced, "|b");
        expect(getModule).toHaveBeenCalledTimes(4);
        getOrCreateShaderPipeline(engine, colorSig, material, bindings, "a|", instanced, "b");
        expect(getModule).toHaveBeenCalledTimes(4);
    });

    it("never lets a material view inherit its source's memo (the view's own sources are resolved)", () => {
        const source = createShaderMaterial({ vertexSource: vertex, fragmentSource: fragment("0.2, 0.2, 0.2"), attributes: ["position"] });
        const { engine, getModule } = prepare([source]);
        const sourceBindings = getOrCreateShaderPipelineBindings(engine, source);
        const sourcePipeline = getOrCreateShaderPipeline(engine, colorSig, source, sourceBindings);
        expect(getModule).toHaveBeenCalledTimes(2);
        const view = createMaterialView(source, { features: 0 }) as unknown as ShaderMaterial;
        Object.defineProperty(view, "fragmentSource", { value: fragment("0.9, 0.9, 0.9"), configurable: true });
        // A view reads the source's pipeline state through Object.create: it must still resolve ITS modules.
        const viewBindings = getOrCreateShaderPipelineBindings(engine, view);
        const viewPipeline = getOrCreateShaderPipeline(engine, colorSig, view, viewBindings);
        expect(getModule).toHaveBeenCalledTimes(4);
        expect(viewPipeline).not.toBe(sourcePipeline);
        // and the source keeps its own resolution: no further lookups for either on identical rebinds
        getOrCreateShaderPipeline(engine, colorSig, source, sourceBindings);
        getOrCreateShaderPipeline(engine, colorSig, view, viewBindings);
        expect(getModule).toHaveBeenCalledTimes(4);
    });

    it.each(["generation", "device", "generation-and-device"])(
        "resolves a view again after a source-first renewal (%s changed), even though the view inherits current pipeline state",
        (change) => {
            const source = createShaderMaterial({ vertexSource: vertex, fragmentSource: fragment("0.2, 0.2, 0.2"), attributes: ["position"] });
            const { engine } = prepare([source]);
            getOrCreateShaderPipeline(engine, colorSig, source, getOrCreateShaderPipelineBindings(engine, source));
            const view = createMaterialView(source, { features: 0 }) as unknown as ShaderMaterial;
            Object.defineProperty(view, "fragmentSource", { value: fragment("0.9, 0.9, 0.9"), configurable: true });
            const oldViewPipeline = getOrCreateShaderPipeline(engine, colorSig, view, getOrCreateShaderPipelineBindings(engine, view));
            expect(Object.prototype.hasOwnProperty.call(view, "_shaderBindings")).toBe(false); // the view inherits the source's bindings state
            if (change !== "device") clearShaderPipelineCache();
            const nextEngine = change === "generation" ? engine : makeEngine().engine;
            enableShaderPipelineCache(nextEngine, [{ material: source }]);
            const lookups = vi.spyOn((source as CacheMaterial)._shaderPipelineCache!, "getModule");
            getOrCreateShaderPipeline(nextEngine, colorSig, source, getOrCreateShaderPipelineBindings(nextEngine, source)); // source first: the view now inherits up-to-date fields
            expect(lookups).toHaveBeenCalledTimes(2);
            const newViewPipeline = getOrCreateShaderPipeline(nextEngine, colorSig, view, getOrCreateShaderPipelineBindings(nextEngine, view));
            expect(lookups).toHaveBeenCalledTimes(4); // the view's own stale memo is discarded: its fragment is resolved again
            const viewCodes = lookups.mock.calls.slice(2).map((call) => call[1] as string);
            expect(viewCodes.some((code) => code.includes("0.9, 0.9, 0.9"))).toBe(true);
            expect(newViewPipeline).not.toBe(oldViewPipeline);
            getOrCreateShaderPipeline(nextEngine, colorSig, view, getOrCreateShaderPipelineBindings(nextEngine, view));
            expect(lookups).toHaveBeenCalledTimes(4);
        }
    );

    it("memoizes the instance-colour variants of a getFinalColor material separately, with the cache enabled", () => {
        const source = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { let color = getFinalColor(input); return vec4f(input.position * color.rgb, 1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position"],
        });
        enableShaderMaterialFinalColor(source);
        const { engine, getModule } = prepare([source]);
        const bindings = getOrCreateShaderPipelineBindings(engine, source);
        const matrixLayout = {
            arrayStride: 64,
            stepMode: "instance",
            attributes: [1, 2, 3, 4].map((shaderLocation, i) => ({ shaderLocation, offset: i * 16, format: "float32x4" })),
        } as unknown as GPUVertexBufferLayout;
        const colorLayout = { arrayStride: 16, stepMode: "instance", attributes: [{ shaderLocation: 5, offset: 0, format: "float32x4" }] } as unknown as GPUVertexBufferLayout;
        const NL = String.fromCharCode(10);
        const matrixAttrs = ["@location(1) world0: vec4<f32>,", "@location(2) world1: vec4<f32>,", "@location(3) world2: vec4<f32>,", "@location(4) world3: vec4<f32>,", ""].join(
            NL
        );
        const colorAttrs = matrixAttrs + "@location(5) instanceColor: vec4<f32>," + NL;
        getOrCreateShaderPipeline(engine, colorSig, source, bindings, "matrix", [...bindings.vertexBuffers, matrixLayout], matrixAttrs);
        expect(getModule).toHaveBeenCalledTimes(2);
        getOrCreateShaderPipeline(engine, colorSig, source, bindings, "color", [...bindings.vertexBuffers, matrixLayout, colorLayout], colorAttrs);
        expect(getModule).toHaveBeenCalledTimes(4);
        const vertexCodes = getModule.mock.calls.map((call) => call[1] as string).filter((code) => code.includes("@vertex fn mainVertex"));
        expect(vertexCodes).toHaveLength(2);
        expect(vertexCodes[0]).toContain("fn getFinalColor");
        expect(vertexCodes[1]).toContain("return input.instanceColor;");
        expect(vertexCodes[0]).not.toContain("return input.instanceColor;");
        // identical rebinds of both variants resolve nothing more
        getOrCreateShaderPipeline(engine, colorSig, source, bindings, "matrix", [...bindings.vertexBuffers, matrixLayout], matrixAttrs);
        getOrCreateShaderPipeline(engine, colorSig, source, bindings, "color", [...bindings.vertexBuffers, matrixLayout, colorLayout], colorAttrs);
        expect(getModule).toHaveBeenCalledTimes(4);
    });

    it("drops the memo with the shader bindings when the cache generation or device changes", () => {
        const material = createShaderMaterial({ vertexSource: vertex, fragmentSource: fragment("0.5, 0.5, 0.0"), attributes: ["position"] });
        const { engine, getModule } = prepare([material]);
        getOrCreateShaderPipeline(engine, colorSig, material, getOrCreateShaderPipelineBindings(engine, material));
        expect(getModule).toHaveBeenCalledTimes(2);
        // a new generation installs a fresh cache: the old memo must not serve module ids of the old cache
        clearShaderPipelineCache();
        const { engine: nextEngine } = makeEngine();
        enableShaderPipelineCache(nextEngine, [{ material }]);
        const nextCache = (material as CacheMaterial)._shaderPipelineCache!;
        const nextGetModule = vi.spyOn(nextCache, "getModule");
        getOrCreateShaderPipeline(nextEngine, colorSig, material, getOrCreateShaderPipelineBindings(nextEngine, material));
        expect(nextGetModule).toHaveBeenCalledTimes(2);
        getOrCreateShaderPipeline(nextEngine, colorSig, material, getOrCreateShaderPipelineBindings(nextEngine, material));
        expect(nextGetModule).toHaveBeenCalledTimes(2);
    });
});
