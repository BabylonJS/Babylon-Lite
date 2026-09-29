import type { EngineContext } from "../../engine/engine.js";
import { bumpVisibilityEpoch } from "../../engine/engine.js";
import { wgsl } from "../../shader/wgsl.js";
import type { ExternalTexture } from "../../texture/external-texture.js";
import {
    _assertShaderIdentifier,
    _assertUniqueShaderName,
    _installShaderExternalTextureResolver,
    type ShaderExternalTextureSlot,
    type ShaderMaterial,
} from "./shader-material.js";
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
    if (material._externalTextureSlots) {
        return material._externalTextureSlots;
    }
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
    return (material._externalTextureSlots = createExternalTextureSlots(material._externalTextureDecls ?? [], usedNames));
}

_installShaderExternalTextureResolver((names, usedNames) => {
    if (!names?.length) {
        return undefined;
    }
    return { _externalTextureSlots: createExternalTextureSlots(names, usedNames) };
});

_installShaderExternalTexturePipelineResolver({
    layout(entries, nextBinding, visibility, material) {
        getExternalTextureSlots(material);
        for (const _name of material._externalTextureDecls ?? []) {
            entries.push(
                { binding: nextBinding++, visibility, externalTexture: {} },
                { binding: nextBinding++, visibility, sampler: { type: "filtering" } }
            );
        }
        return nextBinding;
    },
    prelude(source, nextBinding, material) {
        for (const name of material._externalTextureDecls ?? []) {
            source = wgsl`${source}@group(1) @binding(${nextBinding++}) var ${name}: texture_external;
@group(1) @binding(${nextBinding++}) var ${name}Sampler: sampler;
`;
        }
        return [source, nextBinding];
    },
});

_installShaderExternalTextureBindingResolver((engine: EngineContext, material, entries, nextBinding) => {
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
});

/** Bind (or clear) a caller-owned video external texture. */
export function setShaderExternalTexture(material: ShaderMaterial, name: string, texture: ExternalTexture | null): void {
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
