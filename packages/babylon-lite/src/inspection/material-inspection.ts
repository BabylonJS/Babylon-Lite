import type { Material } from "../material/material.js";
import { markMaterialUboDirty } from "../material/material-dirty.js";
import { rebuildMaterial } from "../material/material-rebuild.js";
import { isMaterialView } from "../material/material-view.js";
import type { SceneContext } from "../scene/scene-core.js";
import type {
    AppliedMaterialMutationClass,
    InspectionValue,
    MaterialInspection,
    MaterialInspectionAccess,
    MaterialInspectionEdit,
    MaterialInspectionMutationResult,
    MaterialInspectionMutationScope,
    MaterialInspectionProperty,
    MaterialInspectionPropertyId,
    MaterialInspectionPropertyValue,
    MaterialTextureBinding,
    MaterialTextureBindingId,
    MaterialTextureMutation,
} from "./inspection-types.js";
import { nodeMaterialInspectionDescriptor } from "./node-material-inspection.js";
import { pbrMaterialInspectionDescriptor } from "./pbr-material-inspection.js";
import { shaderMaterialInspectionDescriptor } from "./shader-material-inspection.js";
import { standardMaterialInspectionDescriptor } from "./standard-material-inspection.js";

/** @internal Family-owned inspection data before the common layer copies it into a public snapshot. */
export interface MaterialInspectionFamilySnapshot {
    readonly properties: readonly MaterialInspectionProperty[];
    readonly textureBindings: readonly MaterialTextureBinding[];
}

/**
 * @internal A side-effect-free mutation plan. `apply` is the transaction's only
 * mutation step, allowing the common layer to validate scene ownership first.
 */
export interface MaterialInspectionMutationPlan {
    readonly mutation: AppliedMaterialMutationClass;
    readonly invalidationOwned?: boolean;
    readonly rebuildMaterial?: boolean;
    readonly frameGraphParticipationChanged?: boolean;
    readonly apply: () => void | Promise<void>;
}

/** @internal Family descriptor seam used by the family inspection modules. */
export interface MaterialInspectionFamilyDescriptor {
    readonly inspect: (source: Material) => MaterialInspectionFamilySnapshot;
    readonly preparePropertyMutation?: (
        source: Material,
        property: MaterialInspectionProperty,
        value: MaterialInspectionPropertyValue
    ) => MaterialInspectionMutationPlan | Promise<MaterialInspectionMutationPlan>;
    readonly prepareTextureMutation?: (
        source: Material,
        binding: MaterialTextureBinding,
        mutation: MaterialTextureMutation
    ) => MaterialInspectionMutationPlan | Promise<MaterialInspectionMutationPlan>;
}

interface ResolvedMaterial {
    readonly source: Material;
    readonly isView: boolean;
}

/** Inspect a material through its canonical family descriptor. */
export function inspectMaterial(material: Material): MaterialInspection {
    return inspectMaterialWithFamily(material, getMaterialInspectionDescriptor(material));
}

/** Return the material's canonical named bindings. Unknown families return none. */
export function getMaterialTextureBindings(material: Material): readonly MaterialTextureBinding[] {
    return inspectMaterial(material).textureBindings;
}

/** Change a common or family material property through its canonical descriptor. */
export function setMaterialInspectionProperty(
    scope: MaterialInspectionMutationScope,
    material: Material,
    property: MaterialInspectionPropertyId,
    value: MaterialInspectionPropertyValue
): Promise<MaterialInspectionMutationResult> {
    return setMaterialInspectionPropertyWithFamily(scope, material, property, value, getMaterialInspectionDescriptor(material));
}

/** Change a named binding through its canonical family descriptor. */
export function setMaterialInspectionTexture(
    scope: MaterialInspectionMutationScope,
    material: Material,
    binding: MaterialTextureBindingId,
    mutation: MaterialTextureMutation
): Promise<MaterialInspectionMutationResult> {
    return setMaterialInspectionTextureWithFamily(scope, material, binding, mutation, getMaterialInspectionDescriptor(material));
}

function getMaterialInspectionDescriptor(material: Material): MaterialInspectionFamilyDescriptor | undefined {
    const source = resolveMaterial(material).source;
    switch (readMaterialFamily(source)) {
        case "standard":
            return standardMaterialInspectionDescriptor;
        case "pbr":
            return pbrMaterialInspectionDescriptor;
        case "shader":
            return shaderMaterialInspectionDescriptor;
        case "node":
            return nodeMaterialInspectionDescriptor;
        default:
            return undefined;
    }
}

/** @internal Build a copied common/family snapshot without retaining mutable tuple or capability arrays. */
export function inspectMaterialWithFamily(material: Material, descriptor?: MaterialInspectionFamilyDescriptor): MaterialInspection {
    const resolved = resolveMaterial(material);
    const family = readMaterialFamily(resolved.source);
    const commonProperties = createCommonProperties(resolved.source);
    const familySnapshot = inspectFamilySafely(resolved.source, descriptor);
    const properties = commonProperties.concat(familySnapshot.properties.filter((property) => property.id !== "material.name").map((property) => copyInspectionProperty(property)));
    return {
        source: resolved.source,
        family,
        displayName: getMaterialDisplayName(resolved.source, family),
        isView: resolved.isView,
        properties,
        textureBindings: familySnapshot.textureBindings.map((binding) => copyTextureBinding(binding)),
    };
}

/** @internal Execute a common or family property transaction. */
export async function setMaterialInspectionPropertyWithFamily(
    scope: MaterialInspectionMutationScope,
    material: Material,
    propertyId: MaterialInspectionPropertyId,
    value: MaterialInspectionPropertyValue,
    descriptor?: MaterialInspectionFamilyDescriptor
): Promise<MaterialInspectionMutationResult> {
    const inspection = inspectMaterialWithFamily(material, descriptor);
    const property = findInspectionProperty(inspection.properties, propertyId);
    const access = requireEditable(property.access, `Property "${propertyId}"`);
    const candidate = validatePropertyValue(property, value);

    if (property.value.state === "present" && sameInspectionValue(property.value.value, candidate)) {
        return unchangedResult(access);
    }

    if (propertyId === "material.name") {
        (inspection.source as { name?: string }).name = candidate as string;
        return { changed: true, mutation: "A", postMutation: "none" };
    }

    const prepare = descriptor?.preparePropertyMutation;
    if (!prepare) {
        throw new Error(`Property "${propertyId}" is stale or has no mutation implementation.`);
    }
    const plan = await prepare(inspection.source, property, candidate);
    return executeMutationPlan(scope, inspection.source, access, plan);
}

/** @internal Execute a family binding transaction after common capability validation. */
export async function setMaterialInspectionTextureWithFamily(
    scope: MaterialInspectionMutationScope,
    material: Material,
    bindingId: MaterialTextureBindingId,
    mutation: MaterialTextureMutation,
    descriptor?: MaterialInspectionFamilyDescriptor
): Promise<MaterialInspectionMutationResult> {
    const inspection = inspectMaterialWithFamily(material, descriptor);
    const binding = findTextureBinding(inspection.textureBindings, bindingId);
    const access = requireEditable(binding.mutation, `Texture binding "${bindingId}"`);

    if (!binding.directions.includes(mutation.direction)) {
        throw new Error(`Texture binding "${bindingId}" does not support "${mutation.direction}".`);
    }
    if (mutation.direction === "assign") {
        if (binding.value.state !== "absent") {
            throw new Error(`Texture binding "${bindingId}" is no longer empty.`);
        }
        requireTextureObject(bindingId, mutation.texture);
    } else if (mutation.direction === "replace") {
        if (binding.value.state !== "present") {
            throw new Error(`Texture binding "${bindingId}" no longer has a value to replace.`);
        }
        requireTextureObject(bindingId, mutation.texture);
        if (binding.value.value.entity === mutation.texture) {
            return unchangedResult(access);
        }
    } else if (binding.value.state !== "present") {
        throw new Error(`Texture binding "${bindingId}" no longer has a value to clear.`);
    }

    const prepare = descriptor?.prepareTextureMutation;
    if (!prepare) {
        throw new Error(`Texture binding "${bindingId}" is stale or has no mutation implementation.`);
    }
    const plan = await prepare(inspection.source, binding, mutation);
    return executeMutationPlan(scope, inspection.source, access, plan);
}

/** @internal Validate and copy a property value before it reaches family code. */
export function validateMaterialInspectionPropertyValue(property: MaterialInspectionProperty, value: unknown): MaterialInspectionPropertyValue {
    return validatePropertyValue(property, value);
}

/** @internal Compare scalar and tuple inspection values without coercion. */
export function sameMaterialInspectionValue(a: MaterialInspectionPropertyValue, b: MaterialInspectionPropertyValue): boolean {
    return sameInspectionValue(a, b);
}

function inspectFamilySafely(source: Material, descriptor?: MaterialInspectionFamilyDescriptor): MaterialInspectionFamilySnapshot {
    if (!descriptor) {
        return { properties: [], textureBindings: [] };
    }
    try {
        const snapshot = descriptor.inspect(source);
        if (!snapshot || !Array.isArray(snapshot.properties) || !Array.isArray(snapshot.textureBindings)) {
            return { properties: [], textureBindings: [] };
        }
        return snapshot;
    } catch {
        return { properties: [], textureBindings: [] };
    }
}

function resolveMaterial(material: Material): ResolvedMaterial {
    if (!isObject(material)) {
        return { source: material, isView: false };
    }
    try {
        if (isMaterialView(material) && isObject(material.source) && material.source !== material) {
            return { source: material.source, isView: true };
        }
    } catch {
        // A malformed third-party value remains inspectable as an unknown source.
    }
    return { source: material, isView: false };
}

function readMaterialFamily(material: Material): string | undefined {
    if (!isObject(material)) {
        return undefined;
    }
    try {
        const family = (material as { _buildGroup?: { _materialFamily?: unknown } })._buildGroup?._materialFamily;
        return typeof family === "string" && family.length > 0 ? family : undefined;
    } catch {
        return undefined;
    }
}

function getMaterialDisplayName(material: Material, family: string | undefined): string {
    if (isObject(material)) {
        try {
            const name = (material as { name?: unknown }).name;
            if (typeof name === "string" && name.length > 0) {
                return name;
            }
        } catch {
            // Fall through to the stable family identity.
        }
    }
    switch (family) {
        case "standard":
            return "Standard Material";
        case "pbr":
            return "Pbr Material";
        case "shader":
            return "Shader Material";
        case "node":
            return "Node Material";
        default:
            return "Material";
    }
}

function createCommonProperties(material: Material): MaterialInspectionProperty[] {
    if (!isObject(material)) {
        return [];
    }
    let value: InspectionValue<MaterialInspectionPropertyValue>;
    try {
        const name = (material as { name?: unknown }).name;
        value = name === undefined || typeof name === "string" ? { state: "present", value: name ?? "" } : { state: "unsupported", reason: "Material name is not a string." };
    } catch {
        value = { state: "unsupported", reason: "Material name is unavailable." };
    }
    return [
        {
            id: "material.name",
            section: "general",
            label: "Name",
            valueType: "string",
            value,
            access: { access: "read-write", mutation: "A", postMutation: "none" },
        },
    ];
}

function copyInspectionProperty(property: MaterialInspectionProperty): MaterialInspectionProperty {
    let value = property.value;
    if (value.state === "present") {
        try {
            value = { state: "present", value: validatePropertyValue(property, value.value) };
        } catch (error) {
            value = { state: "unsupported", reason: error instanceof Error ? error.message : `Property "${property.id}" has an invalid value.` };
        }
    } else if (value.state === "unsupported") {
        value = { state: "unsupported", reason: value.reason };
    } else {
        value = { state: "absent" };
    }
    return {
        ...property,
        value,
        access: copyAccess(property.access),
        options: property.options?.map((option) => ({ value: option.value, label: option.label })),
    };
}

function copyTextureBinding(binding: MaterialTextureBinding): MaterialTextureBinding {
    const value =
        binding.value.state === "present"
            ? { state: "present" as const, value: { entity: binding.value.value.entity, kind: binding.value.value.kind } }
            : binding.value.state === "unsupported"
              ? { state: "unsupported" as const, reason: binding.value.reason }
              : { state: "absent" as const };
    const transform =
        binding.transform.state === "present"
            ? { state: "present" as const, value: { ...binding.transform.value } }
            : binding.transform.state === "unsupported"
              ? { state: "unsupported" as const, reason: binding.transform.reason }
              : { state: "absent" as const };
    return {
        ...binding,
        value,
        acceptedKinds: binding.acceptedKinds.slice(),
        directions: binding.directions.slice(),
        mutation: copyAccess(binding.mutation),
        transform,
    };
}

function copyAccess(access: MaterialInspectionAccess): MaterialInspectionAccess {
    if (access.access === "read-only") {
        return { access: "read-only", reason: access.reason };
    }
    return {
        access: "read-write",
        mutation: access.mutation,
        postMutation: access.postMutation,
        number: access.number ? { ...access.number } : undefined,
    };
}

function findInspectionProperty(properties: readonly MaterialInspectionProperty[], id: MaterialInspectionPropertyId): MaterialInspectionProperty {
    let found: MaterialInspectionProperty | undefined;
    for (const property of properties) {
        if (property.id === id) {
            if (found) {
                throw new Error(`Property "${id}" is ambiguous.`);
            }
            found = property;
        }
    }
    if (!found) {
        throw new Error(`Property "${id}" is stale or unsupported for this material.`);
    }
    return found;
}

function findTextureBinding(bindings: readonly MaterialTextureBinding[], id: MaterialTextureBindingId): MaterialTextureBinding {
    let found: MaterialTextureBinding | undefined;
    for (const binding of bindings) {
        if (binding.id === id) {
            if (found) {
                throw new Error(`Texture binding "${id}" is ambiguous.`);
            }
            found = binding;
        }
    }
    if (!found) {
        throw new Error(`Texture binding "${id}" is stale or unsupported for this material.`);
    }
    return found;
}

function requireEditable(access: MaterialInspectionAccess, subject: string): MaterialInspectionEdit {
    if (access.access !== "read-write") {
        throw new Error(`${subject} is read-only${access.reason ? `: ${access.reason}` : "."}`);
    }
    return access;
}

function validatePropertyValue(property: MaterialInspectionProperty, value: unknown): MaterialInspectionPropertyValue {
    switch (property.valueType) {
        case "string":
        case "summary":
            if (typeof value !== "string") {
                throw new TypeError(`Property "${property.id}" requires a string.`);
            }
            return value;
        case "boolean":
            if (typeof value !== "boolean") {
                throw new TypeError(`Property "${property.id}" requires a boolean.`);
            }
            return value;
        case "number":
            return validateNumber(property, value);
        case "enum": {
            if ((typeof value !== "string" && typeof value !== "number") || (typeof value === "number" && !Number.isFinite(value))) {
                throw new TypeError(`Property "${property.id}" requires a finite string or number enum value.`);
            }
            if (!property.options?.some((option) => Object.is(option.value, value))) {
                throw new RangeError(`Property "${property.id}" does not accept enum value "${String(value)}".`);
            }
            return value;
        }
        case "vec2":
            return validateTuple(property.id, value, 2);
        case "vec3":
            return validateTuple(property.id, value, 3);
        case "vec4":
            return validateTuple(property.id, value, 4);
        case "mat4":
            return validateTuple(property.id, value, 16);
    }
}

function validateNumber(property: MaterialInspectionProperty, value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`Property "${property.id}" requires a finite number.`);
    }
    const constraint = property.access.access === "read-write" ? property.access.number : undefined;
    if (constraint?.integer && !Number.isInteger(value)) {
        throw new TypeError(`Property "${property.id}" requires an integer.`);
    }
    if (constraint?.min !== undefined && value < constraint.min) {
        throw new RangeError(`Property "${property.id}" must be at least ${constraint.min}.`);
    }
    if (constraint?.max !== undefined && value > constraint.max) {
        throw new RangeError(`Property "${property.id}" must be at most ${constraint.max}.`);
    }
    return value;
}

function validateTuple(id: MaterialInspectionPropertyId, value: unknown, length: 2 | 3 | 4 | 16): MaterialInspectionPropertyValue {
    const tuple = Array.isArray(value) ? value : ArrayBuffer.isView(value) && "length" in value ? Array.from(value as unknown as ArrayLike<unknown>) : undefined;
    if (!tuple || tuple.length !== length) {
        throw new TypeError(`Property "${id}" requires a ${length}-component tuple.`);
    }
    const copy = tuple.slice();
    if (copy.some((component) => typeof component !== "number" || !Number.isFinite(component))) {
        throw new TypeError(`Property "${id}" requires finite tuple components.`);
    }
    return copy as unknown as MaterialInspectionPropertyValue;
}

function sameInspectionValue(a: MaterialInspectionPropertyValue, b: MaterialInspectionPropertyValue): boolean {
    if (!Array.isArray(a) || !Array.isArray(b)) {
        return Object.is(a, b);
    }
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (!Object.is(a[i], b[i])) {
            return false;
        }
    }
    return true;
}

function requireTextureObject(binding: MaterialTextureBindingId, texture: object): void {
    if (!isObject(texture)) {
        throw new TypeError(`Texture binding "${binding}" requires a texture object.`);
    }
}

function unchangedResult(access: MaterialInspectionEdit): MaterialInspectionMutationResult {
    return {
        changed: false,
        mutation: access.mutation === "U/R" ? "U" : access.mutation,
        postMutation: "none",
    };
}

async function executeMutationPlan(
    scope: MaterialInspectionMutationScope,
    source: Material,
    access: MaterialInspectionEdit,
    plan: MaterialInspectionMutationPlan
): Promise<MaterialInspectionMutationResult> {
    validateMutationPlan(access, plan);
    const rebuildRequested = plan.mutation === "R" || plan.rebuildMaterial === true;
    const scenes = rebuildRequested ? getUniqueOwningScenes(scope, source) : [];

    await plan.apply();

    if (plan.mutation === "U" && !plan.invalidationOwned) {
        markMaterialUboDirty(source);
    }
    if (rebuildRequested) {
        await Promise.all(
            scenes.map((scene) =>
                rebuildMaterial(scene, source, {
                    awaitCompletion: true,
                    rebuildViews: true,
                    rebuildFrameGraph: plan.frameGraphParticipationChanged === true,
                })
            )
        );
    }

    return {
        changed: true,
        mutation: plan.mutation,
        postMutation: rebuildRequested ? (plan.frameGraphParticipationChanged ? "rebuild-material-and-frame-graph" : "rebuild-material") : "none",
    };
}

function validateMutationPlan(access: MaterialInspectionEdit, plan: MaterialInspectionMutationPlan): void {
    if (!plan || typeof plan.apply !== "function") {
        throw new Error("Material mutation implementation returned an invalid transaction plan.");
    }
    if (access.mutation === "U/R") {
        if (plan.mutation !== "U" && plan.mutation !== "R") {
            throw new Error(`Material mutation resolved "U/R" to invalid class "${plan.mutation}".`);
        }
    } else if (plan.mutation !== access.mutation) {
        throw new Error(`Material mutation class "${plan.mutation}" does not match declared class "${access.mutation}".`);
    }
    const rebuildRequested = plan.mutation === "R" || plan.rebuildMaterial === true;
    if (rebuildRequested && access.postMutation === "none") {
        throw new Error("Material mutation requested an undeclared material rebuild.");
    }
    if (plan.frameGraphParticipationChanged && access.postMutation !== "rebuild-material-and-frame-graph") {
        throw new Error("Material mutation requested an undeclared frame-graph rebuild.");
    }
}

/** @internal Validate and deduplicate the explicit scene scope used by inspection mutations. */
export function _validateInspectionScopeScenes(scope: MaterialInspectionMutationScope): SceneContext[] {
    if (!scope || !Array.isArray(scope.scenes)) {
        throw new TypeError("Material mutation scope must provide an array of scenes.");
    }
    const scenes: SceneContext[] = [];
    for (const scene of scope.scenes) {
        if (!scenes.includes(scene)) {
            scenes.push(scene);
        }
    }
    for (const scene of scenes) {
        if (!isObject(scene) || !Array.isArray(scene.meshes)) {
            throw new TypeError("Material mutation scope contains an invalid scene.");
        }
    }
    return scenes;
}

function getUniqueOwningScenes(scope: MaterialInspectionMutationScope, source: Material): SceneContext[] {
    const scenes = _validateInspectionScopeScenes(scope);
    if (scenes.length === 0) {
        throw new Error("Material rebuild requires at least one owning scene.");
    }
    for (const scene of scenes) {
        if (!scene.meshes.some((mesh) => mesh?.material && resolveMaterial(mesh.material).source === source)) {
            throw new Error("Material is not reachable from every scene in the mutation scope.");
        }
    }
    return scenes;
}

function isObject(value: unknown): value is object {
    return typeof value === "object" && value !== null;
}
