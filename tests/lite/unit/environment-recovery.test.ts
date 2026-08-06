import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { buildHdrSkyboxRenderable } from "../../../packages/babylon-lite/src/material/pbr/background-hdr-skybox.js";
import { computeSceneSize } from "../../../packages/babylon-lite/src/material/pbr/scene-size.js";
import { parseEnvFile } from "../../../packages/babylon-lite/src/loader-env/env-parse.js";
import { rebuildSceneEnvironment, rebuildSceneEnvironmentBackgrounds } from "../../../packages/babylon-lite/src/loader-env/environment-recovery.js";
import type { EnvironmentRecoverySource } from "../../../packages/babylon-lite/src/loader-env/environment-recovery.js";
import type { EnvironmentTextures } from "../../../packages/babylon-lite/src/loader-env/load-env.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";

vi.mock("../../../packages/babylon-lite/src/loader-env/rgbd-decode.js", () => ({
    uploadCubemapRGBD: vi.fn(() => makeTexture("specular")),
    decodeBrdfPng: vi.fn(() => makeTexture("brdf")),
}));

vi.mock("../../../packages/babylon-lite/src/material/pbr/background-hdr-skybox.js", () => ({
    buildHdrSkyboxRenderable: vi.fn(() => ({ kind: "hdr-skybox" })),
}));

vi.mock("../../../packages/babylon-lite/src/material/pbr/scene-size.js", () => ({
    computeSceneSize: vi.fn(() => ({
        groundSize: 12,
        skyboxSize: 24,
        rootPosition: [1, 2, 3],
    })),
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

describe("rebuildSceneEnvironment", () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    function makeEngine(): EngineContext {
        return {
            _device: { createSampler: vi.fn(() => ({}) as GPUSampler) },
        } as unknown as EngineContext;
    }

    function makeScene(textures: EnvironmentTextures | undefined, source?: EnvironmentRecoverySource): SceneContext {
        return {
            _envTextures: textures,
            _envRecoverySource: source,
            _disposables: [],
        } as unknown as SceneContext;
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
        hasBackgrounds: false,
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

    it("fails loudly for loadEnvironment backgrounds, which recovery cannot rebuild", async () => {
        const textures = makeEnvironmentTextures();
        const scene = makeScene(textures, { ...envSource, hasBackgrounds: true });

        await expect(rebuildSceneEnvironment(makeEngine(), scene)).rejects.toThrow(/does not support loadEnvironment backgrounds/);
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

    it("restores an explicit HDR skybox size and position without recomputing scene bounds", async () => {
        const textures = makeEnvironmentTextures();
        const scene = {
            ...makeScene(textures),
            surface: { engine: makeEngine() },
        } as SceneContext;
        const source: EnvironmentRecoverySource = {
            kind: "hdr",
            url: "/assets/studio.hdr",
            faceSize: 256,
            useCubemapSkybox: true,
            skipGround: true,
            skyboxSize: 30,
            skyboxPosition: [4, 5, 6],
        };

        await expect(rebuildSceneEnvironmentBackgrounds(scene, source)).resolves.toHaveLength(1);

        expect(computeSceneSize).not.toHaveBeenCalled();
        expect(buildHdrSkyboxRenderable).toHaveBeenCalledWith(scene, textures, 15, [4, 5, 6], expect.any(Array));
    });
});
