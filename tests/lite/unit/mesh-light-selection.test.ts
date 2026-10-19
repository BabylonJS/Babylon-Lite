import { describe, expect, it } from "vitest";

import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light";
import type { LightBase } from "../../../packages/babylon-lite/src/light/types";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { writeMeshLightSelection } from "../../../packages/babylon-lite/src/render/mesh-light-selection";

/**
 * `affectsMesh` filters a light either by mesh object or by mesh id. The object sets exist because
 * an id cannot identify a mesh on its own: loading one asset twice yields distinct meshes carrying
 * the same asset-local id, and a clone is spread from its source. These tests read the selection
 * through `writeMeshLightSelection`, whose return value is what the renderables bake.
 */
describe("per-mesh light selection", () => {
    /** Enough of a mesh for `affectsMesh`: an optional id and nothing else. */
    function mesh(id?: string): Mesh {
        return { id } as Mesh;
    }

    function light(): LightBase {
        const created = createDirectionalLight([0, -1, 0]) as unknown as LightBase;
        // `writeMeshLightSelection` skips a light that writes no UBO entry.
        (created as { _writeLightUbo?: unknown })._writeLightUbo ??= () => undefined;
        return created;
    }

    /** The number of lights selected for this mesh, as the renderables count them. */
    function selectedCount(target: Mesh, lights: readonly LightBase[]): number {
        const result = writeMeshLightSelection(target, lights);
        return result > 0 ? 1 : -result;
    }

    it("lights every mesh when no list is set", () => {
        const sun = light();
        expect(selectedCount(mesh(), [sun])).toBe(1);
        expect(selectedCount(mesh("floor"), [sun])).toBe(1);
    });

    it("excludes by object, leaving an id-less mesh lit", () => {
        const sun = light();
        const floor = mesh();
        const box = mesh();
        sun.excludedMeshes = new Set([floor]);

        expect(selectedCount(floor, [sun])).toBe(0);
        expect(selectedCount(box, [sun])).toBe(1);
    });

    it("includes only the listed objects", () => {
        const sun = light();
        const box = mesh();
        const floor = mesh();
        sun.includedOnlyMeshes = new Set([box]);

        expect(selectedCount(box, [sun])).toBe(1);
        expect(selectedCount(floor, [sun])).toBe(0);
    });

    it("subtracts an exclusion from an inclusion, as Babylon.js canAffectMesh does", () => {
        const sun = light();
        const carcass = mesh();
        const glassDoor = mesh();
        sun.includedOnlyMeshes = new Set([carcass, glassDoor]);
        sun.excludedMeshes = new Set([glassDoor]);

        expect(selectedCount(carcass, [sun])).toBe(1);
        expect(selectedCount(glassDoor, [sun])).toBe(0);
    });

    it("lights nothing when an inclusion is cancelled entirely by an exclusion", () => {
        const sun = light();
        const box = mesh();
        const unrelated = mesh();
        sun.includedOnlyMeshes = new Set([box]);
        sun.excludedMeshes = new Set([box]);

        // The restriction stays in force: it is not "no restriction" just because nothing survives.
        expect(selectedCount(box, [sun])).toBe(0);
        expect(selectedCount(unrelated, [sun])).toBe(0);
    });

    it("excludes one of two meshes that share a loader id", () => {
        const sun = light();
        // The same asset imported twice: distinct meshes, identical asset-local id.
        const firstImport = mesh("floor-node-7");
        const secondImport = mesh("floor-node-7");
        sun.excludedMeshes = new Set([firstImport]);

        expect(selectedCount(firstImport, [sun])).toBe(0);
        expect(selectedCount(secondImport, [sun])).toBe(1);
    });

    it("includes one of two meshes that share a loader id", () => {
        const sun = light();
        const firstImport = mesh("floor-node-7");
        const secondImport = mesh("floor-node-7");
        sun.includedOnlyMeshes = new Set([firstImport]);

        expect(selectedCount(firstImport, [sun])).toBe(1);
        expect(selectedCount(secondImport, [sun])).toBe(0);
    });

    it("still filters by id, so a loaded light list keeps working", () => {
        const sun = light();
        sun.excludedMeshIds = new Set(["floor-node-7"]);

        expect(selectedCount(mesh("floor-node-7"), [sun])).toBe(0);
        expect(selectedCount(mesh("wall-node-2"), [sun])).toBe(1);
    });

    it("applies an object exclusion ahead of an id inclusion", () => {
        const sun = light();
        const loaded = mesh("floor-node-7");
        sun.includedOnlyMeshIds = new Set(["floor-node-7"]);
        sun.excludedMeshes = new Set([loaded]);

        expect(selectedCount(loaded, [sun])).toBe(0);
    });
});
