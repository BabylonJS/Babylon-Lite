import { describe, expect, it } from "vitest";

import ddsSkyboxFragment from "../../babylon-lite/shaders/skybox-dds.fragment.wgsl?raw";
import hdrSkyboxFragment from "../../babylon-lite/shaders/skybox-hdr.fragment.wgsl?raw";
import { NullEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";
import { CubeTexture, HDRCubeTexture } from "../src/textures/textures";

type EnvironmentTexture = CubeTexture | HDRCubeTexture;

const textures: [string, (scene: Scene) => EnvironmentTexture][] = [
    ["CubeTexture", (scene) => CubeTexture.CreateFromPrefilteredData("https://example.com/studio.env", scene)],
    ["HDRCubeTexture", (scene) => new HDRCubeTexture("https://example.com/studio.hdr", scene, 256)],
];

/** The rotation Lite feeds to the image-based lighting. */
function lightingRotation(scene: Scene): number | undefined {
    return scene._lite._environmentRotation;
}

/** Run one compat frame: the scene picks up `rotationY` changes made since the previous frame. */
function frame(scene: Scene): void {
    scene._tick(16);
}

/** Compose a visible skybox fragment the way Lite does when it builds the skybox. */
async function buildSkyboxFragment(scene: Scene, fragment: string, kind: "dds" | "hdr"): Promise<string> {
    return (await scene._lite._environmentSkyboxShaderComposer?.(fragment, kind)) ?? fragment;
}

describe.each(textures)("compat %s rotationY", (_name, create) => {
    it("turns the lighting with a rotation set after the texture became the scene environment", () => {
        const scene = new Scene(new NullEngine());
        const texture = create(scene);
        scene.environmentTexture = texture;

        texture.rotationY = Math.PI / 2;
        frame(scene);

        expect(texture.rotationY).toBe(Math.PI / 2);
        expect(lightingRotation(scene)).toBe(Math.PI / 2);
        // Lighting only: no skybox patch, so a visible skybox keeps its own orientation.
        expect(scene._lite._environmentSkyboxShaderPatchLoaders).toBeUndefined();

        texture.rotationY = -0.25;
        frame(scene);
        expect(lightingRotation(scene)).toBe(-0.25);
    });

    it("applies a rotation set before the texture is assigned", () => {
        const scene = new Scene(new NullEngine());
        const texture = create(scene);
        texture.rotationY = 1.25;

        scene.environmentTexture = texture;

        expect(lightingRotation(scene)).toBe(1.25);
    });

    it("leaves Lite untouched for an environment that is never rotated", () => {
        const scene = new Scene(new NullEngine());
        scene.environmentTexture = create(scene);
        frame(scene);

        expect(lightingRotation(scene)).toBeUndefined();
        expect(scene._lite._environmentSkyboxShaderPatchLoaders).toBeUndefined();
    });

    // Babylon.js builds the skybox from a clone of the texture: it keeps the rotation it was created with, while later
    // rotationY changes turn only the lighting.
    it("keeps the createDefaultSkybox skybox at its creation-time rotation", async () => {
        const scene = new Scene(new NullEngine());
        const texture = create(scene);
        texture.rotationY = 0.5;
        scene.createDefaultSkybox(texture, true, 1000);

        texture.rotationY = 1;
        frame(scene);

        expect(lightingRotation(scene)).toBe(1);
        for (const [fragment, kind] of [
            [hdrSkyboxFragment, "hdr"],
            [ddsSkyboxFragment, "dds"],
        ] as const) {
            const skybox = await buildSkyboxFragment(scene, fragment, kind);
            expect(skybox).toContain("let _erc=cos(f32(0.5));let _ers=sin(f32(0.5));");
            expect(skybox).not.toContain("cos(scene.envRotationY)");
        }
    });

    it("leaves an unrotated createDefaultSkybox skybox unrotated when the lighting turns", async () => {
        const scene = new Scene(new NullEngine());
        const texture = create(scene);
        scene.createDefaultSkybox(texture, true, 1000);

        texture.rotationY = 0.5;
        frame(scene);

        expect(lightingRotation(scene)).toBe(0.5);
        expect(await buildSkyboxFragment(scene, hdrSkyboxFragment, "hdr")).toBe(hdrSkyboxFragment);
    });
});

describe("compat environment rotation", () => {
    // createDefaultEnvironment draws its own DDS background, which does not use the environment texture.
    it("never turns the createDefaultEnvironment background", async () => {
        const scene = new Scene(new NullEngine());
        const texture = CubeTexture.CreateFromPrefilteredData("https://example.com/studio.env", scene);
        texture.rotationY = 0.5;
        scene.environmentTexture = texture;
        scene.createDefaultEnvironment();

        texture.rotationY = 1;
        frame(scene);

        expect(lightingRotation(scene)).toBe(1);
        expect(await buildSkyboxFragment(scene, ddsSkyboxFragment, "dds")).toBe(ddsSkyboxFragment);
    });

    it("takes the rotation of a replacing texture and stops following the replaced one", () => {
        const scene = new Scene(new NullEngine());
        const first = CubeTexture.CreateFromPrefilteredData("https://example.com/a.env", scene);
        const second = new HDRCubeTexture("https://example.com/b.hdr", scene, 256);
        first.rotationY = 1;
        scene.environmentTexture = first;

        scene.environmentTexture = second;
        expect(lightingRotation(scene)).toBe(0);
        first.rotationY = 2;
        frame(scene);
        expect(lightingRotation(scene)).toBe(0);

        second.rotationY = 3;
        frame(scene);
        expect(lightingRotation(scene)).toBe(3);
        scene.environmentTexture = null;
        expect(lightingRotation(scene)).toBe(0);
    });

    it("turns every scene that uses the same texture", () => {
        const engine = new NullEngine();
        const a = new Scene(engine);
        const b = new Scene(engine);
        const texture = CubeTexture.CreateFromPrefilteredData("https://example.com/studio.env", a);
        a.environmentTexture = texture;
        b.environmentTexture = texture;

        texture.rotationY = 0.75;
        frame(a);
        frame(b);

        expect(lightingRotation(a)).toBe(0.75);
        expect(lightingRotation(b)).toBe(0.75);
    });

    // The scene reads the texture's rotation each frame and the texture keeps no reference to the scenes that use it, so a
    // texture reused across renderer remounts does not retain a scene torn down without Scene.dispose() (for example by
    // disposing only its engine). A device-less NullEngine cannot run disposeEngine, so the old scene is just abandoned.
    it("keeps a texture usable by a new scene without retaining the abandoned one", () => {
        const oldScene = new Scene(new NullEngine());
        const texture = CubeTexture.CreateFromPrefilteredData("https://example.com/studio.env", oldScene);
        oldScene.environmentTexture = texture;
        texture.rotationY = 0.5;
        frame(oldScene);

        const scene = new Scene(new NullEngine());
        scene.environmentTexture = texture;
        texture.rotationY = 0.75;
        frame(scene);

        expect(lightingRotation(scene)).toBe(0.75);
        expect(Object.values(texture).some((value) => value === oldScene || value instanceof Set)).toBe(false);
    });
});
