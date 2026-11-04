import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Babylon.js allows `new StandardMaterial(name)` with no scene. The material a mesh renders with must be
 * owned by that mesh's scene; otherwise `material.getScene()` stays undefined after startup and a later
 * rebuild request (`_refreshInScene()`: a `disableLighting` toggle, a texture that finished loading) silently
 * does nothing — the cached shader variant stays active.
 *
 * Ownership is independent of GPU finalization: it is settled as soon as a mesh that has a scene is given
 * the material, started or not, because not every pre-start assignment is followed by a registration
 * callback that sees that material. Finalization (`_ensureRenderable`) stays with the live setter and the
 * deferred registration at engine start.
 *
 * GPU/wasm-free: the Lite factories these paths call are mocked.
 */
vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        addToScene: vi.fn(),
        rebuildMaterial: vi.fn(),
        createBox: vi.fn(() => ({ name: "", children: [] })),
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
import { Mesh, MeshBuilder } from "../src/meshes/meshes";
import { RecastNavigationJSPluginV2 } from "../src/navigation/navigation";
import { Scene } from "../src/scene/scene";

const rebuildMaterialMock = vi.mocked(rebuildMaterial);

interface PendingScene {
    scene: Scene;
    liteScene: object;
    engineLite: object;
    registerMaterial: ReturnType<typeof vi.fn>;
    start(): void;
}

/** Compat-`Scene` stand-in that queues deferred adds until `start()`, like the real one does at engine start. */
function pendingScene(defaultMaterial?: StandardMaterial): PendingScene {
    const liteScene = { id: "scene-lite" };
    const engineLite = { id: "engine-lite" };
    const pendingAdds: Array<() => void> = [];
    const registerMaterial = vi.fn();
    const state = {
        _hasStarted: false,
        _lite: liteScene,
        defaultMaterial,
        getEngine: () => ({ _lite: engineLite }),
        _deferAdd: (add: () => void) => pendingAdds.push(add),
        _registerMesh: vi.fn(),
        _unregisterNode: vi.fn(),
        _registerMaterial: registerMaterial,
        _unregisterMaterial: vi.fn(),
    };
    return {
        scene: state as unknown as Scene,
        liteScene,
        engineLite,
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

/** After startup, the toggle that needs a rebuild actually gets one, in the owning scene. */
function expectLiveRebuild(material: StandardMaterial, pending: PendingScene): void {
    expect(material.getScene()).toBe(pending.scene);
    material.disableLighting = true;
    expect(rebuildMaterialMock).toHaveBeenCalledTimes(1);
    expect(rebuildMaterialMock).toHaveBeenCalledWith(pending.liteScene, material._lite);
}

beforeEach(() => {
    rebuildMaterialMock.mockClear();
});

describe("scene ownership of a scene-less material assigned before startup", () => {
    it("an imported mesh adopts it at assignment: there is no registration callback to do it later", () => {
        const pending = pendingScene();
        const material = sceneLessUnlitColour();
        const imported = Mesh._fromLite({ name: "imported", children: [] } as never, undefined, pending.scene);

        imported.material = material;
        expect(pending.registerMaterial).toHaveBeenCalledWith(material);
        expect(material.getScene()).toBe(pending.scene);

        pending.start();
        expectLiveRebuild(material, pending);
    });

    it("CSG.toMesh(name, null, scene) finalizes the material assigned to the returned mesh, not the captured null", () => {
        const pending = pendingScene();
        const material = sceneLessUnlitColour();
        const ensureRenderable = vi.spyOn(material, "_ensureRenderable");

        const result = CSG.FromMesh({ _lite: { name: "source" } } as never).toMesh("result", null, pending.scene);
        result.material = material;
        expect(pending.registerMaterial).toHaveBeenCalledWith(material);
        // Ownership only so far: GPU finalization waits for the engine.
        expect(ensureRenderable).not.toHaveBeenCalled();

        pending.start();
        expect(ensureRenderable).toHaveBeenCalledWith(pending.engineLite);
        expect((result._lite as { material?: unknown }).material).toBe(material._lite);
        expectLiveRebuild(material, pending);
    });

    it("a primitive with material = null adopts and finalizes the effective scene.defaultMaterial", () => {
        const material = sceneLessUnlitColour();
        const pending = pendingScene(material);
        const ensureRenderable = vi.spyOn(material, "_ensureRenderable");

        const box = MeshBuilder.CreateBox("box", {}, pending.scene);
        box.material = null;
        expect(pending.registerMaterial).toHaveBeenCalledWith(material);
        expect(ensureRenderable).not.toHaveBeenCalled();

        pending.start();
        // Deferred registration reads the effective material, not just `mesh.material` (null here).
        expect(ensureRenderable).toHaveBeenCalledWith(pending.engineLite);
        expect((box._lite as { material?: unknown }).material).toBe(material._lite);
        expectLiveRebuild(material, pending);
    });

    it("scene.defaultMaterial = material adopts a scene-less replacement", () => {
        const material = sceneLessUnlitColour();
        const registerMaterial = vi.fn();
        const owner = { _registerMaterial: registerMaterial } as unknown as Scene;
        const setDefaultMaterial = Object.getOwnPropertyDescriptor(Scene.prototype, "defaultMaterial")!.set!;

        setDefaultMaterial.call(owner, material);
        expect(registerMaterial).toHaveBeenCalledWith(material);
        expect(material.getScene()).toBe(owner);
    });
});

describe("scene-less material on the specialized mesh builders", () => {
    it("CSG.toMesh(name, material, scene) makes it the result's material and owns it", () => {
        const pending = pendingScene();
        const material = sceneLessUnlitColour();

        const result = CSG.FromMesh({ _lite: { name: "source" } } as never).toMesh("result", material, pending.scene);
        expect(result.material).toBe(material);
        expect(pending.registerMaterial).toHaveBeenCalledWith(material);

        pending.start();
        expect((result._lite as { material?: unknown }).material).toBe(material._lite);
        expectLiveRebuild(material, pending);
    });

    it("CSG2.toMesh(name, scene) owns the source meshes' materials", () => {
        const pending = pendingScene();
        const material = sceneLessUnlitColour();

        CSG2.FromMesh({ _lite: { name: "source" }, material } as never).toMesh("result", pending.scene);
        expect(pending.registerMaterial).toHaveBeenCalledWith(material);

        pending.start();
        expectLiveRebuild(material, pending);
    });

    it("CSG2.toMesh(name, scene) finalizes a material given to the returned mesh before startup", () => {
        const pending = pendingScene();
        const material = sceneLessUnlitColour();
        const ensureRenderable = vi.spyOn(material, "_ensureRenderable");

        const result = CSG2.FromMesh({ _lite: { name: "source" }, material: sceneLessUnlitColour() } as never).toMesh("result", pending.scene);
        result.material = material;

        pending.start();
        expect(ensureRenderable).toHaveBeenCalledWith(pending.engineLite);
        expect((result._lite as { material?: unknown }).material).toBe(material._lite);
        expectLiveRebuild(material, pending);
    });

    it("createDebugNavMesh(scene) owns and finalizes a material assigned before startup", () => {
        const pending = pendingScene();
        const material = sceneLessUnlitColour();
        const ensureRenderable = vi.spyOn(material, "_ensureRenderable");
        const plugin = new RecastNavigationJSPluginV2({} as never);

        const debugMesh = plugin.createDebugNavMesh(pending.scene);
        debugMesh.material = material;
        expect(pending.registerMaterial).toHaveBeenCalledWith(material);

        pending.start();
        expect(ensureRenderable).toHaveBeenCalledWith(pending.engineLite);
        expectLiveRebuild(material, pending);
    });
});
