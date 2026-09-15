import { createSceneNodeFromMatrix } from "../scene/scene-node.js";
import { createPbrMaterial } from "../material/pbr/pbr-material.js";
import { readUsdCommands, UsdOp, USD_NONE, usdField, usdString, usdUints } from "./usd-protocol.js";
import { usdMatrix, buildUsdNodes } from "./usd-nodes.js";
import { buildUsdMaterials } from "./usd-materials.js";
import { readUsdGeometry, usdSubset, usdReverseIndices } from "./usd-geometry.js";
import type { UsdGeometry } from "./usd-geometry.js";
import type { UsdDraw, UsdContext } from "./usd-context.js";
import { createUsdDraw } from "./usd-meshes.js";
import { applyUsdFeatures } from "./usd-features.js";
import type { EngineContext } from "../engine/engine.js";
import type { UsdExtraction, UsdAssetContainer } from "./usd-types.js";

/** @internal Materialize into a caller-owned rollback collection, never directly into a Scene. */
export async function materializeUsd(engine: EngineContext, extracted: UsdExtraction, container: UsdAssetContainer, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const records = readUsdCommands(extracted.commands);
    const scenes = records.filter((record) => record.op === UsdOp.Scene);
    if (scenes.length !== 1) {
        throw new Error("USD command buffer must contain exactly one scene");
    }
    const scene = scenes[0]!;
    const zUp = usdField(scene, 0);
    const scale = scene.payload.getFloat32(4, true);
    const fps = scene.payload.getFloat32(8, true);
    if (zUp > 1 || !(scale > 0) || !Number.isFinite(scale) || !(fps > 0) || !Number.isFinite(fps)) {
        throw new Error("Invalid USD stage metadata");
    }
    const root = createSceneNodeFromMatrix("USD Root", usdMatrix([scale, 0, 0, 0, 0, zUp ? 0 : scale, zUp ? scale : 0, 0, 0, zUp ? scale : 0, zUp ? 0 : -scale, 0, 0, 0, 0, 1]));
    container.entities.push(root);
    const nodes = buildUsdNodes(
        records.filter((record) => record.op === UsdOp.Node),
        extracted.data,
        root
    );
    const materials = await buildUsdMaterials(engine, records, extracted.data, container._usdTextures, signal);
    signal?.throwIfAborted();
    const context: UsdContext = {
        engine,
        records,
        data: extracted.data,
        nodes,
        materials,
        root,
        container,
        timeCodesPerSecond: fps,
        signal,
        sources: new Map(),
        draws: [],
        rigs: new Map(),
        bones: new Map(),
        morphTargets: new Map(),
        classicInstanceSources: new Set(),
        thinInstanceSources: new Set(),
    };
    const geometryRecords = new Map<number, (typeof records)[number]>();
    for (const record of records) {
        if (record.op === UsdOp.Geometry) {
            const id = usdField(record, 0);
            if (geometryRecords.has(id)) {
                throw new Error(`Duplicate USD geometry ${id}`);
            }
            geometryRecords.set(id, record);
        }
    }
    const geometries = new Map<number, UsdGeometry>();
    const shared = new Map<string, UsdDraw>();
    const defaultMaterial = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    for (const record of records) {
        if (record.op !== UsdOp.Mesh) {
            continue;
        }
        const id = usdField(record, 0);
        if (context.sources.has(id) || id === USD_NONE) {
            throw new Error(`Duplicate or reserved USD mesh ${id}`);
        }
        const geometryId = usdField(record, 2);
        let geometry = geometries.get(geometryId);
        if (!geometry) {
            const descriptor = geometryRecords.get(geometryId);
            if (!descriptor) {
                throw new Error(`Missing USD geometry ${geometryId}`);
            }
            geometry = await readUsdGeometry(descriptor, extracted.data);
            geometries.set(geometryId, geometry);
        }
        signal?.throwIfAborted();
        const flags = usdField(record, 6);
        const count = usdField(record, 9);
        if (!count) {
            throw new Error("USD mesh has no material subsets");
        }
        const subsets = usdUints(extracted.data, usdField(record, 8), count * 5);
        const sourceDraws: UsdDraw[] = [];
        const name = usdString(extracted.data, usdField(record, 4), usdField(record, 5));
        for (let i = 0; i < count; i++) {
            const start = subsets[i * 5 + 1]!,
                length = subsets[i * 5 + 2]!;
            if (subsets[i * 5 + 3]! + subsets[i * 5 + 4]! > geometry.positions.length / 3) {
                throw new Error("Invalid USD material subset vertex range");
            }
            const key = `${geometryId}:${start}:${length}:${flags & 2}`;
            const source = shared.get(key);
            let part = source?.geometry ?? usdSubset(geometry, start, length);
            if (!source && flags & 2) {
                part = { ...part, indices: usdReverseIndices(part.indices) };
            }
            const materialId = count === 1 && usdField(record, 3) !== USD_NONE ? usdField(record, 3) : subsets[i * 5]!;
            let material = materialId === USD_NONE ? defaultMaterial : materials.get(materialId);
            if (!material) {
                throw new Error(`Missing USD material ${materialId}`);
            }
            if (flags & 1 && !material.doubleSided) {
                material = { ...material, doubleSided: true };
            }
            const draw = createUsdDraw(context, part, material, count === 1 ? name : `${name} [${i}]`, usdField(record, 1), usdField(record, 7), source);
            if (!source) {
                shared.set(key, draw);
            }
            sourceDraws.push(draw);
        }
        context.sources.set(id, sourceDraws);
    }
    await applyUsdFeatures(context);
    signal?.throwIfAborted();
}
