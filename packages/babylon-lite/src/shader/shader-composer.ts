/**
 * Shader Composer — assembles ShaderFragment[] + ShaderTemplate into
 * final WGSL source + GPU layout descriptors. Pure function, no global state.
 * All shader text comes from template + fragment modules.
 */
import type { BindingDecl, ComposedShader, FragmentSlot, ShaderFragment, ShaderTemplate, VertexAttribute, VertexSlot, Varying } from "./fragment-types.js";
import { computeUboLayout } from "./ubo-layout.js";
import { SCENE_UBO_WGSL } from "./scene-uniforms.js";
import { wgsl } from "./wgsl.js";
import type { MeshVbLayout } from "../mesh/mesh.js";

const STAGE_VERTEX = 0x1;
const STAGE_FRAGMENT = 0x2;
const VERTEX_SECTIONS = ["/*SU*/", "/*MU*/", "/*VI*/", "/*VO*/", "/*VD*/", "/*VP*/", "/*VH*/"] as const;
const FRAGMENT_SECTIONS = ["/*SU*/", "/*MU*/", "/*FI*/", "/*HF*/", "/*FB*/"] as const;
const MATERIAL_BINDING_GROUPS = ["mesh", "shadow"] as const;

function replaceSections(template: string, markers: readonly string[], sections: readonly string[]): string {
    for (let index = 0; index < markers.length; index++) {
        template = template.replace(markers[index]!, sections[index]!);
    }
    return template;
}

function topoSort(fragments: readonly ShaderFragment[]): ShaderFragment[] {
    const nodes = new Map<string, { _fragment: ShaderFragment; _remaining: number; _dependents: string[] }>();
    for (const f of fragments) {
        if (nodes.has(f._id)) {
            throw Error();
        }
        nodes.set(f._id, { _fragment: f, _remaining: f._dependencies?.length ?? 0, _dependents: [] });
    }
    for (const f of fragments) {
        for (const d of f._dependencies ?? []) {
            const dependency = nodes.get(d);
            if (!dependency) {
                throw Error();
            }
            dependency._dependents.push(f._id);
        }
    }
    const q: string[] = [];
    for (const [id, node] of nodes) {
        if (node._remaining === 0) {
            q.push(id);
        }
    }
    q.sort();
    const out: ShaderFragment[] = [];
    let qi = 0;
    while (qi < q.length) {
        const id = q[qi++]!;
        const node = nodes.get(id)!;
        out.push(node._fragment);
        for (const d of node._dependents) {
            const dependent = nodes.get(d)!;
            if (--dependent._remaining === 0) {
                let i = qi;
                while (i < q.length && q[i]! < d) {
                    i++;
                }
                q.splice(i, 0, d);
            }
        }
    }
    if (out.length !== fragments.length) {
        throw Error();
    }
    return out;
}

function dedup<T extends { _name: string }>(base: readonly T[], extra: readonly T[]): T[] {
    const seen = new Set<string>();
    const all: T[] = [];
    for (const list of [base, extra]) {
        for (const value of list) {
            if (!seen.has(value._name)) {
                seen.add(value._name);
                all.push(value);
            }
        }
    }
    return all;
}

const SLOT_RE = /\/\*([A-Z_0-9]+)\*\//g;
function injectSlots(tpl: string, sorted: readonly ShaderFragment[], key: "_fragmentSlots" | "_vertexSlots"): string {
    return tpl.replace(SLOT_RE, (_, slot: string) => {
        const parts: string[] = [];
        for (const f of sorted) {
            const s = f[key] as Partial<Record<FragmentSlot | VertexSlot, string>> | undefined;
            if (s?.[slot as FragmentSlot | VertexSlot]) {
                parts.push(s[slot as FragmentSlot | VertexSlot]!);
            }
        }
        return parts.join("\n");
    });
}

export function composeShader(template: ShaderTemplate, fragments: readonly ShaderFragment[], meshVertexLayout?: MeshVbLayout): ComposedShader {
    const sorted = topoSort(fragments);

    // Collect fragment data
    const fragAttrs: VertexAttribute[] = [];
    const fragVaryings: Varying[] = [];
    const helpers: string[] = [];
    const vHelpers: string[] = [];
    const vBuiltins: string[] = [];
    for (const f of sorted) {
        if (f._vertexAttributes) {
            fragAttrs.push(...f._vertexAttributes);
        }
        if (f._varyings) {
            fragVaryings.push(...f._varyings);
        }
        if (f._helperFunctions) {
            helpers.push(f._helperFunctions);
        }
        if (f._vertexHelperFunctions) {
            vHelpers.push(f._vertexHelperFunctions);
        }
        for (const b of f._vertexBuiltins ?? []) {
            vBuiltins.push(wgsl`@builtin(${b._builtin}) ${b._name}:${b._type},`);
        }
    }

    // Vertex attributes + layouts
    const allAttrs = dedup(template._baseVertexAttributes, fragAttrs);
    const inputLines: string[] = [];
    const _vertexBufferLayouts: GPUVertexBufferLayout[] = [];
    const groups = new Map<string, GPUVertexBufferLayout & { attributes: GPUVertexAttribute[] }>();
    for (let i = 0; i < allAttrs.length; i++) {
        const a = allAttrs[i]!;
        const meshLayout = a._stepMode !== "instance" ? meshVertexLayout?.[a._name] : undefined;
        inputLines.push(wgsl`@location(${i}) ${a._name}:${a._type},`);
        let layout = a._bufferGroup ? groups.get(a._bufferGroup) : undefined;
        if (!layout) {
            layout = {
                arrayStride: meshLayout?._stride ?? a._arrayStride,
                stepMode: a._stepMode ?? "vertex",
                attributes: [],
            };
            if (a._bufferGroup) {
                groups.set(a._bufferGroup, layout);
            } else {
                _vertexBufferLayouts.push(layout);
            }
        }
        layout.attributes.push({ shaderLocation: i, offset: meshLayout?._offset ?? a._offset ?? 0, format: a._gpuFormat });
    }
    for (const layout of groups.values()) {
        _vertexBufferLayouts.push(layout);
    }
    let nextLoc = allAttrs.length;
    for (const f of sorted) {
        if (f._pipelineVertexBuffers) {
            const r = f._pipelineVertexBuffers(nextLoc);
            _vertexBufferLayouts.push(...r._buffers);
            nextLoc = r._nextLoc;
        }
    }

    // Varyings
    const allVary = dedup(template._baseVaryings, fragVaryings);
    const varyBody = wgsl`@builtin(position) clipPos:vec4f,\n` + allVary.map((v, i) => wgsl`@location(${i}) ${v._name}:${v._type},`).join("\n");

    // UBO layouts
    const hasMaterialUbo = !!(template._baseMaterialUboFields && template._baseMaterialUboFields.length > 0);
    const meshFields = [...template._baseMeshUboFields];
    const materialFields = hasMaterialUbo ? [...template._baseMaterialUboFields] : [];
    for (const f of sorted) {
        if (f._uboFields?.length) {
            (hasMaterialUbo ? materialFields : meshFields).push(...f._uboFields);
        }
    }
    const _meshUboSpec = computeUboLayout(meshFields);
    const _materialUboSpec = hasMaterialUbo ? computeUboLayout(materialFields) : undefined;

    // Bindings
    const meshBGL: GPUBindGroupLayoutEntry[] = [{ binding: 0, visibility: STAGE_VERTEX | STAGE_FRAGMENT, buffer: { type: "uniform" } }];
    if (hasMaterialUbo) {
        meshBGL.push({ binding: 1, visibility: STAGE_FRAGMENT, buffer: { type: "uniform" } });
    }
    const shadowBGL: GPUBindGroupLayoutEntry[] = [];
    const vDecls: string[] = [];
    const fDecls: string[] = [];
    let mb = hasMaterialUbo ? 2 : 1,
        sb = 0;

    function addBinding(d: BindingDecl) {
        const isShadow = d._group === "shadow";
        const b = isShadow ? sb++ : mb++;
        const g = isShadow ? 2 : 1;
        const entry: GPUBindGroupLayoutEntry = { binding: b, visibility: d._visibility };
        const type = d._type;
        let qualifier = "";
        let shaderType: string;
        switch (type._kind) {
            case "uniform-buffer":
                entry.buffer = { type: "uniform" };
                qualifier = "<uniform>";
                shaderType = `${d._name}Uniforms`;
                break;
            case "texture": {
                const defaultType = type._textureType === "texture_depth_2d" ? "depth" : type._textureType === "texture_2d<u32>" ? "uint" : "float";
                entry.texture = {
                    sampleType: (type._sampleType ?? defaultType) as GPUTextureSampleType,
                    viewDimension: type._textureType.includes("array") ? "2d-array" : type._textureType.includes("cube") ? "cube" : "2d",
                };
                shaderType = type._textureType;
                break;
            }
            case "sampler":
                entry.sampler = {
                    type: type._samplerType === "sampler_comparison" ? "comparison" : type._samplerType === "sampler_non_filtering" ? "non-filtering" : "filtering",
                };
                shaderType = type._samplerType === "sampler_non_filtering" ? "sampler" : type._samplerType;
                break;
            case "storage-texture":
                entry.storageTexture = { access: type._access as GPUStorageTextureAccess, format: type._format as GPUTextureFormat };
                shaderType = `texture_storage_2d<${type._format},${type._access}>`;
                break;
        }
        (isShadow ? shadowBGL : meshBGL).push(entry);
        const w = wgsl`@group(${g})@binding(${b}) var${qualifier} ${d._name}:${shaderType};`;
        if (d._visibility & STAGE_VERTEX) {
            vDecls.push(w);
        }
        if (d._visibility & STAGE_FRAGMENT) {
            fDecls.push(w);
        }
    }

    for (const d of template._baseVertexBindings ?? []) {
        addBinding(d);
    }
    for (const f of sorted) {
        for (const d of f._vertexBindings ?? []) {
            addBinding(d);
        }
    }
    for (const d of template._baseBindings ?? []) {
        addBinding(d);
    }
    for (const group of MATERIAL_BINDING_GROUPS) {
        for (const f of sorted) {
            for (const d of f._bindings ?? []) {
                if ((d._group ?? "mesh") === group) {
                    addBinding(d);
                }
            }
        }
    }

    const _fragmentKey = sorted.map((f) => f._id).join("|");
    const vertexInputs = inputLines.join("\n");
    const vParams = (vBuiltins.length ? vBuiltins.join("\n") + "\n" : "") + vertexInputs;
    const meshStruct = wgsl`struct MeshUniforms{\n${_meshUboSpec._structBody}\n}`;
    const materialStruct = _materialUboSpec
        ? wgsl`\nstruct MaterialUniforms{\n${_materialUboSpec._structBody}\n}\n@group(1)@binding(1) var<uniform> material:MaterialUniforms;`
        : "";

    let vertexWGSL = replaceSections(template._vertexTemplate, VERTEX_SECTIONS, [
        SCENE_UBO_WGSL,
        meshStruct,
        wgsl`struct VertexInput{\n${vertexInputs}\n}`,
        wgsl`struct VertexOutput{\n${varyBody}\n}`,
        vDecls.join("\n"),
        vParams,
        vHelpers.join("\n"),
    ]);
    // These dynamic keys are reserved from Terser property mangling in bundle-scenes-core.ts.
    vertexWGSL = injectSlots(vertexWGSL, sorted, "_vertexSlots");

    let fragmentWGSL = replaceSections(template._fragmentTemplate, FRAGMENT_SECTIONS, [
        SCENE_UBO_WGSL,
        meshStruct + materialStruct,
        wgsl`struct FragmentInput{\n${varyBody}\n}`,
        helpers.join("\n"),
        fDecls.join("\n"),
    ]);
    fragmentWGSL = injectSlots(fragmentWGSL, sorted, "_fragmentSlots");

    const _meshBGLDescriptor = { entries: meshBGL };
    const _shadowBGLDescriptor = shadowBGL.length ? { entries: shadowBGL } : null;

    return {
        _vertexWGSL: wgsl`${vertexWGSL}`,
        _fragmentWGSL: wgsl`${fragmentWGSL}`,
        _meshBGLDescriptor,
        _shadowBGLDescriptor,
        _vertexBufferLayouts,
        _meshUboSpec,
        _materialUboSpec,
        _fragmentKey,
    };
}
