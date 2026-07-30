import { beforeEach, describe, expect, it, vi } from "vitest";

const liteMocks = vi.hoisted(() => ({
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

import type { EngineContext } from "babylon-lite";

import { resolveKtxUrl, CubeTexture, HDRCubeTexture, Texture } from "../src/textures/textures";
import type { EngineContext } from "babylon-lite";

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function engineWrapper(): { _lite: EngineContext } {
    return { _lite: {} as EngineContext };
}

function textureHandle(): unknown {
    return { id: "texture" };
}

beforeEach(() => {
    for (const mock of Object.values(liteMocks)) {
        mock.mockReset();
    }
});

/**
 * `resolveKtxUrl` recognises a pre-resolved compressed `.ktx` URL (the single
 * fully-qualified URL Babylon.js code hands `Texture` after selecting a format via
 * `engine.getCaps()`) and splits it into the `{ baseUrl, suffix }` pair Lite's
 * `loadKtxTexture2D` expects. The query string must survive onto the base URL.
 */
describe("resolveKtxUrl", () => {
    it("splits a compressed KTX URL into base image + format suffix", () => {
        expect(resolveKtxUrl("https://h/UVgrid-dxt.ktx")).toEqual({ baseUrl: "https://h/UVgrid.png", suffix: "-dxt.ktx" });
        expect(resolveKtxUrl("https://h/UVgrid-astc.ktx")).toEqual({ baseUrl: "https://h/UVgrid.png", suffix: "-astc.ktx" });
        expect(resolveKtxUrl("https://h/UVgrid-etc2.ktx")).toEqual({ baseUrl: "https://h/UVgrid.png", suffix: "-etc2.ktx" });
    });

    it("preserves a query string on the base URL (auth / cache-busting / signed URLs)", () => {
        expect(resolveKtxUrl("https://h/UVgrid-dxt.ktx?cache=1&sig=abc")).toEqual({
            baseUrl: "https://h/UVgrid.png?cache=1&sig=abc",
            suffix: "-dxt.ktx",
        });
    });

    it("returns null for non-compressed-KTX URLs", () => {
        expect(resolveKtxUrl("https://h/UVgrid.png")).toBeNull();
        expect(resolveKtxUrl("https://h/UVgrid.ktx")).toBeNull(); // no recognised format suffix
        expect(resolveKtxUrl("https://h/model.basis")).toBeNull();
    });
});

describe("Texture onLoadObservable", () => {
    it("does not allocate the observable when nobody subscribes", async () => {
        const load = deferred<unknown>();
        liteMocks.loadTexture2D.mockReturnValueOnce(load.promise);

        const tex = new Texture("https://h/albedo.png", engineWrapper());
        expect((tex as unknown as { _onLoadObservable?: unknown })._onLoadObservable).toBeUndefined();

        load.resolve(textureHandle());
        await tex.whenReadyAsync();

        expect(tex.isReady()).toBe(true);
        expect((tex as unknown as { _onLoadObservable?: unknown })._onLoadObservable).toBeUndefined();
    });

    it("fires once with the constructor onLoad callback and whenReadyAsync", async () => {
        const load = deferred<unknown>();
        liteMocks.loadTexture2D.mockReturnValueOnce(load.promise);
        let onLoadCalls = 0;
        let observerCalls = 0;
        const events: string[] = [];

        const tex = new Texture("https://h/albedo.png", engineWrapper(), undefined, undefined, undefined, () => {
            events.push("onLoad");
            onLoadCalls++;
        });
        tex.onLoadObservable.add((observed) => {
            events.push("observable");
            observerCalls++;
            expect(observed).toBe(tex);
        });

        load.resolve(textureHandle());
        await tex.whenReadyAsync();

        expect(tex.isReady()).toBe(true);
        expect(onLoadCalls).toBe(1);
        expect(observerCalls).toBe(1);
        expect(events).toEqual(["observable", "onLoad"]);
    });

    it("fires immediately for subscribers attached after the texture is ready", async () => {
        const load = deferred<unknown>();
        liteMocks.loadTexture2D.mockReturnValueOnce(load.promise);
        const tex = new Texture("https://h/albedo.png", engineWrapper());

        load.resolve(textureHandle());
        await tex.whenReadyAsync();

        let addCalls = 0;
        let addOnceCalls = 0;
        tex.onLoadObservable.add((observed) => {
            addCalls++;
            expect(observed).toBe(tex);
        });
        tex.onLoadObservable.addOnce((observed) => {
            addOnceCalls++;
            expect(observed).toBe(tex);
        });

        expect(addCalls).toBe(1);
        expect(addOnceCalls).toBe(1);
    });

    it("does not double-fire when a constructor onLoad callback subscribes", async () => {
        const load = deferred<unknown>();
        liteMocks.loadTexture2D.mockReturnValueOnce(load.promise);
        let observerCalls = 0;
        const state: { tex?: Texture } = {};

        const tex = new Texture("https://h/albedo.png", engineWrapper(), undefined, undefined, undefined, () => {
            state.tex!.onLoadObservable.add((observed) => {
                observerCalls++;
                expect(observed).toBe(state.tex);
            });
        });
        state.tex = tex;

        load.resolve(textureHandle());
        await tex.whenReadyAsync();

        expect(observerCalls).toBe(1);
    });

    it("notifies attached materials after constructor onLoad configuration", async () => {
        const load = deferred<unknown>();
        liteMocks.loadTexture2D.mockReturnValueOnce(load.promise);
        const state: { tex?: Texture } = {};
        const observedScales: number[] = [];
        const tex = new Texture("https://h/albedo.png", engineWrapper(), undefined, undefined, undefined, () => {
            state.tex!.uScale = 2;
        });
        state.tex = tex;
        tex._onReady(() => observedScales.push(tex.uScale));

        load.resolve(textureHandle());
        await tex.whenReadyAsync();

        expect(observedScales).toEqual([2]);
    });

    it("notifies attached materials even when an onLoadObservable observer throws", async () => {
        const load = deferred<unknown>();
        liteMocks.loadTexture2D.mockReturnValueOnce(load.promise);
        const tex = new Texture("https://h/albedo.png", engineWrapper());
        let readyCalls = 0;
        tex.onLoadObservable.add(() => {
            throw new Error("observer failed");
        });
        tex._onReady(() => readyCalls++);

        load.resolve(textureHandle());
        await expect(tex.whenReadyAsync()).rejects.toThrow("observer failed");

        expect(readyCalls).toBe(1);
    });
});

/**
 * `HDRCubeTexture` is a lightweight environment handle (like `CubeTexture`): it
 * records the `.hdr` URL and requested face size, resolves a readiness signal on a
 * microtask, and carries the `_envLoaderKind: "hdr"` marker the `Scene` reads to
 * route the environment through Lite's native `loadHdrEnvironment` at engine start.
 */
describe("HDRCubeTexture", () => {
    it("records url + size and marks itself as an HDR-loader handle", () => {
        const tex = new HDRCubeTexture("https://h/room.hdr", null, 512);
        expect(tex.url).toBe("https://h/room.hdr");
        expect(tex.name).toBe("https://h/room.hdr");
        expect(tex.size).toBe(512);
        expect(tex._envLoaderKind).toBe("hdr");
    });

    it("defaults the face size to 256", () => {
        expect(new HDRCubeTexture("https://h/room.hdr").size).toBe(256);
    });

    it("fires onLoad + onLoadObservable and flips isReady on a microtask", async () => {
        let loaded = false;
        const tex = new HDRCubeTexture("https://h/room.hdr", null, 256, false, false, false, false, () => {
            loaded = true;
        });
        expect(tex.isReady()).toBe(false);
        const observed = await new Promise<HDRCubeTexture>((resolve) => tex.onLoadObservable.add(resolve));
        expect(observed).toBe(tex);
        expect(loaded).toBe(true);
        expect(tex.isReady()).toBe(true);
    });

    it("is distinct from the plain CubeTexture loader kind", () => {
        expect(new CubeTexture("https://h/env.env")._envLoaderKind).toBe("cube");
        expect(new HDRCubeTexture("https://h/room.hdr")._envLoaderKind).toBe("hdr");
    });
});
