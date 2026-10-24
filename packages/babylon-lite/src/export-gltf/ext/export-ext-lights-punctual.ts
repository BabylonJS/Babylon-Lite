/** KHR_lights_punctual: scene lights → document-level light list and their node placement. */

import type { DirectionalLight } from "../../light/directional-light.js";
import type { PointLight } from "../../light/point-light.js";
import type { SpotLight } from "../../light/spot-light.js";
import type { LightBase } from "../../light/types.js";
import type { ExportContext } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfJsonObject, GltfNode } from "../export-gltf-types.js";
import { convertRotation, convertTranslation, isIdentityRotation, multiplyQuat, nearlyEqual, normalizeQuat, OMIT_EPSILON, rotationToDirection } from "../export-handedness.js";
import { isExportableNode } from "../export-nodes.js";

const EXT = "KHR_lights_punctual";
const ORIGIN: readonly number[] = [0, 0, 0];
const FORWARD: readonly number[] = [0, 0, -1];
const DEFAULT_OUTER_CONE = Math.PI / 4;
/** Smallest outer cone half-angle written; glTF requires it to exceed the inner angle (0). */
const MIN_OUTER_CONE = 1e-4;

type ExportableLight = PointLight | DirectionalLight | SpotLight;

/** Build the `KHR_lights_punctual` light block for one light. */
function buildLightBlock(ctx: ExportContext, light: ExportableLight): GltfJsonObject {
    const block: GltfJsonObject = {};
    if (light.name) {
        block.name = light.name;
    }
    block.type = light.lightType;
    // glTF light colors are in [0, 1]; a brighter Lite color moves its peak into the intensity.
    const d = light.diffuse;
    const peak = Math.max(d[0], d[1], d[2]);
    const scale = peak > 1 ? peak : 1;
    const color = [d[0], d[1], d[2]].map((c) => Math.max(c, 0) / scale);
    if (color[0] !== 1 || color[1] !== 1 || color[2] !== 1) {
        block.color = color;
    }
    const intensity = light.intensity * scale;
    if (intensity !== 1) {
        block.intensity = intensity;
    }
    if (light.lightType !== "directional") {
        const range = light.range;
        if (Number.isFinite(range) && range > 0 && range !== Number.MAX_VALUE) {
            block.range = range;
        }
    }
    if (light.lightType === "spot") {
        const spot: GltfJsonObject = {};
        let outer = light.angle / 2;
        if (outer > Math.PI / 2) {
            outer = Math.PI / 2;
            ctx.warn(`Spot light "${light.name}" has a cone wider than KHR_lights_punctual allows; exporting a 180° cone.`);
        } else if (!(outer >= MIN_OUTER_CONE)) {
            outer = MIN_OUTER_CONE;
            ctx.warn(`Spot light "${light.name}" has an empty cone; exporting the narrowest cone KHR_lights_punctual allows.`);
        }
        if (Math.abs(outer - DEFAULT_OUTER_CONE) > 1e-9) {
            spot.outerConeAngle = outer;
        }
        block.spot = spot;
        if (light.exponent !== 1) {
            ctx.warn("Spot light exponent falloff is approximated by KHR_lights_punctual cone angles.");
        }
    }
    return block;
}

/** @internal Emit KHR_lights_punctual lights and their node placement (synchronous, capture phase). */
export function exportLights(ctx: ExportContext, lights: readonly LightBase[]): void {
    const blocks: GltfJsonObject[] = [];
    const holders = new Set<number>();

    for (const base of lights) {
        const type = base.lightType;
        if (type === "hemispheric") {
            ctx.warn("Hemispheric light is not representable in KHR_lights_punctual; skipping.");
            continue;
        }
        if (type !== "point" && type !== "directional" && type !== "spot") {
            ctx.warn(`Light type "${type}" is not exported.`);
            continue;
        }
        const light = base as ExportableLight;
        const lightIndex = blocks.length;
        blocks.push(buildLightBlock(ctx, light));

        // Local placement needs a parent exported as an ordinary node: a camera's or another light's
        // glTF node has a different frame from the Lite object, so those parents use world placement.
        const parent = light.parent;
        const pNode = isExportableNode(parent) ? ctx.nodeIndex.get(parent) : undefined;

        if (parent && pNode !== undefined) {
            const convert = ctx.nodeConvert.get(parent) === true;
            const pos = light.position;
            const rq = light.rotationQuaternion;
            const dir = light.lightType !== "point" ? light.direction : null;
            const collapse =
                !holders.has(pNode) &&
                nearlyEqual([pos.x, pos.y, pos.z], ORIGIN, OMIT_EPSILON) &&
                isIdentityRotation([rq.x, rq.y, rq.z, rq.w]) &&
                (!dir || nearlyEqual([dir.x, dir.y, dir.z], FORWARD, OMIT_EPSILON));
            if (collapse) {
                attachExtension(ctx, ctx.doc.nodes[pNode]!, EXT, { light: lightIndex });
                holders.add(pNode);
                ctx.nodeIndex.set(light, pNode);
                ctx.nodeConvert.set(light, convert);
                continue;
            }

            let q: number[] = [rq.x, rq.y, rq.z, rq.w];
            if (dir) {
                q = multiplyQuat(q, rotationToDirection(dir.x, dir.y, dir.z));
            }
            let t: number[] = [pos.x, pos.y, pos.z];
            if (convert) {
                t = convertTranslation(t[0]!, t[1]!, t[2]!);
                q = convertRotation(q[0]!, q[1]!, q[2]!, q[3]!);
            }
            const node = makeNode(light, normalizeQuat(q[0]!, q[1]!, q[2]!, q[3]!), t);
            const nodeIdx = ctx.doc.nodes.length;
            attachExtension(ctx, node, EXT, { light: lightIndex });
            ctx.doc.nodes.push(node);
            const pn = ctx.doc.nodes[pNode]!;
            (pn.children ??= []).push(nodeIdx);
            holders.add(nodeIdx);
            ctx.nodeIndex.set(light, nodeIdx);
            ctx.nodeConvert.set(light, convert);
            continue;
        }

        // No exported parent: place as a scene root from world state, in the converting frame.
        const w = light.worldMatrix;
        const t = convertTranslation(w[12]!, w[13]!, w[14]!);
        let q: number[] = [0, 0, 0, 1];
        if (light.lightType !== "point") {
            const ld = light.direction;
            const wx = w[0]! * ld.x + w[4]! * ld.y + w[8]! * ld.z;
            const wy = w[1]! * ld.x + w[5]! * ld.y + w[9]! * ld.z;
            const wz = w[2]! * ld.x + w[6]! * ld.y + w[10]! * ld.z;
            const len = Math.hypot(wx, wy, wz) || 1;
            q = rotationToDirection(-wx / len, wy / len, wz / len);
        }
        const node = makeNode(light, q, t);
        const nodeIdx = ctx.doc.nodes.length;
        attachExtension(ctx, node, EXT, { light: lightIndex });
        ctx.doc.nodes.push(node);
        ctx.doc.sceneNodes.push(nodeIdx);
        holders.add(nodeIdx);
        ctx.nodeIndex.set(light, nodeIdx);
        ctx.nodeConvert.set(light, true);
    }

    if (blocks.length > 0) {
        ctx.doc.extensions[EXT] = { lights: blocks };
        ctx.extensionsUsed.add(EXT);
    }
}

/** Dedicated light node: `name`, then `rotation` and `translation` when they differ from identity. */
function makeNode(light: LightBase, q: readonly number[], t: readonly number[]): GltfNode {
    const node: GltfNode = {};
    if (light.name) {
        node.name = light.name;
    }
    if (!isIdentityRotation(q)) {
        node.rotation = [q[0]!, q[1]!, q[2]!, q[3]!];
    }
    if (!nearlyEqual(t, ORIGIN, OMIT_EPSILON)) {
        node.translation = [t[0]!, t[1]!, t[2]!];
    }
    return node;
}
