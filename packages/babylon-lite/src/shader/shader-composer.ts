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
        if (byId.has(f.id)) {
            throw new Error(`Duplicate fragment id: "${f.id}"`);
        }
        byId.set(f.id, f);
    }
    const inDeg = new Map<string, number>();
    const deps = new Map<string, string[]>();
    for (const f of fragments) {
        if (!inDeg.has(f.id)) {
            inDeg.set(f.id, 0);
        }
        for (const d of f.dependencies ?? []) {
            if (!byId.has(d)) {
                throw new Error(`Fragment "${f.id}" depends on unknown fragment "${d}"`);
            }
            inDeg.set(f.id, (inDeg.get(f.id) ?? 0) + 1);
            let arr = deps.get(d);
            if (!arr) {
                arr = [];
                deps.set(d, arr);
            }
            arr.push(f.id);
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
        throw new Error("Cycle detected in fragment dependencies");
    }
    return out;
}

function dedup<T extends { name: string }>(base: readonly T[], extra: readonly T[]): T[] {
    const seen = new Set<string>();
    const all: T[] = [];
    for (const v of base) {
        if (!seen.has(v.name)) {
            seen.add(v.name);
            all.push(v);
        }
    }
    for (const v of extra) {
        if (!seen.has(v.name)) {
            seen.add(v.name);
            all.push(v);
        }
    }
    return all;
}

function bglEntry(binding: number, decl: BindingDecl): GPUBindGroupLayoutEntry {
    const e: GPUBindGroupLayoutEntry = { binding, visibility: decl.visibility };
    switch (decl.type.kind) {
        case "uniform-buffer":
            e.buffer = { type: "uniform" };
            break;
        case "texture": {
            const def = decl.type.textureType === "texture_depth_2d" ? "depth" : decl.type.textureType === "texture_2d<u32>" ? "uint" : "float";
            e.texture = { sampleType: (decl.type.sampleType ?? def) as GPUTextureSampleType, viewDimension: decl.type.textureType.includes("cube") ? "cube" : "2d" };
            break;
        }
        case "sampler":
            e.sampler = { type: decl.type.samplerType === "sampler_comparison" ? "comparison" : "filtering" };
            break;
        case "storage-texture":
            e.storageTexture = { access: decl.type.access as GPUStorageTextureAccess, format: decl.type.format as GPUTextureFormat };
            break;
    }
    return e;
}

function declWGSL(g: number, b: number, d: BindingDecl): string {
    switch (d.type.kind) {
        case "uniform-buffer":
            return `@group(${g}) @binding(${b}) var<uniform> ${d.name}: ${d.name}Uniforms;`;
        case "texture":
            return `@group(${g}) @binding(${b}) var ${d.name}: ${d.type.textureType};`;
        case "sampler":
            return `@group(${g}) @binding(${b}) var ${d.name}: ${d.type.samplerType};`;
        case "storage-texture":
            return `@group(${g}) @binding(${b}) var ${d.name}: texture_storage_2d<${d.type.format}, ${d.type.access}>;`;
    }
}

const SLOT_RE = /\/\*([A-Z_0-9]+)\*\//g;
function injectSlots(tpl: string, sorted: readonly ShaderFragment[], key: "fragmentSlots" | "vertexSlots"): string {
    return tpl.replace(SLOT_RE, (_, slot: string) => {
        const parts: string[] = [];
        for (const f of sorted) {
            const s = f[key] as Partial<Record<string, string>> | undefined;
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
        if (f.vertexAttributes) {
            fragAttrs.push(...f.vertexAttributes);
        }
        if (f.varyings) {
            fragVaryings.push(...f.varyings);
        }
        if (f.helperFunctions) {
            helpers.push(f.helperFunctions);
        }
        if (f.vertexHelperFunctions) {
            vHelpers.push(f.vertexHelperFunctions);
        }
        for (const b of f.vertexBuiltins ?? []) {
            vBuiltins.push(`@builtin(${b.builtin}) ${b.name}: ${b.type},`);
        }
    }

    // Vertex attributes + layouts
    const allAttrs = dedup(template.baseVertexAttributes, fragAttrs);
    const inputLines: string[] = [];
    const layouts: GPUVertexBufferLayout[] = [];
    const groups = new Map<string, { loc: number; off: number; fmt: GPUVertexFormat }[]>();
    const firstOfGroup = new Map<string, VertexAttribute>();
    for (let i = 0; i < allAttrs.length; i++) {
        const a = allAttrs[i]!;
        inputLines.push(`@location(${i}) ${a.name}: ${a.type},`);
        if (a.bufferGroup) {
            if (!groups.has(a.bufferGroup)) {
                groups.set(a.bufferGroup, []);
                firstOfGroup.set(a.bufferGroup, a);
            }
            groups.get(a.bufferGroup)!.push({ loc: i, off: a.offset ?? 0, fmt: a.gpuFormat });
        } else {
            layouts.push({ arrayStride: a.arrayStride, stepMode: a.stepMode ?? "vertex", attributes: [{ shaderLocation: i, offset: a.offset ?? 0, format: a.gpuFormat }] });
        }
    }
    for (const [grp, attrs] of groups) {
        const f = firstOfGroup.get(grp)!;
        layouts.push({ arrayStride: f.arrayStride, stepMode: f.stepMode ?? "vertex", attributes: attrs.map((a) => ({ shaderLocation: a.loc, offset: a.off, format: a.fmt })) });
    }
    let nextLoc = allAttrs.length;
    for (const f of sorted) {
        if (f.pipelineVertexBuffers) {
            const r = f.pipelineVertexBuffers(nextLoc);
            layouts.push(...r.buffers);
            nextLoc = r.nextLoc;
        }
    }

    // Varyings
    const allVary = dedup(template.baseVaryings, fragVaryings);
    const varyBody = `@builtin(position) clipPos: vec4<f32>,\n` + allVary.map((v, i) => `@location(${i}) ${v.name}: ${v.type},`).join("\n");

    // UBO layouts
    const hasMaterialUbo = !!(template.baseMaterialUboFields && template.baseMaterialUboFields.length > 0);
    const meshFields = [...template.baseMeshUboFields];
    const materialFields = hasMaterialUbo ? [...template.baseMaterialUboFields] : [];
    const fragUboOffsets = new Map<string, number>();
    for (const f of sorted) {
        if (f.uboFields?.length) {
            if (hasMaterialUbo) {
                fragUboOffsets.set(f.id, materialFields.length);
                materialFields.push(...f.uboFields);
            } else {
                fragUboOffsets.set(f.id, meshFields.length);
                meshFields.push(...f.uboFields);
            }
        }
    }
    const meshUboSpec = computeUboLayout(meshFields);
    const materialUboSpec = hasMaterialUbo ? computeUboLayout(materialFields) : undefined;
    const uboSpecForFragOffsets = hasMaterialUbo ? materialUboSpec! : meshUboSpec;
    const fragFields = hasMaterialUbo ? materialFields : meshFields;
    const fragmentUboOffsets = new Map<string, number>();
    for (const [id, idx] of fragUboOffsets) {
        const name = fragFields[idx]?.name;
        if (name) {
            fragmentUboOffsets.set(id, (uboSpecForFragOffsets.offsets.get(name) ?? 0) / 4);
        }
    }

    // Bindings
    const meshBGL: GPUBindGroupLayoutEntry[] = [{ binding: 0, visibility: STAGE_VERTEX | STAGE_FRAGMENT, buffer: { type: "uniform" } }];
    if (hasMaterialUbo) {
        meshBGL.push({ binding: 1, visibility: STAGE_FRAGMENT, buffer: { type: "uniform" } });
    }
    const shadowBGL: GPUBindGroupLayoutEntry[] = [];
    const vDecls: string[] = [];
    const fDecls: string[] = [];
    const fragBindOff = new Map<string, number>();
    let mb = hasMaterialUbo ? 2 : 1,
        sb = 0;

    function addBinding(d: BindingDecl, fragId: string | null, _isVertex: boolean) {
        const isShadow = d.group === "shadow";
        const b = isShadow ? sb++ : mb++;
        const g = isShadow ? 2 : 1;
        (isShadow ? shadowBGL : meshBGL).push(bglEntry(b, d));
        if (fragId && !fragBindOff.has(fragId + (isShadow ? ":shadow" : ""))) {
            fragBindOff.set(fragId + (isShadow ? ":shadow" : ""), b);
        }
        const w = declWGSL(g, b, d);
        if (d.visibility & STAGE_VERTEX) {
            vDecls.push(w);
        }
        if (d.visibility & STAGE_FRAGMENT) {
            fDecls.push(w);
        }
    }

    for (const d of template.baseVertexBindings ?? []) {
        addBinding(d, null, true);
    }
    for (const f of sorted) {
        for (const d of f.vertexBindings ?? []) {
            addBinding(d, f.id, true);
        }
    }
    for (const d of template.baseBindings ?? []) {
        addBinding(d, null, false);
    }
    for (const f of sorted) {
        for (const d of (f.bindings ?? []).filter((b) => (b.group ?? "mesh") === "mesh")) {
            addBinding(d, f.id, false);
        }
    }
    for (const f of sorted) {
        for (const d of (f.bindings ?? []).filter((b) => b.group === "shadow")) {
            addBinding(d, f.id, false);
        }
    }

    const fragKey = sorted.map((f) => f.id).join("|");
    const vParams = (vBuiltins.length ? vBuiltins.join("\n") + "\n" : "") + inputLines.join("\n");
    const meshStruct = `struct MeshUniforms {\n${meshUboSpec.structBody}\n}`;
    const materialStruct = materialUboSpec ? `\nstruct MaterialUniforms {\n${materialUboSpec.structBody}\n}\n@group(1) @binding(1) var<uniform> material: MaterialUniforms;` : "";

    let vertexWGSL = template.vertexTemplate;
    vertexWGSL = vertexWGSL.replace("/*SU*/", SCENE_UBO_WGSL);
    vertexWGSL = vertexWGSL.replace("/*MU*/", meshStruct);
    vertexWGSL = vertexWGSL.replace("/*VI*/", `struct VertexInput {\n${inputLines.join("\n")}\n}`);
    vertexWGSL = vertexWGSL.replace("/*VO*/", `struct VertexOutput {\n${varyBody}\n}`);
    vertexWGSL = vertexWGSL.replace("/*VD*/", vDecls.join("\n"));
    vertexWGSL = vertexWGSL.replace("/*VP*/", vParams);
    vertexWGSL = vertexWGSL.replace("/*VH*/", vHelpers.join("\n"));
    vertexWGSL = injectSlots(vertexWGSL, sorted, "vertexSlots");

    let fragmentWGSL = template.fragmentTemplate;
    fragmentWGSL = fragmentWGSL.replace("/*SU*/", SCENE_UBO_WGSL);
    fragmentWGSL = fragmentWGSL.replace("/*MU*/", meshStruct + materialStruct);
    fragmentWGSL = fragmentWGSL.replace("/*FI*/", `struct FragmentInput {\n${varyBody}\n}`);
    fragmentWGSL = fragmentWGSL.replace("/*HF*/", helpers.join("\n"));
    fragmentWGSL = fragmentWGSL.replace("/*FB*/", fDecls.join("\n"));
    fragmentWGSL = injectSlots(fragmentWGSL, sorted, "fragmentSlots");

    return {
        vertexWGSL,
        fragmentWGSL,
        meshBGLDescriptor: { entries: meshBGL },
        shadowBGLDescriptor: shadowBGL.length ? { entries: shadowBGL } : null,
        vertexBufferLayouts: layouts,
        meshUboSpec,
        materialUboSpec,
        fragmentKey: fragKey,
        fragmentUboOffsets,
        fragmentBindingOffsets: fragBindOff,
    };
}
