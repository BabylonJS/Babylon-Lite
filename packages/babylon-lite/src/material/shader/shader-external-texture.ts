import type { EngineContext } from "../../engine/engine.js";
import { bumpVisibilityEpoch } from "../../engine/engine.js";
import { wgsl } from "../../shader/wgsl.js";
import type { WgslSource } from "../../shader/wgsl.js";
import type { ExternalTexture } from "../../texture/external-texture.js";
import { getMaterialSource } from "../material-view.js";
import { _assertShaderIdentifier, _assertUniqueShaderName, type ShaderExternalTextureSlot, type ShaderMaterial } from "./shader-material.js";
import { _installShaderExternalTexturePipelineResolver } from "./shader-pipeline.js";
import { _installShaderExternalTextureBindingResolver } from "./shader-renderable.js";

let externalTextureSamplers: WeakMap<GPUDevice, GPUSampler> | null = null;

function getExternalTextureSampler(device: GPUDevice): GPUSampler {
    const samplers = (externalTextureSamplers ??= new WeakMap());
    let sampler = samplers.get(device);
    if (!sampler) {
        samplers.set(device, (sampler = device.createSampler({})));
    }
    return sampler;
}

function createExternalTextureSlots(names: readonly string[], usedNames: Set<string>): Map<string, ShaderExternalTextureSlot> {
    const slots = new Map<string, ShaderExternalTextureSlot>();
    for (const name of names) {
        _assertShaderIdentifier("external texture", name);
        _assertUniqueShaderName(usedNames, "external texture", name);
        _assertUniqueShaderName(usedNames, "external texture", `${name}Sampler`);
        slots.set(name, { name, current: null });
    }
    return slots;
}

function getExternalTextureSlots(material: ShaderMaterial): Map<string, ShaderExternalTextureSlot> {
    material = getMaterialSource(material) as ShaderMaterial;
    let slots = material._externalTextureSlots;
    if (!slots) {
        const usedNames = new Set<string>();
        for (const decl of material.uniformDecls) {
            usedNames.add(decl.name);
        }
        for (const decl of material.samplerDecls) {
            usedNames.add(decl.name);
            usedNames.add(`${decl.name}Sampler`);
        }
        for (const decl of material.storageBufferDecls) {
            usedNames.add(decl.name);
        }
        for (const define of material.defines) {
            usedNames.add(define.name);
        }
        material._externalTextureSlots = slots = createExternalTextureSlots(material._externalTextureDecls ?? [], usedNames);
    }
    installExternalTextureResolvers();
    return slots;
}

function appendExternalTextureLayout(entries: GPUBindGroupLayoutEntry[], nextBinding: number, visibility: GPUShaderStageFlags, material: ShaderMaterial): number {
    getExternalTextureSlots(material);
    for (const _name of material._externalTextureDecls ?? []) {
        entries.push({ binding: nextBinding++, visibility, externalTexture: {} }, { binding: nextBinding++, visibility, sampler: { type: "filtering" } });
    }
    return nextBinding;
}

function appendExternalTexturePrelude(source: WgslSource, nextBinding: number, material: ShaderMaterial): readonly [WgslSource, number] {
    for (const name of material._externalTextureDecls ?? []) {
        source = wgsl`${source}@group(1) @binding(${nextBinding++}) var ${name}: texture_external;
@group(1) @binding(${nextBinding++}) var ${name}Sampler: sampler;
`;
    }
    return [source, nextBinding];
}

function appendExternalTextureBindings(engine: EngineContext, material: ShaderMaterial, entries: GPUBindGroupEntry[], nextBinding: number): number {
    const slots = getExternalTextureSlots(material);
    for (const name of material._externalTextureDecls ?? []) {
        const texture = slots.get(name)?.current;
        if (!texture) {
            throw new Error(`ShaderMaterial: external texture "${name}" has no source. Call setShaderExternalTexture() before rendering.`);
        }
        if (texture.video.readyState < texture.video.HAVE_CURRENT_DATA) {
            throw new Error(`ShaderMaterial: external texture "${name}" is not ready.`);
        }
        entries.push(
            { binding: nextBinding++, resource: engine._device.importExternalTexture({ source: texture.video }) },
            { binding: nextBinding++, resource: getExternalTextureSampler(engine._device) }
        );
    }
    return nextBinding;
}

let resolversInstalled = false;

function installExternalTextureResolvers(): void {
    if (resolversInstalled) {
        return;
    }
    _installShaderExternalTexturePipelineResolver({ layout: appendExternalTextureLayout, prelude: appendExternalTexturePrelude });
    _installShaderExternalTextureBindingResolver({
        active: (material) => !!material._externalTextureDecls?.length,
        bind: appendExternalTextureBindings,
        refresh(engine, material, packet, createBindGroup) {
            if (material._externalTextureDecls?.length) {
                packet._bindGroup = createBindGroup(engine, material, packet.systemUBO);
            }
        },
    });
    resolversInstalled = true;
}

/** Bind (or clear) a caller-owned video external texture. */
export function setShaderExternalTexture(material: ShaderMaterial, name: string, texture: ExternalTexture | null): void {
    material = getMaterialSource(material) as ShaderMaterial;
    const slot = getExternalTextureSlots(material).get(name);
    if (!slot) {
        throw new Error(`ShaderMaterial: external texture "${name}" was not declared.`);
    }
    if (slot.current !== texture) {
        slot.current = texture;
        material._resourceVersion++;
        bumpVisibilityEpoch();
    }
}

/** Get the external texture currently bound to a declared external-texture slot. */
export function getShaderExternalTexture(material: ShaderMaterial, name: string): ExternalTexture | null {
    const slot = getExternalTextureSlots(material).get(name);
    if (!slot) {
        throw new Error(`ShaderMaterial: external texture "${name}" was not declared.`);
    }
    return slot.current;
}
