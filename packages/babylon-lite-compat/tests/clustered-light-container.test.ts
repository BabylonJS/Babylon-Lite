import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ClusteredLightContainer` forwards to Babylon Lite's device-free clustered-light
 * factories (`createClusteredLightContainer` / `createClusteredPointLight`), so its
 * translation surface runs under Node without a GPU. Only the scene-wiring hops
 * (`addClusteredLightContainer` / `removeFromScene` / `addToScene`) touch the device
 * or a real `SceneContext`, so those are mocked here to assert the forwarding
 * contract while the clustering data functions stay real.
 */

const { addClusteredSpy, removeFromSceneSpy, addToSceneSpy } = vi.hoisted(() => ({
    addClusteredSpy: vi.fn(),
    removeFromSceneSpy: vi.fn(),
    addToSceneSpy: vi.fn(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        addClusteredLightContainer: addClusteredSpy,
        removeFromScene: removeFromSceneSpy,
        addToScene: addToSceneSpy,
    };
});

import { ClusteredLightContainer } from "../src/lights/clustered-light-container";
import { PointLight, DirectionalLight } from "../src/lights/lights";
import { Vector3 } from "../src/math/vector";
import { Color3 } from "../src/math/color";
import type { ClusteredLightContainer as LiteClusteredLightContainer } from "babylon-lite";
import type { Scene } from "../src/scene/scene";
function liteContainer(c: InstanceType<typeof ClusteredLightContainer>): LiteClusteredLightContainer {
    return (c as unknown as { _lite: LiteClusteredLightContainer })._lite;
}

/** Minimal fake scene exposing only what the container touches. */
function makeFakeScene(headless: boolean): { scene: Scene; registered: object[]; unregistered: object[] } {
    const registered: object[] = [];
    const unregistered: object[] = [];
    const scene = {
        _lite: { id: "fake-scene" },
        _registerLight: (l: object) => registered.push(l),
        _registerClusteredLightContainer: () => {},
        _unregisterNode: (n: object) => unregistered.push(n),
        getEngine: () => ({ _headless: headless }),
    } as unknown as Scene;
    return { scene, registered, unregistered };
}

beforeEach(() => {
    addClusteredSpy.mockClear();
    removeFromSceneSpy.mockClear();
    addToSceneSpy.mockClear();
});

describe("ClusteredLightContainer — construction defaults", () => {
    it("creates a Lite container with Babylon.js default tiling", () => {
        const c = new ClusteredLightContainer("clust");
        expect(c.horizontalTiles).toBe(64);
        expect(c.verticalTiles).toBe(64);
        expect(c.depthSlices).toBe(16);
        expect(c.maxRange).toBe(16383);
        expect(c.getClassName()).toBe("ClusteredLightContainer");
        expect(c.getTypeID()).toBe(5);
        expect(c.isSupported).toBe(true);
        expect(c.lights).toEqual([]);
    });

    it("proxies tiling setters to the Lite container", () => {
        const c = new ClusteredLightContainer("clust");
        c.horizontalTiles = 32;
        c.verticalTiles = 24;
        c.depthSlices = 8;
        const lite = liteContainer(c);
        expect(lite.horizontalTiles).toBe(32);
        expect(lite.verticalTiles).toBe(24);
        expect(lite.zSlices).toBe(8);
    });

    it("stores container intensity without touching a Lite light", () => {
        const c = new ClusteredLightContainer("clust");
        expect(c.intensity).toBe(1);
        c.intensity = 0.5;
        expect(c.intensity).toBe(0.5);
    });
});

describe("ClusteredLightContainer.IsLightSupported", () => {
    it("accepts point lights and rejects other light types", () => {
        const point = new PointLight("p", new Vector3(1, 2, 3));
        const dir = new DirectionalLight("d", new Vector3(0, -1, 0));
        expect(ClusteredLightContainer.IsLightSupported(point)).toBe(true);
        expect(ClusteredLightContainer.IsLightSupported(dir)).toBe(false);
    });
});

describe("ClusteredLightContainer.addLight / removeLight", () => {
    it("snapshots a point light into a Lite clustered point light", () => {
        const point = new PointLight("p", new Vector3(1, 2, 3));
        point.range = 7;
        point.intensity = 2;
        point.diffuse = new Color3(0.2, 0.4, 0.6);

        const c = new ClusteredLightContainer("clust", [point]);
        expect(c.lights).toEqual([point]);

        const pool = liteContainer(c).pointLights;
        expect(pool).toHaveLength(1);
        const first = pool[0]!;
        expect(first.position).toEqual([1, 2, 3]);
        expect(first.diffuse).toEqual([0.2, 0.4, 0.6]);
        expect(first.range).toBe(7);
        expect(first.intensity).toBe(2);
    });

    it("ignores unsupported light types and double-adds", () => {
        const dir = new DirectionalLight("d", new Vector3(0, -1, 0));
        const point = new PointLight("p", new Vector3(0, 0, 0));
        const c = new ClusteredLightContainer("clust");

        c.addLight(dir);
        expect(c.lights).toEqual([]);

        c.addLight(point);
        c.addLight(point); // already owned
        expect(c.lights).toEqual([point]);
        expect(liteContainer(c).pointLights).toHaveLength(1);
        expect(point._clusteredContainer).toBe(c);
    });

    it("removeLight returns the index and returns the light to the normal path", () => {
        const { scene, registered } = makeFakeScene(true);
        const point = new PointLight("p", new Vector3(0, 0, 0));
        const c = new ClusteredLightContainer("clust", [point], scene);

        const idx = c.removeLight(point);
        expect(idx).toBe(0);
        expect(c.lights).toEqual([]);
        expect(liteContainer(c).pointLights).toHaveLength(0);
        expect(point._clusteredContainer).toBeNull();
        // Re-registered on the scene and re-added to the Lite scene.
        expect(registered).toContain(point);
        expect(addToSceneSpy).toHaveBeenCalledWith(scene._lite, point._lite);

        expect(c.removeLight(point)).toBe(-1);
    });
});

describe("ClusteredLightContainer — scene wiring", () => {
    it("excludes an added light from the ordinary per-mesh light path", () => {
        const { scene, unregistered } = makeFakeScene(true);
        const point = new PointLight("p", new Vector3(0, 0, 0));
        const c = new ClusteredLightContainer("clust", [], scene);

        c.addLight(point);
        expect(unregistered).toContain(point);
        expect(removeFromSceneSpy).toHaveBeenCalledWith(scene._lite, point._lite);
    });

    it("registers the container on the Lite scene at build (GPU engine only)", () => {
        const { scene } = makeFakeScene(false);
        const c = new ClusteredLightContainer("clust", [], scene);
        c._build();
        expect(addClusteredSpy).toHaveBeenCalledWith(scene._lite, liteContainer(c));
        // Idempotent.
        c._build();
        expect(addClusteredSpy).toHaveBeenCalledTimes(1);
    });

    it("skips registration on the device-less NullEngine", () => {
        const { scene } = makeFakeScene(true);
        const c = new ClusteredLightContainer("clust", [], scene);
        c._build();
        expect(addClusteredSpy).not.toHaveBeenCalled();
    });
});
