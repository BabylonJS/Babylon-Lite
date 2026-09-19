import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Babylon.js allows `new StandardMaterial(name)` with no scene. Whatever path registers the mesh that renders
 * it must make the scene adopt the material; otherwise `material.getScene()` stays undefined after startup and
 * a later rebuild request (`_refreshInScene()`: a `disableLighting` toggle, a texture that finished loading)
 * silently does nothing — the cached shader variant stays active.
 *
 * `MeshBuilder` goes through `addPrimitive()` (covered in material-texture-rebind.test.ts). These are the
 * deferred registration paths that bypass it. GPU/wasm-free: the Lite factories they call are mocked.
 */
vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        addToScene: vi.fn(),
        rebuildMaterial: vi.fn(),
        createCsgFromMesh: vi.fn(() => ({})),
        createMeshFromCsg: vi.fn((_engine: unknown, _csg: unknown, name: string) => ({ name, children: [] })),
        createMeshFromData: vi.fn((_engine: unknown, name: string) => ({ name, children: [] })),
        createCsg2FromMesh: vi.fn(() => ({})),
        createMeshesFromCsg2: vi.fn((_engine: unknown, _csg: unknown, materials: unknown[], name: string) => [{ name, children: [], material: materials.find(Boolean) }]),
        createDebugNavMeshGeometry: vi.fn(() => ({ positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) })),
    };
});

import { rebuildMaterial } from "babylon-lite";
import { StandardMaterial } from "../src/materials/materials";
import { Color3 } from "../src/math/color";
import { CSG, CSG2 } from "../src/meshes/csg";
import { RecastNavigationJSPluginV2 } from "../src/navigation/navigation";
import type { Scene } from "../src/scene/scene";

const rebuildMaterialMock = vi.mocked(rebuildMaterial);

/** Compat-`Scene` stand-in that queues deferred adds until `start()`, like the real one does at engine start. */
function pendingScene(): { scene: Scene; liteScene: object; registerMaterial: ReturnType<typeof vi.fn>; start(): void } {
    const liteScene = { id: "scene-lite" };
    const pendingAdds: Array<() => void> = [];
    const registerMaterial = vi.fn();
    const state = {
        _hasStarted: false,
        _lite: liteScene,
        defaultMaterial: undefined,
        getEngine: () => ({ _lite: { id: "engine-lite" } }),
        _deferAdd: (add: () => void) => pendingAdds.push(add),
        _registerMesh: vi.fn(),
        _unregisterNode: vi.fn(),
        _registerMaterial: registerMaterial,
        _unregisterMaterial: vi.fn(),
    };
    return {
        scene: state as unknown as Scene,
        liteScene,
        registerMaterial,
        start: () => {
            state._hasStarted = true;
            for (const add of pendingAdds.splice(0)) {
                add();
            }
        },
    };
}

/** The usual unlit-colour setup, built Babylon.js-style with no scene. */
function sceneLessUnlitColour(): StandardMaterial {
    const material = new StandardMaterial("led");
    material.diffuseColor = new Color3(0, 0, 0);
    material.emissiveColor = new Color3(0, 0, 1);
    return material;
}

beforeEach(() => {
    rebuildMaterialMock.mockClear();
});

describe("scene-less material on deferred mesh paths that bypass addPrimitive()", () => {
    it("CSG.toMesh(name, material, scene) adopts the scene, so a post-start disableLighting toggle rebuilds", () => {
        const { scene, liteScene, registerMaterial, start } = pendingScene();
        const material = sceneLessUnlitColour();
        const source = { _lite: { name: "source" } };

        CSG.FromMesh(source as never).toMesh("result", material, scene);
        expect(registerMaterial).not.toHaveBeenCalled();

        start();
        expect(registerMaterial).toHaveBeenCalledWith(material);
        expect(material.getScene()).toBe(scene);

        material.disableLighting = true;
        expect(rebuildMaterialMock).toHaveBeenCalledTimes(1);
        expect(rebuildMaterialMock).toHaveBeenCalledWith(liteScene, material._lite);
    });

    it("CSG2.toMesh(name, scene) adopts the scene for the source meshes' materials", () => {
        const { scene, liteScene, registerMaterial, start } = pendingScene();
        const material = sceneLessUnlitColour();
        const source = { _lite: { name: "source" }, material };

        CSG2.FromMesh(source as never).toMesh("result", scene);
        expect(registerMaterial).toHaveBeenCalledWith(material);
        expect(material.getScene()).toBe(scene);

        start();
        material.disableLighting = true;
        expect(rebuildMaterialMock).toHaveBeenCalledTimes(1);
        expect(rebuildMaterialMock).toHaveBeenCalledWith(liteScene, material._lite);
    });

    it("createDebugNavMesh(scene) adopts the scene for a material assigned before startup", () => {
        const { scene, liteScene, registerMaterial, start } = pendingScene();
        const material = sceneLessUnlitColour();
        const plugin = new RecastNavigationJSPluginV2({} as never);

        const debugMesh = plugin.createDebugNavMesh(scene);
        debugMesh.material = material;
        expect(registerMaterial).not.toHaveBeenCalled();

        start();
        expect(registerMaterial).toHaveBeenCalledWith(material);
        expect(material.getScene()).toBe(scene);

        material.disableLighting = true;
        expect(rebuildMaterialMock).toHaveBeenCalledTimes(1);
        expect(rebuildMaterialMock).toHaveBeenCalledWith(liteScene, material._lite);
    });
});
