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
        // Default to Uniform (mode 0 or unspecified).
        return emitUniform(block, state);
    },
};
