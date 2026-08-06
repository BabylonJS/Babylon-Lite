import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { buildHdrSkyboxRenderable } from "../../../packages/babylon-lite/src/material/pbr/background-hdr-skybox.js";
import { computeSceneSize } from "../../../packages/babylon-lite/src/material/pbr/scene-size.js";
import { parseEnvFile } from "../../../packages/babylon-lite/src/loader-env/env-parse.js";
import { EnvironmentBackgroundKind, rebuildSceneEnvironment, rebuildSceneEnvironmentBackgrounds } from "../../../packages/babylon-lite/src/loader-env/environment-recovery.js";
import type { EnvironmentBackgroundSource, EnvironmentRecoverySource } from "../../../packages/babylon-lite/src/loader-env/environment-recovery.js";
import { buildDdsSkyboxRenderable } from "../../../packages/babylon-lite/src/material/pbr/background-dds-skybox.js";
import { buildGroundRenderable } from "../../../packages/babylon-lite/src/material/pbr/background-ground.js";
import type { EnvironmentTextures } from "../../../packages/babylon-lite/src/loader-env/load-env.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";

vi.mock("../../../packages/babylon-lite/src/loader-env/rgbd-decode.js", () => ({
    uploadCubemapRGBD: vi.fn(() => makeTexture("specular")),
    decodeBrdfPng: vi.fn(() => makeTexture("brdf")),
}));

vi.mock("../../../packages/babylon-lite/src/material/pbr/scene-size.js", () => ({
    computeSceneSize: vi.fn(() => ({ groundSize: 100, skyboxSize: 20, rootPosition: [0, 0, 0] })),
}));

vi.mock("../../../packages/babylon-lite/src/material/pbr/background-solid-skybox.js", () => ({
    buildSolidSkyboxRenderable: vi.fn(() => ({ order: 0, kind: "solid-skybox" })),
}));

vi.mock("../../../packages/babylon-lite/src/material/pbr/background-hdr-skybox.js", () => ({
    buildHdrSkyboxRenderable: vi.fn(() => ({ order: 0, kind: "hdr-skybox" })),
}));

vi.mock("../../../packages/babylon-lite/src/material/pbr/background-dds-skybox.js", () => ({
    buildDdsSkyboxRenderable: vi.fn(async () => ({ order: 0, kind: "dds-skybox" })),
}));

vi.mock("../../../packages/babylon-lite/src/material/pbr/background-ground.js", () => ({
    buildGroundRenderable: vi.fn(async () => ({ order: 1, kind: "ground" })),
}));

/** The subset of the fake texture the ref-count assertions need. */
type FakeTexture = { destroy: ReturnType<typeof vi.fn> };

function makeTexture(label: string): GPUTexture {
    return {
        label,
        createView: vi.fn(() => ({}) as GPUTextureView),
        destroy: vi.fn(),
    } as unknown as GPUTexture;
}

const SH_KEYS = ["x", "y", "z", "xx", "yy", "zz", "yz", "zx", "xy"] as const;

/** Build a byte-accurate `.env` container: 8-byte magic, NUL-terminated JSON manifest, then mip payloads. */
function buildEnvFile(options: { magic?: number[]; imageType?: string; width?: number } = {}): ArrayBuffer {
    const width = options.width ?? 1;
    const payloads = Array.from({ length: 6 }, (_, face) => new Uint8Array([100 + face, 200 + face, 300 - face]));
    const mipmaps: { position: number; length: number }[] = [];
    let position = 0;
    for (const payload of payloads) {
        mipmaps.push({ position, length: payload.length });
        position += payload.length;
    }

    const irradiance: Record<string, number[]> = {};
    SH_KEYS.forEach((key, index) => {
        irradiance[key] = [index * 3, index * 3 + 1, index * 3 + 2];
    });

    const manifest: Record<string, unknown> = { width, irradiance, specular: { mipmaps } };
    if (options.imageType) {
        manifest.imageType = options.imageType;
    }

    const json = new TextEncoder().encode(JSON.stringify(manifest));
    const magic = options.magic ?? [0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36];
    const bytes = new Uint8Array(magic.length + json.length + 1 + position);
    bytes.set(magic, 0);
    bytes.set(json, magic.length);
    bytes[magic.length + json.length] = 0;
    let offset = magic.length + json.length + 1;
    for (const payload of payloads) {
        bytes.set(payload, offset);
        offset += payload.length;
    }
    return bytes.buffer;
}

describe("parseEnvFile", () => {
    it("rejects a buffer whose magic header is not a Babylon .env file", () => {
        expect(() => parseEnvFile(buildEnvFile({ magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }))).toThrow(/Invalid \.env file: bad magic/);
    });

    it("expands the irradiance polynomial into 27 floats in x,y,z,xx,yy,zz,yz,zx,xy order", () => {
        const { irradianceSH } = parseEnvFile(buildEnvFile());

        expect(irradianceSH).toHaveLength(27);
        expect([...irradianceSH]).toEqual(Array.from({ length: 27 }, (_, index) => index));
    });

    it("slices mip payloads at offsets relative to the end of the manifest, not the start of the file", async () => {
        const { faceBlobs } = parseEnvFile(buildEnvFile());

        expect(faceBlobs).toHaveLength(6);
        const first = new Uint8Array(await faceBlobs[0]!.arrayBuffer());
        const last = new Uint8Array(await faceBlobs[5]!.arrayBuffer());
        expect([...first]).toEqual([100, 200, 44]);
        expect([...last]).toEqual([105, 205, 39]);
    });

    it("derives a full mip chain from the face width", () => {
        expect(parseEnvFile(buildEnvFile({ width: 256 })).mipCount).toBe(9);
        expect(parseEnvFile(buildEnvFile({ width: 1 })).mipCount).toBe(1);
    });

    it("defaults the blob MIME type to image/png and honours an explicit imageType", () => {
        expect(parseEnvFile(buildEnvFile()).faceBlobs[0]!.type).toBe("image/png");
        expect(parseEnvFile(buildEnvFile({ imageType: "image/webp" })).faceBlobs[0]!.type).toBe("image/webp");
    });
});

function makeEngine(): EngineContext {
    return {
        _device: { createSampler: vi.fn(() => ({}) as GPUSampler) },
    } as unknown as EngineContext;
}

function makeEnvironmentTextures(): EnvironmentTextures {
    return {
        specularCube: makeTexture("original-specular"),
        brdfLut: makeTexture("original-brdf"),
        irradianceSH: new Float32Array(27),
        sphericalHarmonics: new Float32Array(36),
        lodGenerationScale: 0.8,
    } as unknown as EnvironmentTextures;
}

describe("rebuildSceneEnvironment", () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    function makeScene(textures: EnvironmentTextures | undefined, source?: EnvironmentRecoverySource): SceneContext {
        return {
            _envTextures: textures,
            _envRecoverySource: source,
            _disposables: [],
        } as unknown as SceneContext;
    }

    function stubNetwork(): void {
        const env = buildEnvFile();
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => (url.endsWith(".env") ? new Response(env) : new Response(new Uint8Array([137, 80, 78, 71]))))
        );
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap)
        );
    }

    const envSource: EnvironmentRecoverySource = {
        kind: "env",
        url: "/assets/studio.env",
        brdfUrl: "/assets/brdf.png",
    };

    it("is a no-op for a scene that never loaded an environment", async () => {
        const scene = makeScene(undefined);

        await expect(rebuildSceneEnvironment(makeEngine(), scene)).resolves.toBeNull();
        expect(scene._disposables).toHaveLength(0);
    });

    it("fails loudly when the environment was loaded before recovery capture was enabled", async () => {
        const textures = makeEnvironmentTextures();
        const scene = makeScene(textures);

        await expect(rebuildSceneEnvironment(makeEngine(), scene)).rejects.toThrow(/requires environment loading after recovery was enabled/);
        // The guards run before the textures are detached, so a scene that cannot recover is not
        // additionally left without its environment while the error propagates.
        expect(scene._envTextures).toBe(textures);
    });

    it("rebuilds a scene whose environment also owns loader-built backgrounds", async () => {
        stubNetwork();
        const textures = makeEnvironmentTextures();
        const scene = makeScene(textures, envSource);

        // Backgrounds used to abort recovery outright; the textures must now rebuild like any other
        // environment. The background renderables themselves are recreated separately, from the
        // descriptors recovery discovers on them, so this path is unaffected by their presence.
        await expect(rebuildSceneEnvironment(makeEngine(), scene)).resolves.toEqual(envSource);
        expect(scene._envTextures).toBe(textures);
    });

    it("names the URL and status when a recovery source can no longer be fetched", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("<!doctype html>", { status: 404, statusText: "Not Found" }))
        );
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap)
        );
        const scene = makeScene(makeEnvironmentTextures(), envSource);

        // Without the status check this surfaces as "Invalid .env file: bad magic", which names
        // neither the asset nor the reason it went missing.
        await expect(rebuildSceneEnvironment(makeEngine(), scene)).rejects.toThrow(/could not refetch '\/assets\/studio\.env' \(404 Not Found\)/);
    });

    it("preserves the EnvironmentTextures identity and its spherical harmonics across a rebuild", async () => {
        stubNetwork();
        const textures = makeEnvironmentTextures();
        const originalHarmonics = textures.sphericalHarmonics;
        const originalCube = textures.specularCube;
        const scene = makeScene(textures, envSource);

        await expect(rebuildSceneEnvironment(makeEngine(), scene)).resolves.toEqual(envSource);

        expect(scene._envTextures).toBe(textures);
        expect(scene._envRecoverySource).toEqual(envSource);
        // Re-parsing the same file rebuilds an identical polynomial, so recovery reuses the existing
        // pre-scaled array rather than allocating a fresh one the scene UBO would have to re-read.
        expect(textures.sphericalHarmonics).toBe(originalHarmonics);
        expect(textures.specularCube).not.toBe(originalCube);
    });

    it("releases every generation of replacement textures, not just the most recent one", async () => {
        stubNetwork();
        const engine = makeEngine();
        const textures = makeEnvironmentTextures();
        const scene = makeScene(textures, envSource);

        await rebuildSceneEnvironment(engine, scene);
        const first = {
            specularCube: textures.specularCube as unknown as FakeTexture,
            brdfLut: textures.brdfLut as unknown as FakeTexture,
        };

        await rebuildSceneEnvironment(engine, scene);
        const second = {
            specularCube: textures.specularCube as unknown as FakeTexture,
            brdfLut: textures.brdfLut as unknown as FakeTexture,
        };

        expect(second.specularCube).not.toBe(first.specularCube);
        expect(scene._disposables).toHaveLength(2);

        for (const dispose of scene._disposables) {
            dispose();
        }

        // A disposable that read the textures at disposal time would have released the second
        // generation twice and leaked the first, so assert each generation is destroyed exactly once.
        for (const texture of [first.specularCube, first.brdfLut, second.specularCube, second.brdfLut]) {
            expect(texture.destroy).toHaveBeenCalledOnce();
        }
    });
});

describe("rebuildSceneEnvironmentBackgrounds", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    function makeBackgroundScene(textures: EnvironmentTextures | undefined): SceneContext {
        return {
            _envTextures: textures,
            surface: { engine: makeEngine() },
        } as unknown as SceneContext;
    }

    const kinds = async (backgrounds: EnvironmentBackgroundSource[]) =>
        (await rebuildSceneEnvironmentBackgrounds(makeBackgroundScene(makeEnvironmentTextures()), backgrounds)).map(
            (renderable) => (renderable as unknown as { kind: string }).kind
        );

    it("builds nothing for a scene that never loaded an environment", async () => {
        await expect(rebuildSceneEnvironmentBackgrounds(makeBackgroundScene(undefined), [])).resolves.toEqual([]);
    });

    it("builds nothing for an environment that owns no backgrounds", async () => {
        await expect(rebuildSceneEnvironmentBackgrounds(makeBackgroundScene(makeEnvironmentTextures()), [])).resolves.toEqual([]);
    });

    it("rebuilds an HDR skybox, the Viewer's `environmentSkybox` case", async () => {
        // One .env drives both the IBL and the backdrop, so `loadEnvironment` skips the solid
        // skybox and builds the HDR one instead.
        await expect(kinds([[EnvironmentBackgroundKind.HdrSkybox, 10, [0, 0, 0]]])).resolves.toEqual(["hdr-skybox"]);
    });

    it("restores the exact size and position each background was built with, never recomputing scene bounds", async () => {
        // The descriptor records the values the builder actually used, so an explicitly placed
        // skybox (`skyboxSize` + `skyboxPosition`) survives recovery unchanged. Discovery extends
        // that guarantee to every background: scene bounds are never re-derived, so a scene whose
        // contents shifted after load cannot have its backdrop silently resized or moved.
        const scene = makeBackgroundScene(makeEnvironmentTextures());
        const textures = scene._envTextures;

        await expect(rebuildSceneEnvironmentBackgrounds(scene, [[EnvironmentBackgroundKind.HdrSkybox, 15, [4, 5, 6]]])).resolves.toHaveLength(1);

        expect(computeSceneSize).not.toHaveBeenCalled();
        expect(buildHdrSkyboxRenderable).toHaveBeenCalledWith(scene, textures, 15, [4, 5, 6], expect.any(Array));
    });

    it("rebuilds a DDS skybox from its discovered URL", async () => {
        const url = "/assets/backgroundSkybox.dds";
        await expect(kinds([[EnvironmentBackgroundKind.DdsSkybox, 10, [0, 0, 0], url]])).resolves.toEqual(["dds-skybox"]);
        expect(buildDdsSkyboxRenderable).toHaveBeenCalledWith(expect.anything(), 10, [0, 0, 0], expect.anything(), url);
    });

    it("rebuilds the ground from its discovered URL", async () => {
        const url = "/assets/backgroundGround.png";
        await expect(kinds([[EnvironmentBackgroundKind.Ground, 100, [0, 0, 0], url]])).resolves.toEqual(["ground"]);
        // The preloaded ImageBitmap from the original load belongs to the lost device, so recovery
        // must pass only the URL and let the builder refetch it.
        expect(buildGroundRenderable).toHaveBeenCalledWith(expect.anything(), 100, [0, 0, 0], expect.anything(), url);
    });

    it("rebuilds every discovered background, in scene order", async () => {
        await expect(
            kinds([
                [EnvironmentBackgroundKind.SolidSkybox, 10, [0, 0, 0]],
                [EnvironmentBackgroundKind.Ground, 100, [0, 0, 0]],
            ])
        ).resolves.toEqual(["solid-skybox", "ground"]);
    });

    it("rebuilds HDR-environment backgrounds through the same descriptors", async () => {
        await expect(
            kinds([
                [EnvironmentBackgroundKind.HdrSkybox, 10, [0, 0, 0]],
                [EnvironmentBackgroundKind.Ground, 100, [0, 0, 0]],
            ])
        ).resolves.toEqual(["hdr-skybox", "ground"]);
    });
});
