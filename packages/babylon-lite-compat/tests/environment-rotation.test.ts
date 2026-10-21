import { describe, expect, it } from "vitest";

import { NullEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";
import { CubeTexture, HDRCubeTexture } from "../src/textures/textures";

type EnvironmentTexture = CubeTexture | HDRCubeTexture;

const textures: [string, (scene: Scene) => EnvironmentTexture][] = [
    ["CubeTexture", (scene) => CubeTexture.CreateFromPrefilteredData("https://example.com/studio.env", scene)],
    ["HDRCubeTexture", (scene) => new HDRCubeTexture("https://example.com/studio.hdr", scene, 256)],
];

/** The environment rotation Lite feeds to the IBL lighting and the environment skybox. */
function liteRotation(scene: Scene): number | undefined {
    return scene._lite._environmentRotation;
}

describe.each(textures)("compat %s rotationY", (_name, create) => {
    it("forwards a rotation set after the texture became the scene environment", () => {
        const scene = new Scene(new NullEngine());
        const texture = create(scene);
        scene.environmentTexture = texture;

        texture.rotationY = Math.PI / 2;

        expect(texture.rotationY).toBe(Math.PI / 2);
        expect(liteRotation(scene)).toBe(Math.PI / 2);
        // The rotated skybox patch is registered with it, so the visible environment turns with the lighting.
        expect(scene._lite._environmentSkyboxShaderPatchLoaders).toHaveLength(1);

        texture.rotationY = -0.25;
        expect(liteRotation(scene)).toBe(-0.25);
    });

    it("applies a rotation set before the texture is assigned", () => {
        const scene = new Scene(new NullEngine());
        const texture = create(scene);
        texture.rotationY = 1.25;
        expect(liteRotation(scene)).toBeUndefined();

        scene.environmentTexture = texture;

        expect(liteRotation(scene)).toBe(1.25);
    });

    it("leaves Lite untouched for an environment that is never rotated", () => {
        const scene = new Scene(new NullEngine());
        scene.environmentTexture = create(scene);

        expect(liteRotation(scene)).toBeUndefined();
        expect(scene._lite._environmentSkyboxShaderPatchLoaders).toBeUndefined();
    });

    it("follows the texture assigned through createDefaultSkybox", () => {
        const scene = new Scene(new NullEngine());
        const texture = create(scene);
        scene.createDefaultSkybox(texture, true, 1000);

        texture.rotationY = 0.5;

        expect(liteRotation(scene)).toBe(0.5);
    });
});

describe("compat environment rotation ownership", () => {
    it("takes the rotation of a replacing texture and stops following the replaced one", () => {
        const scene = new Scene(new NullEngine());
        const first = CubeTexture.CreateFromPrefilteredData("https://example.com/a.env", scene);
        const second = new HDRCubeTexture("https://example.com/b.hdr", scene, 256);
        first.rotationY = 1;
        scene.environmentTexture = first;

        scene.environmentTexture = second;
        expect(liteRotation(scene)).toBe(0);
        first.rotationY = 2;
        expect(liteRotation(scene)).toBe(0);

        second.rotationY = 3;
        expect(liteRotation(scene)).toBe(3);
        scene.environmentTexture = null;
        expect(liteRotation(scene)).toBe(0);
    });

    it("rotates every scene that uses the same texture", () => {
        const engine = new NullEngine();
        const a = new Scene(engine);
        const b = new Scene(engine);
        const texture = CubeTexture.CreateFromPrefilteredData("https://example.com/studio.env", a);
        a.environmentTexture = texture;
        b.environmentTexture = texture;

        texture.rotationY = 0.75;

        expect(liteRotation(a)).toBe(0.75);
        expect(liteRotation(b)).toBe(0.75);
    });

    it("forgets a disposed scene", () => {
        const scene = new Scene(new NullEngine());
        const texture = CubeTexture.CreateFromPrefilteredData("https://example.com/studio.env", scene);
        scene.environmentTexture = texture;

        scene.dispose();

        expect(texture._envOwners?.has(scene)).toBe(false);
        expect(() => (texture.rotationY = 1)).not.toThrow();
    });
});
