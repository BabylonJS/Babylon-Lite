import type { EngineContext } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { SCENE_UBO_WGSL } from "../../shader/scene-uniforms.js";
import { computeUboLayout } from "../../shader/ubo-layout.js";
import type { UboField, UboSpec } from "../../shader/fragment-types.js";
import type { ShaderAttributeName, ShaderMaterial, ShaderSamplerDecl, ShaderUniformDecl } from "./shader-material.js";
import { _isShaderSystemUniform } from "./shader-material.js";

export interface ShaderPipelineBindings {
    readonly group1BGL: GPUBindGroupLayout;
    readonly systemSpec: UboSpec;
    readonly customSpec: UboSpec | null;
    readonly vertexBuffers: readonly GPUVertexBufferLayout[];
    readonly pipelines: Map<string, GPURenderPipeline>;
}

interface ShaderMaterialPipelineState extends ShaderMaterial {
    _shaderDevice?: GPUDevice;
    _shaderBindings?: ShaderPipelineBindings;
    _shaderCustomUbo?: GPUBuffer | null;
    _shaderCustomSpec?: UboSpec | null;
    _shaderCustomData?: ArrayBuffer | null;
    _shaderCustomVersion?: number;
}

const SHADER_STAGE_ALL = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;

export function getOrCreateShaderPipelineBindings(engine: EngineContext, material: ShaderMaterial): ShaderPipelineBindings {
    const state = material as ShaderMaterialPipelineState;
    if (state._shaderBindings && state._shaderDevice === engine._device) {
        return state._shaderBindings;
    }

    state._shaderDevice = engine._device;
    const systemFields = material.uniformDecls.filter((u) => _isShaderSystemUniform(u.name)).map(toUboField);
    const customFields = material.uniformDecls.filter((u) => !_isShaderSystemUniform(u.name)).map(toUboField);
    const systemSpec = computeUboLayout(systemFields.length > 0 ? systemFields : [{ _name: "_pad", _type: "vec4<f32>" }]);
    const customSpec = customFields.length > 0 ? computeUboLayout(customFields) : null;
    const group1BGL = engine._device.createBindGroupLayout({
        label: "shader-material-group1",
        entries: buildBindGroupLayoutEntries(material.samplerDecls, customSpec !== null),
    });
    const bindings: ShaderPipelineBindings = {
        group1BGL,
        systemSpec,
        customSpec,
        vertexBuffers: material.attributes.map(attributeLayout),
        pipelines: new Map(),
    };
    state._shaderBindings = bindings;
    state._shaderCustomSpec = customSpec;
    state._shaderCustomUbo = null;
    state._shaderCustomData = null;
    state._shaderCustomVersion = -1;
    return bindings;
}

export function getOrCreateShaderPipeline(
    engine: EngineContext,
    sig: RenderTargetSignature,
    material: ShaderMaterial,
    bindings: ShaderPipelineBindings,
    variantKey = "",
    vertexBuffers: readonly GPUVertexBufferLayout[] = bindings.vertexBuffers,
    instanceAttrs = ""
): GPURenderPipeline {
    // `variantKey`, `vertexBuffers` and `instanceAttrs` default to the
    // non-instanced pipeline — byte-for-byte identical behaviour to before
    // instancing existed. The dynamically-imported thin-instance module is the
    // only caller that passes non-default values, so no instancing logic runs
    // for non-instanced scenes.
    const key = `${targetSignatureKey(sig)}${variantKey}`;
    const cached = bindings.pipelines.get(key);
    if (cached) {
        return cached;
    }
    const device = engine._device;
    const prelude = buildShaderPrelude(material, bindings.systemSpec, bindings.customSpec, instanceAttrs);
    const vertModule = device.createShaderModule({ label: `${material.name ?? "shader"}-vertex`, code: `${prelude}\n${material.vertexSource}` });
    const fragModule = sig._colorFormat ? device.createShaderModule({ label: `${material.name ?? "shader"}-fragment`, code: `${prelude}\n${material.fragmentSource}` }) : null;
    const colorTarget: GPUColorTargetState | null = sig._colorFormat
        ? {
              format: sig._colorFormat,
              ...(material.needAlphaBlending
                  ? {
                        blend:
                            material.blendMode === "additive"
                                ? ({
                                      color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
                                      alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
                                  } satisfies GPUBlendState)
                                : ({
                                      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                                      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                                  } satisfies GPUBlendState),
                    }
                  : {}),
          }
        : null;

    const pipeline = device.createRenderPipeline({
        label: `${material.name ?? "shader"}-pipeline`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [getSceneBindGroupLayout(engine), bindings.group1BGL] }),
        vertex: { module: vertModule, entryPoint: "mainVertex", buffers: vertexBuffers as GPUVertexBufferLayout[] },
        ...(fragModule && colorTarget ? { fragment: { module: fragModule, entryPoint: "mainFragment", targets: [colorTarget] } } : {}),
        ...(sig._depthStencilFormat
            ? {
                  depthStencil: {
                      format: sig._depthStencilFormat,
                      depthCompare: material.depthCompare,
                      depthWriteEnabled: material.needAlphaBlending ? false : material.depthWrite,
                  },
              }
            : {}),
        multisample: { count: sig._sampleCount },
        primitive: { topology: "triangle-list", cullMode: material.backFaceCulling ? "back" : "none", frontFace: sig._flipY ? "cw" : "ccw" },
    });
    bindings.pipelines.set(key, pipeline);
    return pipeline;
}

function toUboField(decl: ShaderUniformDecl): UboField {
    return { _name: decl.name, _type: decl.type };
}

function buildBindGroupLayoutEntries(samplers: readonly ShaderSamplerDecl[], hasCustomUbo: boolean): GPUBindGroupLayoutEntry[] {
    const entries: GPUBindGroupLayoutEntry[] = [{ binding: 0, visibility: SHADER_STAGE_ALL, buffer: { type: "uniform" } }];
    let nextBinding = 1;
    if (hasCustomUbo) {
        entries.push({ binding: nextBinding++, visibility: SHADER_STAGE_ALL, buffer: { type: "uniform" } });
    }
    for (const sampler of samplers) {
        const isArray = sampler.viewDimension === "2d-array";
        const sampleType = sampler.comparison === true ? "depth" : (sampler.sampleType ?? "float");
        entries.push({
            binding: nextBinding++,
            visibility: SHADER_STAGE_ALL,
            texture: {
                sampleType,
                viewDimension: isArray ? "2d-array" : "2d",
            },
        });
        entries.push({
            binding: nextBinding++,
            visibility: SHADER_STAGE_ALL,
            sampler: { type: sampler.comparison === true ? "comparison" : sampleType === "float" ? "filtering" : "non-filtering" },
        });
    }
    return entries;
}

function attributeLayout(name: ShaderAttributeName, shaderLocation: number): GPUVertexBufferLayout {
    switch (name) {
        case "position":
        case "normal":
            return { arrayStride: 12, attributes: [{ shaderLocation, offset: 0, format: "float32x3" }] };
        case "uv":
        case "uv2":
            return { arrayStride: 8, attributes: [{ shaderLocation, offset: 0, format: "float32x2" }] };
        case "tangent":
        case "color":
            return { arrayStride: 16, attributes: [{ shaderLocation, offset: 0, format: "float32x4" }] };
    }
}

function buildShaderPrelude(material: ShaderMaterial, systemSpec: UboSpec, customSpec: UboSpec | null, instanceAttrs = ""): string {
    let wgsl = `${SCENE_UBO_WGSL}
struct ShaderSystemUniforms {
${systemSpec._structBody}
}
@group(1) @binding(0) var<uniform> shaderSystem: ShaderSystemUniforms;
`;
    if (customSpec) {
        wgsl += `struct ShaderUniforms {
${customSpec._structBody}
}
@group(1) @binding(1) var<uniform> shaderUniforms: ShaderUniforms;
`;
    }
    let nextBinding = customSpec ? 2 : 1;
    for (const sampler of material.samplerDecls) {
        const isArray = sampler.viewDimension === "2d-array";
        const isDepth = sampler.comparison === true || sampler.sampleType === "depth";
        const texType = isDepth ? (isArray ? "texture_depth_2d_array" : "texture_depth_2d") : isArray ? "texture_2d_array<f32>" : "texture_2d<f32>";
        const samplerType = sampler.comparison === true ? "sampler_comparison" : "sampler";
        wgsl += `@group(1) @binding(${nextBinding++}) var ${sampler.name}: ${texType};
@group(1) @binding(${nextBinding++}) var ${sampler.name}Sampler: ${samplerType};
`;
    }
    for (const define of material.defines) {
        wgsl += `const ${define.name}: ${typeof define.value === "boolean" ? "bool" : "f32"} = ${formatDefineValue(define.value)};
`;
    }
    wgsl += `struct VertexInput {
`;
    for (let i = 0; i < material.attributes.length; i++) {
        const attr = material.attributes[i]!;
        wgsl += `@location(${i}) ${attr}: ${attributeWgslType(attr)},
`;
    }
    wgsl += instanceAttrs;
    wgsl += `};
`;
    return wgsl;
}

function formatDefineValue(value: boolean | number): string {
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    if (Number.isInteger(value)) {
        return `${value}.0`;
    }
    return String(value);
}

function attributeWgslType(name: ShaderAttributeName): string {
    switch (name) {
        case "position":
        case "normal":
            return "vec3<f32>";
        case "uv":
        case "uv2":
            return "vec2<f32>";
        case "tangent":
        case "color":
            return "vec4<f32>";
    }
}
