import type { Material } from "../material/material.js";
import type { NodeInputHandle, NodeMaterial } from "../material/node/node-material.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type {
    InspectionValue,
    MaterialInspectionAccess,
    MaterialInspectionProperty,
    MaterialInspectionPropertyValue,
    MaterialInspectionTextureReference,
    MaterialTextureBinding,
    MaterialTextureMutation,
} from "./inspection-types.js";
import type { MaterialInspectionFamilyDescriptor, MaterialInspectionMutationPlan } from "./material-inspection.js";

const FINITE_NUMBER = { finite: true } as const;

/** @internal Side-effect-free Node descriptor. Dispatcher wiring is owned by the family convergence task. */
export const nodeMaterialInspectionDescriptor: MaterialInspectionFamilyDescriptor = {
    inspect: inspectNodeMaterial,
    preparePropertyMutation: prepareNodePropertyMutation,
    prepareTextureMutation: prepareNodeTextureMutation,
};

function inspectNodeMaterial(source: Material) {
    const material = source as NodeMaterial;
    const properties: MaterialInspectionProperty[] = [];
    const textureBindings: MaterialTextureBinding[] = [];
    for (const name of Object.keys(material.inputs).sort()) {
        const handle = material.inputs[name]!;
        if (handle.type === "texture2d") {
            textureBindings.push(createTextureBinding(name, handle));
        } else {
            properties.push(createValueProperty(name, handle));
        }
    }
    return { properties, textureBindings };
}

function createValueProperty(name: string, handle: NodeInputHandle): MaterialInspectionProperty {
    const type = handle.type;
    const valueType = type === "f32" ? "number" : type === "vec2f" ? "vec2" : type === "vec3f" ? "vec3" : "vec4";
    let value: InspectionValue<MaterialInspectionPropertyValue>;
    try {
        const current = handle.value;
        const copied = copyInputValue(type, current);
        value = copied === undefined ? { state: "unsupported", reason: `Node input "${name}" has no readable ${type} value.` } : { state: "present", value: copied };
    } catch {
        value = { state: "unsupported", reason: `Node input "${name}" is unavailable.` };
    }
    return {
        id: `node.input:${name}`,
        section: "inputs",
        label: name,
        valueType,
        value,
        access: edit(type === "f32" ? FINITE_NUMBER : undefined),
    };
}

function copyInputValue(type: NodeInputHandle["type"], value: number | number[] | undefined): MaterialInspectionPropertyValue | undefined {
    if (type === "f32") {
        return typeof value === "number" ? value : undefined;
    }
    if (!Array.isArray(value)) {
        return undefined;
    }
    switch (type) {
        case "vec2f":
            return value.length === 2 ? [value[0]!, value[1]!] : undefined;
        case "vec3f":
            return value.length === 3 ? [value[0]!, value[1]!, value[2]!] : undefined;
        case "vec4f":
            return value.length === 4 ? [value[0]!, value[1]!, value[2]!, value[3]!] : undefined;
        default:
            return undefined;
    }
}

function createTextureBinding(name: string, handle: NodeInputHandle): MaterialTextureBinding {
    let texture: Texture2D | null | undefined;
    let readable = true;
    try {
        texture = handle.texture;
    } catch {
        readable = false;
    }

    const valid = texture ? isCompatibleTexture2D(texture) : false;
    const value: InspectionValue<MaterialInspectionTextureReference> = !readable
        ? { state: "unsupported", reason: `Node texture input "${name}" is unavailable.` }
        : !texture
          ? { state: "absent" }
          : valid
            ? { state: "present", value: { entity: texture, kind: "2d" } }
            : { state: "unsupported", reason: `Node texture input "${name}" contains an incompatible texture value.` };

    return {
        id: `node.texture:${name}`,
        label: name,
        value,
        acceptedKinds: ["2d"],
        sampleCategory: "float",
        viewCategory: "2d",
        directions: !readable ? [] : !texture ? ["assign"] : valid ? ["replace", "clear", "navigate"] : ["replace", "clear"],
        mutation: readable ? editForRebuild() : { access: "read-only", reason: `Node texture input "${name}" is unavailable.` },
        transform: texture ? { state: "unsupported", reason: "Node texture inputs do not use standard material UV transforms." } : { state: "absent" },
    };
}

function prepareNodePropertyMutation(source: Material, property: MaterialInspectionProperty, value: MaterialInspectionPropertyValue): MaterialInspectionMutationPlan {
    const input = findValueInput(source as NodeMaterial, property.id);
    return {
        mutation: "A",
        invalidationOwned: true,
        apply: () => {
            input.value = value as number | number[];
        },
    };
}

function prepareNodeTextureMutation(source: Material, binding: MaterialTextureBinding, mutation: MaterialTextureMutation): MaterialInspectionMutationPlan {
    const input = findTextureInput(source as NodeMaterial, binding.id);
    const texture = mutation.direction === "clear" ? null : mutation.texture;
    if (texture && !isCompatibleTexture2D(texture)) {
        throw new TypeError(`Texture binding "${binding.id}" requires a float-sampled Texture2D value.`);
    }
    return {
        mutation: "R",
        apply: () => {
            input.texture = texture as Texture2D | null;
        },
    };
}

function findValueInput(material: NodeMaterial, propertyId: MaterialInspectionProperty["id"]): NodeInputHandle {
    for (const name of Object.keys(material.inputs)) {
        const input = material.inputs[name]!;
        if (propertyId === `node.input:${name}` && input.type !== "texture2d") {
            return input;
        }
    }
    throw new Error(`Property "${propertyId}" is stale or unsupported for a Node material.`);
}

function findTextureInput(material: NodeMaterial, bindingId: MaterialTextureBinding["id"]): NodeInputHandle {
    for (const name of Object.keys(material.inputs)) {
        const input = material.inputs[name]!;
        if (bindingId === `node.texture:${name}` && input.type === "texture2d") {
            return input;
        }
    }
    throw new Error(`Texture binding "${bindingId}" is stale or unsupported for a Node material.`);
}

function isCompatibleTexture2D(texture: object): texture is Texture2D {
    try {
        const candidate = texture as Partial<Texture2D> & { readonly layers?: unknown };
        return (
            "texture" in candidate &&
            "view" in candidate &&
            "sampler" in candidate &&
            typeof candidate.width === "number" &&
            Number.isFinite(candidate.width) &&
            typeof candidate.height === "number" &&
            Number.isFinite(candidate.height) &&
            !("layers" in candidate && candidate.layers !== undefined) &&
            (candidate._sampleType === undefined || candidate._sampleType === "float")
        );
    } catch {
        return false;
    }
}

function edit(number?: typeof FINITE_NUMBER): MaterialInspectionAccess {
    return { access: "read-write", mutation: "A", postMutation: "none", number };
}

function editForRebuild(): MaterialInspectionAccess {
    return { access: "read-write", mutation: "R", postMutation: "rebuild-material" };
}
