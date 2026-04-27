/** InputBlock emitter.
 *
 *  Three modes (BJS NodeMaterialBlockConnectionPointMode):
 *    0 = Uniform   — inline value becomes a field in the node UBO.
 *    1 = Attribute — bound to a vertex attribute (position/normal/uv/...).
 *    2 = Varying   — interpolated from a system/pre-existing varying.
 *
 *  For attributes we declare the vertex attribute (dedup by name) and, if the
 *  value is consumed in fragment stage, a varying to carry it across.
 */

import type { BlockEmitter, NodeBuildState, NodeExpr, NodeValueType, Stage, NodeBlock } from "../node-types.js";
import { WGSL } from "../node-types.js";

type BjsType = number; // NodeMaterialBlockConnectionPointTypes

function bjsTypeToNodeType(t: BjsType): NodeValueType {
    // bitflags: 0x1=Float, 0x4=Vec2, 0x8=Vec3, 0x10=Vec4, 0x20=Color3, 0x40=Color4
    if (t === 0x1 || t === 0x2) {
        return "f32";
    }
    if (t === 0x4) {
        return "vec2f";
    }
    if (t === 0x8 || t === 0x20) {
        return "vec3f";
    }
    if (t === 0x10 || t === 0x40) {
        return "vec4f";
    }
    if (t === 0x80) {
        return "mat4f";
    }
    throw new Error(`InputBlock: unsupported BJS connection point type 0x${t.toString(16)}`);
}

function wgslLiteral(value: unknown, type: NodeValueType): string {
    if (type === "f32") {
        const f = typeof value === "number" ? value : 0;
        return formatFloat(f);
    }
    if (Array.isArray(value)) {
        const parts = value.map((v) => formatFloat(typeof v === "number" ? v : 0)).join(", ");
        return `${WGSL[type]}(${parts})`;
    }
    // Fallback to zero.
    if (type === "vec2f") {
        return "vec2<f32>(0.0, 0.0)";
    }
    if (type === "vec3f") {
        return "vec3<f32>(0.0, 0.0, 0.0)";
    }
    if (type === "vec4f") {
        return "vec4<f32>(0.0, 0.0, 0.0, 0.0)";
    }
    return "0.0";
}

function formatFloat(n: number): string {
    if (Number.isInteger(n)) {
        return `${n}.0`;
    }
    return `${n}`;
}

// Known mesh attributes — maps InputBlock.name → WGSL type.
const ATTRIBUTE_TYPES: Record<string, NodeValueType> = {
    position: "vec3f",
    normal: "vec3f",
    tangent: "vec4f",
    uv: "vec2f",
    uv2: "vec2f",
    color: "vec4f",
    matricesIndices: "vec4f",
    matricesWeights: "vec4f",
    matricesIndicesExtra: "vec4f",
    matricesWeightsExtra: "vec4f",
};

function emitAttribute(block: NodeBlock, stage: Stage, state: NodeBuildState): NodeExpr {
    const attrName = block.name;
    const type = ATTRIBUTE_TYPES[attrName];
    if (!type) {
        throw new Error(`InputBlock: unknown mesh attribute "${attrName}"`);
    }
    const wgslType = WGSL[type];
    // Dedup vertex attribute.
    if (!state.vertexAttributes.find((a) => a.name === attrName)) {
        state.vertexAttributes.push({
            name: attrName,
            type: wgslType,
            gpuFormat: type === "vec2f" ? "float32x2" : type === "vec3f" ? "float32x3" : "float32x4",
            arrayStride: (type === "vec2f" ? 2 : type === "vec3f" ? 3 : 4) * 4,
        });
    }
    if (stage === "vertex") {
        return { expr: `in.${attrName}`, type };
    }
    // In fragment stage — bridge through a varying (idempotent).
    const vname = `v_attr_${attrName}`;
    if (!state.varyings.find((v) => v.name === vname)) {
        state.varyings.push({ name: vname, type: wgslType });
        state.vertex.body.push(`out.${vname} = in.${attrName};`);
    }
    return { expr: `in.${vname}`, type };
}

// BJS NodeMaterialSystemValues enum (Babylon.js master).
// We map the commonly used ones to WGSL expressions sourced from scene/mesh UBOs.
// For matrices not present in Lite's scene UBO (`projection` alone), we fall
// back to the closest valid expression (or throw — caller decides).
function emitSystemValue(block: NodeBlock, stage: Stage, state: NodeBuildState): NodeExpr {
    const sv = block.serialized["systemValue"] as number | undefined;
    // Only sensible in the vertex stage for matrix types; for CameraPosition/FogColor either stage is fine.
    switch (sv) {
        case 1: // World
            return { expr: "meshU.world", type: "mat4f" };
        case 2: // View
            return { expr: "sceneU.view", type: "mat4f" };
        case 3: // Projection
            return { expr: "sceneU.projection", type: "mat4f" };
        case 4: // ViewProjection
            return { expr: "sceneU.viewProjection", type: "mat4f" };
        case 5: // WorldView
            return { expr: "(sceneU.view * meshU.world)", type: "mat4f" };
        case 6: // WorldViewProjection
            return { expr: "(sceneU.viewProjection * meshU.world)", type: "mat4f" };
        case 7: // CameraPosition
            return { expr: "sceneU.vEyePosition.xyz", type: "vec3f" };
        case 8: // FogColor
            return { expr: "sceneU.vFogColor.xyz", type: "vec3f" };
        default:
            throw new Error(`InputBlock: unsupported systemValue ${sv} on block "${block.name}"`);
    }
    void stage;
    void state;
}

function emitUniform(block: NodeBlock, state: NodeBuildState): NodeExpr {
    // Determine the WGSL type. BJS serializes the port type under `type`.
    const portType = (block.serialized["type"] as BjsType | undefined) ?? 0x10;
    const type = bjsTypeToNodeType(portType);
    // UBO field name — use block name (must be unique; parser enforces via namedInputs key).
    const fieldName = sanitize(block.name || `input${block.id}`);
    // Dedup.
    if (!state.nodeUboFields.find((f) => f.name === fieldName)) {
        state.nodeUboFields.push({ name: fieldName, type: WGSL[type] as any });
        // If this is a literal value (no override yet), it will be written into the
        // UBO at material-build time; for shader generation we just reference the field.
        // We ignore the inline literal here — the UBO write path handles that.
    }
    void wgslLiteral; // reserved for future default-literal constant-fold optimization
    return { expr: `nodeU.${fieldName}`, type };
}

function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

export const emitter: BlockEmitter = {
    className: "InputBlock",
    emit(block, _outputName, stage, state, _ctx) {
        const mode = (block.serialized["mode"] ?? block.serialized["_mode"]) as number | undefined;
        if (mode === 1) {
            return emitAttribute(block, stage, state);
        }
        // System-value uniforms (World, WVP, CameraPosition, …) come from scene/mesh UBOs
        // rather than the material's node UBO, so they never appear in `nodeUboFields`.
        const sv = block.serialized["systemValue"];
        if (typeof sv === "number") {
            return emitSystemValue(block, stage, state);
        }
        // Default to Uniform (mode 0 or unspecified).
        return emitUniform(block, state);
    },
};
