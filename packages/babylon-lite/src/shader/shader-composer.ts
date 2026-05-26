/**
 * Shader Composer — assembles ShaderFragment[] + ShaderTemplate into
 * final WGSL source + GPU layout descriptors. Pure function, no global state.
 * All shader text comes from template + fragment modules.
 */
import type { BindingDecl, ComposedShader, FragmentSlot, ShaderFragment, ShaderTemplate, VertexAttribute, VertexSlot, Varying } from "./fragment-types.js";
import { computeUboLayout } from "./ubo-layout.js";
import { SCENE_UBO_WGSL } from "./scene-uniforms.js";

const STAGE_VERTEX = 0x1;
const STAGE_FRAGMENT = 0x2;

function topoSort(fragments: readonly ShaderFragment[]): ShaderFragment[] {
    const byId = new Map<string, ShaderFragment>();
    for (const f of fragments) {
        if (byId.has(f._id)) {
            throw Error();
        }
        byId.set(f._id, f);
    }
    const inDeg = new Map<string, number>();
    const deps = new Map<string, string[]>();
    for (const f of fragments) {
        if (!inDeg.has(f._id)) {
            inDeg.set(f._id, 0);
        }
        for (const d of f._dependencies ?? []) {
            if (!byId.has(d)) {
                throw Error();
            }
            inDeg.set(f._id, (inDeg.get(f._id) ?? 0) + 1);
            let arr = deps.get(d);
            if (!arr) {
                arr = [];
                deps.set(d, arr);
            }
            arr.push(f._id);
        }
    }
    const q: string[] = [];
    for (const [id, d] of inDeg) {
        if (d === 0) {
            q.push(id);
        }
    }
    q.sort();
    const out: ShaderFragment[] = [];
    let qi = 0;
    while (qi < q.length) {
        const id = q[qi++]!;
        out.push(byId.get(id)!);
        for (const d of deps.get(id) ?? []) {
            const nd = (inDeg.get(d) ?? 1) - 1;
            inDeg.set(d, nd);
            if (nd === 0) {
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
    for (const v of base) {
        if (!seen.has(v._name)) {
            seen.add(v._name);
            all.push(v);
        }
    }
    for (const v of extra) {
        if (!seen.has(v._name)) {
            seen.add(v._name);
            all.push(v);
        }
    }
    return all;
}

function bglEntry(binding: number, decl: BindingDecl): GPUBindGroupLayoutEntry {
    const e: GPUBindGroupLayoutEntry = { binding, visibility: decl._visibility };
    switch (decl._type._kind) {
        case "uniform-buffer":
            e.buffer = { type: "uniform" };
            break;
        case "texture": {
            const def = decl._type._textureType === "texture_depth_2d" ? "depth" : decl._type._textureType === "texture_2d<u32>" ? "uint" : "float";
            e.texture = { sampleType: (decl._type._sampleType ?? def) as GPUTextureSampleType, viewDimension: decl._type._textureType.includes("cube") ? "cube" : "2d" };
            break;
        }
        case "sampler":
            e.sampler = {
                type: decl._type._samplerType === "sampler_comparison" ? "comparison" : decl._type._samplerType === "sampler_non_filtering" ? "non-filtering" : "filtering",
            };
            break;
        case "storage-texture":
            e.storageTexture = { access: decl._type._access as GPUStorageTextureAccess, format: decl._type._format as GPUTextureFormat };
            break;
    }
    return e;
}

function declWGSL(g: number, b: number, d: BindingDecl): string {
    switch (d._type._kind) {
        case "uniform-buffer":
            return `@group(${g})@binding(${b}) var<uniform> ${d._name}:${d._name}Uniforms;`;
        case "texture":
            return `@group(${g})@binding(${b}) var ${d._name}:${d._type._textureType};`;
        case "sampler":
            return `@group(${g})@binding(${b}) var ${d._name}:${d._type._samplerType === "sampler_non_filtering" ? "sampler" : d._type._samplerType};`;
        case "storage-texture":
            return `@group(${g})@binding(${b}) var ${d._name}:texture_storage_2d<${d._type._format},${d._type._access}>;`;
    }
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

export function composeShader(template: ShaderTemplate, fragments: readonly ShaderFragment[]): ComposedShader {
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
            vBuiltins.push(`@builtin(${b._builtin}) ${b._name}:${b._type},`);
        }
    }

    // Vertex attributes + layouts
    const allAttrs = dedup(template._baseVertexAttributes, fragAttrs);
    const inputLines: string[] = [];
    const _vertexBufferLayouts: GPUVertexBufferLayout[] = [];
    const groups = new Map<string, { loc: number; off: number; fmt: GPUVertexFormat }[]>();
    const firstOfGroup = new Map<string, VertexAttribute>();
    for (let i = 0; i < allAttrs.length; i++) {
        const a = allAttrs[i]!;
        inputLines.push(`@location(${i}) ${a._name}:${a._type},`);
        if (a._bufferGroup) {
            if (!groups.has(a._bufferGroup)) {
                groups.set(a._bufferGroup, []);
                firstOfGroup.set(a._bufferGroup, a);
            }
            groups.get(a._bufferGroup)!.push({ loc: i, off: a._offset ?? 0, fmt: a._gpuFormat });
        } else {
            _vertexBufferLayouts.push({
                arrayStride: a._arrayStride,
                stepMode: a._stepMode ?? "vertex",
                attributes: [{ shaderLocation: i, offset: a._offset ?? 0, format: a._gpuFormat }],
            });
        }
    }
    for (const [grp, attrs] of groups) {
        const f = firstOfGroup.get(grp)!;
        _vertexBufferLayouts.push({
            arrayStride: f._arrayStride,
            stepMode: f._stepMode ?? "vertex",
            attributes: attrs.map((a) => ({ shaderLocation: a.loc, offset: a.off, format: a.fmt })),
        });
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
    const varyBody = `@builtin(position) clipPos:vec4f,\n` + allVary.map((v, i) => `@location(${i}) ${v._name}:${v._type},`).join("\n");

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

    function addBinding(d: BindingDecl, _isVertex: boolean) {
        const isShadow = d._group === "shadow";
        const b = isShadow ? sb++ : mb++;
        const g = isShadow ? 2 : 1;
        (isShadow ? shadowBGL : meshBGL).push(bglEntry(b, d));
        const w = declWGSL(g, b, d);
        if (d._visibility & STAGE_VERTEX) {
            vDecls.push(w);
        }
        if (d._visibility & STAGE_FRAGMENT) {
            fDecls.push(w);
        }
    }

    for (const d of template._baseVertexBindings ?? []) {
        addBinding(d, true);
    }
    for (const f of sorted) {
        for (const d of f._vertexBindings ?? []) {
            addBinding(d, true);
        }
    }
    for (const d of template._baseBindings ?? []) {
        addBinding(d, false);
    }
    for (const f of sorted) {
        for (const d of (f._bindings ?? []).filter((b) => (b._group ?? "mesh") === "mesh")) {
            addBinding(d, false);
        }
    }
    for (const f of sorted) {
        for (const d of (f._bindings ?? []).filter((b) => b._group === "shadow")) {
            addBinding(d, false);
        }
    }

    const _fragmentKey = sorted.map((f) => f._id).join("|");
    const vParams = (vBuiltins.length ? vBuiltins.join("\n") + "\n" : "") + inputLines.join("\n");
    const meshStruct = `struct MeshUniforms{\n${_meshUboSpec._structBody}\n}`;
    const materialStruct = _materialUboSpec ? `\nstruct MaterialUniforms{\n${_materialUboSpec._structBody}\n}\n@group(1)@binding(1) var<uniform> material:MaterialUniforms;` : "";

    let _vertexWGSL = template._vertexTemplate;
    _vertexWGSL = _vertexWGSL.replace("/*SU*/", SCENE_UBO_WGSL);
    _vertexWGSL = _vertexWGSL.replace("/*MU*/", meshStruct);
    _vertexWGSL = _vertexWGSL.replace("/*VI*/", `struct VertexInput{\n${inputLines.join("\n")}\n}`);
    _vertexWGSL = _vertexWGSL.replace("/*VO*/", `struct VertexOutput{\n${varyBody}\n}`);
    _vertexWGSL = _vertexWGSL.replace("/*VD*/", vDecls.join("\n"));
    _vertexWGSL = _vertexWGSL.replace("/*VP*/", vParams);
    _vertexWGSL = _vertexWGSL.replace("/*VH*/", vHelpers.join("\n"));
    // These dynamic keys are reserved from Terser property mangling in bundle-scenes-core.ts.
    _vertexWGSL = injectSlots(_vertexWGSL, sorted, "_vertexSlots");

    let _fragmentWGSL = template._fragmentTemplate;
    _fragmentWGSL = _fragmentWGSL.replace("/*SU*/", SCENE_UBO_WGSL);
    _fragmentWGSL = _fragmentWGSL.replace("/*MU*/", meshStruct + materialStruct);
    _fragmentWGSL = _fragmentWGSL.replace("/*FI*/", `struct FragmentInput{\n${varyBody}\n}`);
    _fragmentWGSL = _fragmentWGSL.replace("/*HF*/", helpers.join("\n"));
    _fragmentWGSL = _fragmentWGSL.replace("/*FB*/", fDecls.join("\n"));
    _fragmentWGSL = injectSlots(_fragmentWGSL, sorted, "_fragmentSlots");

    const _meshBGLDescriptor = { entries: meshBGL };
    const _shadowBGLDescriptor = shadowBGL.length ? { entries: shadowBGL } : null;

    return {
        _vertexWGSL,
        _fragmentWGSL,
        _meshBGLDescriptor,
        _shadowBGLDescriptor,
        _vertexBufferLayouts,
        _meshUboSpec,
        _materialUboSpec,
        _fragmentKey,
    };
}
