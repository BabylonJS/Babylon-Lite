import { F32 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import type { Renderable } from "../render/renderable.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { SCENE_UBO_WGSL } from "../shader/scene-uniforms.js";
import type { BillboardCustomShader } from "../sprite/billboard-custom-shader.js";
import type { buildBillboardRenderable } from "../sprite/billboard-renderable.js";
import {
    BILLBOARD_SYSTEM_UBO_BYTES,
    buildBillboardSystemUbo,
    createBillboardPipelineCache,
    createBillboardSystemBindGroup,
    getOrCreateBillboardPipeline,
    makeBillboardBasisWgsl,
    resetBillboardPipelineCache,
    writeBillboardSystemUboIfDirty,
} from "../sprite/billboard-pipeline.js";
import type { BillboardOrientation, BillboardSpriteSystem, BillboardSpriteSystemOptions, FacingBillboardSpriteSystem } from "../sprite/billboard-sprite.js";
import type { BillboardFxHook } from "../sprite/sprite-fx-hook.js";
import { _registerBillboardFxHook } from "../sprite/sprite-fx-hook.js";
import { createParticleBlend } from "./particle-blend.js";

const MULTIPLY_FRAGMENT_WGSL = `let sampled = textureSample(atlasTex, atlasSamp, in.uv);
let baseColor = sampled * in.tint * billboards.opacityMul;
let sourceAlpha = sampled.a * in.tint.a * billboards.opacityMul.a;
return vec4f(baseColor.rgb * sourceAlpha + vec3f(1.0) * (1.0 - sourceAlpha), baseColor.a);`;

let _multiplyShader: BillboardCustomShader | null = null;
let _multiplyModules: WeakMap<GPUDevice, Map<BillboardOrientation, GPUShaderModule>> | null = null;
const EMPTY_PARTICLE_SHADER_PARAMS: readonly number[] = [0, 0, 0, 0];

// Deliberately mirrors BILLBOARD_FX_HOOK without importing billboard-custom-shader/custom-shader-core
// into Multiply-only bundles. The global hook is last-writer-wins, so this copy remains behaviorally
// compatible with public billboard custom shaders while keeping the private static path free of SpriteFx.
const PARTICLE_SHADER_HOOK: BillboardFxHook = {
    initSystem(system, opts: BillboardSpriteSystemOptions) {
        if (opts.customShader) {
            (system as { _customShader?: BillboardCustomShader })._customShader = opts.customShader;
            system.shaderParams = [0, 0, 0, 0];
        }
    },
    pipelineKeyPart(system) {
        return system._customShader?._key ?? "";
    },
    shaderModule(engine, system) {
        return system._customShader?._getShaderModule(engine, system._orientation, system._depthMode) ?? null;
    },
    layoutEntries(system, startBinding) {
        return system._customShader?._layoutEntries(startBinding) ?? null;
    },
    createLayerFx(engine, label, system) {
        return system._customShader?._createLayerFx(engine, label) ?? null;
    },
    updateFx(fx, system, deltaMs) {
        fx.update(system.shaderParams ?? EMPTY_PARTICLE_SHADER_PARAMS, deltaMs);
    },
    bindEntries(fx, startBinding) {
        return fx.bindEntries(startBinding);
    },
    disposeFx(fx) {
        fx.destroy();
    },
};

// Keep the vertex stage local: a shared runtime helper changed chunk topology and grew stock billboard bundles.
function makeMultiplyWgsl(orientation: BillboardOrientation): string {
    return `${SCENE_UBO_WGSL}
struct S {
opacityMul: vec4f,
axisAndCutoff: vec4f,
};
@group(1) @binding(0) var<uniform> billboards: S;
@group(1) @binding(1) var atlasTex: texture_2d<f32>;
@group(1) @binding(2) var atlasSamp: sampler;
${makeBillboardBasisWgsl(orientation)}
struct I {
@builtin(vertex_index) vid: u32,
@location(0) p: vec3f,
@location(1) s: vec2f,
@location(2) a: vec2f,
@location(3) b: vec2f,
@location(4) r: f32,
@location(5) o: vec2f,
@location(6) c: vec4f,
};
struct O {
@builtin(position) p: vec4f,
@location(0) uv: vec2f,
@location(1) tint: vec4f,
};
@vertex
fn vs(in: I) -> O {
let q = vec2f(select(0.0, 1.0, in.vid == 1u || in.vid == 2u), select(0.0, 1.0, in.vid >= 2u));
let l = (q - in.o) * in.s;
let cr = cos(in.r);
let sr = sin(in.r);
let r = vec2f(l.x * cr - l.y * sr, l.x * sr + l.y * cr);
let b = basis(in.p);
let wp = in.p + b.r * r.x + b.u * r.y;
var out: O;
out.p = scene.viewProjection * vec4f(wp, 1);
out.uv = mix(in.a, in.b, q);
out.tint = in.c;
return out;
}
@fragment
fn fs(in: O) -> @location(0) vec4f {
${MULTIPLY_FRAGMENT_WGSL}
}`;
}

function getMultiplyModule(engine: EngineContext, orientation: BillboardOrientation): GPUShaderModule {
    _multiplyModules ??= new WeakMap();
    let modules = _multiplyModules.get(engine._device);
    if (!modules) {
        modules = new Map();
        _multiplyModules.set(engine._device, modules);
    }
    let module = modules.get(orientation);
    if (!module) {
        module = engine._device.createShaderModule({ code: makeMultiplyWgsl(orientation) });
        modules.set(orientation, module);
    }
    return module;
}

function getMultiplyShader(): BillboardCustomShader {
    _registerBillboardFxHook(PARTICLE_SHADER_HOOK);
    return (_multiplyShader ??= {
        _entityType: "billboard-custom-shader",
        _extraTextures: [],
        _key: "particle-multiply",
        _composeWgsl: (orientation) => makeMultiplyWgsl(orientation),
        _getShaderModule: (engine, orientation) => getMultiplyModule(engine, orientation),
        _layoutEntries: () => [],
        _createLayerFx: () => null,
    });
}

/** @internal Attach the private static Multiply shader before the generic billboard builder runs. */
export function attachParticleMultiplyShader(billboard: FacingBillboardSpriteSystem): void {
    (billboard as { _customShader?: BillboardCustomShader })._customShader = getMultiplyShader();
    billboard.shaderParams = undefined;
}

/** Build a billboard renderable with an optional second Add pass for MultiplyAdd. */
export function buildParticleBlendBillboardRenderable(
    engine: EngineContext,
    billboard: FacingBillboardSpriteSystem,
    buildBase: typeof buildBillboardRenderable
): { renderable: Renderable; dispose: () => void } {
    const system = billboard as FacingBillboardSpriteSystem;
    const addSystem = { ...system, blendMode: createParticleBlend(2), _customShader: undefined, shaderParams: undefined } as BillboardSpriteSystem;
    const built = buildBase(engine, system);
    if (system.blendMode._particlePasses !== 2) {
        return built;
    }

    const pipelineCache = createBillboardPipelineCache();
    // The base renderable owns its UBO privately; keep this second buffer inside the optional mode-4 chunk.
    const uniformBuffer = createEmptyUniformBuffer(engine, BILLBOARD_SYSTEM_UBO_BYTES, "particle-add-billboard-system-ubo");
    const bindGroups = new Map<GPURenderPipeline, GPUBindGroup>();
    const scratchUbo = new F32(BILLBOARD_SYSTEM_UBO_BYTES / 4);
    const lastUbo = new F32(BILLBOARD_SYSTEM_UBO_BYTES / 4);
    const bindMultiply = built.renderable.bind;
    let uboUploaded = false;
    let disposed = false;

    built.renderable.bind = (bindEngine, target) => {
        if (!target._depthStencilFormat) {
            throw new Error("BillboardSpriteSystem requires a depth-stencil render target.");
        }
        const primary = bindMultiply(bindEngine, target);
        const sampleCount = target._sampleCount === 1 ? 1 : 4;
        const addPipeline = getOrCreateBillboardPipeline(
            bindEngine,
            pipelineCache,
            target._colorFormat!,
            sampleCount,
            addSystem,
            target._depthStencilFormat,
            getSceneBindGroupLayout(bindEngine)
        );
        let addBindGroup = bindGroups.get(addPipeline);
        if (!addBindGroup) {
            addBindGroup = createBillboardSystemBindGroup(bindEngine, addPipeline, addSystem, uniformBuffer);
            bindGroups.set(addPipeline, addBindGroup);
        }
        return {
            renderable: built.renderable,
            pipeline: primary.pipeline,
            update(context) {
                primary.update?.(context);
                buildBillboardSystemUbo(system, scratchUbo);
                writeBillboardSystemUboIfDirty(bindEngine._device, uniformBuffer, scratchUbo, lastUbo, !uboUploaded);
                uboUploaded = true;
            },
            draw(pass, drawEngine) {
                const primaryDraws = primary.draw(pass, drawEngine);
                if (primaryDraws === 0) {
                    return 0;
                }
                pass.setPipeline(addPipeline);
                pass.setBindGroup(1, addBindGroup);
                pass.drawIndexed(6, system.count, 0, 0, 0);
                // The render task caches `primary.pipeline`; restore it after this hidden second pass.
                pass.setPipeline(primary.pipeline);
                return primaryDraws + 1;
            },
        };
    };

    return {
        renderable: built.renderable,
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            built.dispose();
            uniformBuffer.destroy();
            bindGroups.clear();
            resetBillboardPipelineCache(pipelineCache);
        },
    };
}
