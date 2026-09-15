import type { UsdContext } from "./usd-context.js";
import type { UsdGeometry } from "./usd-geometry.js";
import { usdReverseIndices } from "./usd-geometry.js";
import { UsdOp, USD_NONE, usdField, usdString } from "./usd-protocol.js";
import { createUsdDraw } from "./usd-meshes.js";
import { createPbrMaterial } from "../material/pbr/pbr-material.js";

/** @internal Analytic shapes only fetch the Lite builder needed by the asset. */
export async function apply(context: UsdContext): Promise<void> {
    for (const record of context.records) {
        if (record.op !== UsdOp.Analytic) {
            continue;
        }
        const id = usdField(record, 0);
        if (context.sources.has(id)) {
            throw new Error(`Duplicate USD mesh ${id}`);
        }
        const shape = usdField(record, 2);
        const flags = usdField(record, 6);
        const axis = usdField(record, 7);
        const radius = record.payload.getFloat32(32, true);
        const height = record.payload.getFloat32(36, true);
        const tessellation = usdField(record, 10);
        if (
            !(radius > 0) ||
            !Number.isFinite(radius) ||
            shape > 3 ||
            axis > 2 ||
            (shape > 1 && (!(height > 0) || !Number.isFinite(height))) ||
            (shape !== 0 && (tessellation < 3 || tessellation > 512))
        ) {
            throw new Error("Invalid USD analytic primitive");
        }
        let geometry: UsdGeometry;
        if (shape === 0) {
            geometry = (await import("../mesh/create-box.js")).createBoxData(radius);
        } else if (shape === 1) {
            geometry = (await import("../mesh/create-sphere.js")).createSphereData({ diameter: radius * 2, segments: tessellation });
        } else {
            geometry = (await import("../mesh/create-cylinder.js")).createCylinderData({
                height,
                diameterBottom: radius * 2,
                diameterTop: shape === 3 ? 0 : radius * 2,
                tessellation,
            });
        }
        context.signal?.throwIfAborted();
        // Lite builders are LH. Convert to the RH geometry convention used under our stage root.
        geometry.indices = usdReverseIndices(geometry.indices);
        for (const stream of [geometry.positions, geometry.normals]) {
            if (axis !== 1) {
                for (let i = 0; i < stream.length; i += 3) {
                    const x = stream[i]!,
                        y = stream[i + 1]!,
                        z = stream[i + 2]!;
                    stream[i] = axis === 0 ? y : x;
                    stream[i + 1] = axis === 0 ? -x : -z;
                    stream[i + 2] = axis === 0 ? z : y;
                }
            }
        }
        const materialId = usdField(record, 3);
        let material = materialId === USD_NONE ? createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 }) : context.materials.get(materialId);
        if (!material) {
            throw new Error(`Missing USD material ${materialId}`);
        }
        if (flags & 1 && !material.doubleSided) {
            material = { ...material, doubleSided: true };
        }
        context.sources.set(id, [createUsdDraw(context, geometry, material, usdString(context.data, usdField(record, 4), usdField(record, 5)), usdField(record, 1), USD_NONE)]);
    }
}
