import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for issue #476 — a material (or a still-loading texture)
 * assigned after the mesh already entered the scene must realise its textures.
 *
 * Two paths are covered, both GPU-free by mocking the Lite factories:
 *  (a) the mesh `material` setter finalizes the material (`_ensureRenderable`)
 *      and rebinds the Lite handle once the mesh is live;
 *  (b) an asynchronously loaded `Texture` assigned to a material rebuilds that
 *      material through Lite's `rebuildMaterial` path once its handle resolves.
 */

const liteMocks = vi.hoisted(() => ({
    createStandardMaterial: vi.fn(() => ({ diffuseTexture: null, emissiveTexture: null, bumpTexture: null }) as Record<string, unknown>),
    createPbrMaterial: vi.fn(() => ({}) as Record<string, unknown>),
    markMaterialUboDirty: vi.fn(),
    createSolidTexture2D: vi.fn(() => ({ id: "solid" })),
    rebuildMaterial: vi.fn(),
    loadTexture2D: vi.fn(),
    loadBasisTexture2D: vi.fn(),
    loadKtxTexture2D: vi.fn(),
    createTexture2DFromPixels: vi.fn(),
    updateTexture2DFromPixels: vi.fn(),
    createTexture3DFromPixels: vi.fn(),
    createDynamicTexture: vi.fn(),
    updateDynamicTexture: vi.fn(),
}));

vi.mock("babylon-lite", () => liteMocks);

import { StandardMaterial, PBRMaterial } from "../src/materials/materials";
import { Texture } from "../src/textures/textures";
import { AbstractMesh } from "../src/meshes/meshes";
import type { Scene } from "../src/scene/scene";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function engineWrapper(): { _lite: import("babylon-lite").EngineContext } {
    return { _lite: {} as import("babylon-lite").EngineContext };
}

/** Minimal compat-`Scene` stand-in exposing only what the reconcile path reads. */
function fakeScene(started: boolean): {
    scene: Scene;
    engineLite: object;
    registerMaterial: ReturnType<typeof vi.fn>;
    unregisterMaterial: ReturnType<typeof vi.fn>;
} {
    const engineLite = { id: "engine-lite" };
    const registerMaterial = vi.fn();
    const unregisterMaterial = vi.fn();
    const scene = {
        _hasStarted: started,
        _lite: { id: "scene-lite" },
        getEngine: () => ({ _lite: engineLite }),
        _registerMaterial: registerMaterial,
        _unregisterMaterial: unregisterMaterial,
    } as unknown as Scene;
    return { scene, engineLite, registerMaterial, unregisterMaterial };
}

/** A `Texture` whose backing load is controlled by the returned deferred. */
function pendingTexture(): { texture: Texture; resolve: (handle: object) => void } {
    const load = deferred<object>();
    liteMocks.loadTexture2D.mockReturnValueOnce(load.promise);
    const texture = new Texture("https://h/albedo.png", engineWrapper());
    return { texture, resolve: load.resolve };
}

beforeEach(() => {
    for (const mock of Object.values(liteMocks)) {
        mock.mockReset();
    }
    liteMocks.createStandardMaterial.mockImplementation(() => ({ diffuseTexture: null, emissiveTexture: null, bumpTexture: null }));
    liteMocks.createPbrMaterial.mockImplementation(() => ({}));
    liteMocks.createSolidTexture2D.mockImplementation(() => ({ id: "solid" }));
});

describe("BaseTexture._onReady", () => {
    it("queues the listener until the load resolves, then fires it once", async () => {
        const { texture, resolve } = pendingTexture();
        let fired = 0;
        (texture as unknown as { _onReady(cb: () => void): void })._onReady(() => fired++);
        expect(fired).toBe(0);

        resolve({ id: "handle" });
        await texture.whenReadyAsync();
        expect(fired).toBe(1);
    });

    it("fires immediately when the texture is already ready", async () => {
        const { texture, resolve } = pendingTexture();
        resolve({ id: "handle" });
        await texture.whenReadyAsync();

        let fired = 0;
        (texture as unknown as { _onReady(cb: () => void): void })._onReady(() => fired++);
        expect(fired).toBe(1);
    });
});

describe("StandardMaterial texture-readiness rebuild (issue #476b)", () => {
    it("binds the resolved handle and rebuilds through rebuildMaterial once the texture loads", async () => {
        const { scene } = fakeScene(true);
        const mat = new StandardMaterial("m", scene);
        const { texture, resolve } = pendingTexture();

        mat.diffuseTexture = texture;
        // Still loading: the Lite handle is absent and no rebuild has happened yet.
        expect(mat._lite.diffuseTexture).toBeNull();
        expect(liteMocks.rebuildMaterial).not.toHaveBeenCalled();

        const handle = { id: "diffuse-handle" };
        resolve(handle);
        await texture.whenReadyAsync();

        expect(mat._lite.diffuseTexture).toBe(handle);
        expect(liteMocks.rebuildMaterial).toHaveBeenCalledTimes(1);
        expect(liteMocks.rebuildMaterial).toHaveBeenCalledWith((scene as unknown as { _lite: object })._lite, mat._lite);
    });

    it("does not rebuild before the engine has started (boot-time build owns those meshes)", async () => {
        const { scene } = fakeScene(false);
        const mat = new StandardMaterial("m", scene);
        const { texture, resolve } = pendingTexture();

        mat.diffuseTexture = texture;
        resolve({ id: "handle" });
        await texture.whenReadyAsync();

        expect(liteMocks.rebuildMaterial).not.toHaveBeenCalled();
    });

    it("does not rebuild after the material is disposed", async () => {
        const { scene, unregisterMaterial } = fakeScene(true);
        const mat = new StandardMaterial("m", scene);
        const { texture, resolve } = pendingTexture();

        mat.diffuseTexture = texture;
        mat.dispose();
        resolve({ id: "handle" });
        await texture.whenReadyAsync();

        expect(unregisterMaterial).toHaveBeenCalledWith(mat);
        expect(liteMocks.rebuildMaterial).not.toHaveBeenCalled();
    });
});

describe("PBRMaterial texture-readiness rebuild (issue #476b)", () => {
    it("binds the resolved albedo handle and rebuilds once the texture loads", async () => {
        const { scene, engineLite } = fakeScene(true);
        const mat = new PBRMaterial("m", scene);
        const { texture, resolve } = pendingTexture();

        mat.albedoTexture = texture;
        expect(liteMocks.rebuildMaterial).not.toHaveBeenCalled();

        const handle = { id: "albedo-handle" };
        resolve(handle);
        await texture.whenReadyAsync();

        // The resolved handle is bound as the base-colour texture (sRGB by default),
        // the PBR solid ORM texture is synthesized against the scene engine, and the
        // renderables rebuild through Lite's rebuildMaterial.
        expect((mat._lite as { baseColorTexture?: unknown }).baseColorTexture).toBe(handle);
        expect((mat._lite as { _gammaAlbedo?: unknown })._gammaAlbedo).toBe(true);
        expect(liteMocks.createSolidTexture2D).toHaveBeenCalledWith(engineLite, 1, 1, 1);
        expect(liteMocks.rebuildMaterial).toHaveBeenCalledWith((scene as unknown as { _lite: object })._lite, mat._lite);
    });
});

describe("Mesh material setter reconciliation (issue #476a)", () => {
    const materialSetter = Object.getOwnPropertyDescriptor(AbstractMesh.prototype, "material")!.set!;

    function fakeMaterial(): { _lite: object; _ensureRenderable: ReturnType<typeof vi.fn>; _adoptScene: ReturnType<typeof vi.fn> } {
        return { _lite: { id: "mat-lite" }, _ensureRenderable: vi.fn(), _adoptScene: vi.fn() };
    }

    it("ensures the renderable, adopts the scene, and rebinds when the mesh is live", () => {
        const { scene, engineLite } = fakeScene(true);
        const liteMesh: { material: unknown } = { material: null };
        const mesh = Object.create(AbstractMesh.prototype) as { _lite: typeof liteMesh; _scene: Scene };
        mesh._lite = liteMesh;
        mesh._scene = scene;

        const mat = fakeMaterial();
        materialSetter.call(mesh, mat);

        expect(mat._adoptScene).toHaveBeenCalledWith(scene);
        expect(mat._ensureRenderable).toHaveBeenCalledWith(engineLite);
        // Rebinding the Lite handle is what enqueues Lite's material-swap rebuild.
        expect(liteMesh.material).toBe(mat._lite);
    });

    it("only rebinds (no ensure/adopt) before the engine has started", () => {
        const { scene } = fakeScene(false);
        const liteMesh: { material: unknown } = { material: null };
        const mesh = Object.create(AbstractMesh.prototype) as { _lite: typeof liteMesh; _scene: Scene };
        mesh._lite = liteMesh;
        mesh._scene = scene;

        const mat = fakeMaterial();
        materialSetter.call(mesh, mat);

        expect(mat._adoptScene).not.toHaveBeenCalled();
        expect(mat._ensureRenderable).not.toHaveBeenCalled();
        expect(liteMesh.material).toBe(mat._lite);
    });

    it("rebinds the scene default material when material is cleared", () => {
        const { scene } = fakeScene(true);
        const defaultMaterial = fakeMaterial();
        Object.defineProperty(scene, "defaultMaterial", { value: defaultMaterial });
        const previousMaterial = fakeMaterial();
        const liteMesh: { material: unknown } = { material: previousMaterial._lite };
        const mesh = Object.create(AbstractMesh.prototype) as { _lite: typeof liteMesh; _scene: Scene };
        mesh._lite = liteMesh;
        mesh._scene = scene;

        materialSetter.call(mesh, null);

        expect(defaultMaterial._adoptScene).toHaveBeenCalledWith(scene);
        expect(liteMesh.material).toBe(defaultMaterial._lite);
    });
});
