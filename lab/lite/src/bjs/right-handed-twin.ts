// Shared by the right-handed twin references (scenes 321+): makes every Babylon.js scene created
// after this module evaluates right-handed, as if each one set `scene.useRightHandedSystem = true`
// right after construction. A twin reference imports this module, then the original scene's
// reference unchanged, so the two can never drift apart.
import { Scene } from "@babylonjs/core/scene";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";

Object.defineProperty(Scene.prototype, "_useRightHandedSystem", {
    configurable: true,
    get: () => true,
    set: () => {},
});

// Babylon.js bug (9.28): a right-handed scene refracts a cube texture through `_textureMatrixRefraction`,
// which starts as a zero matrix and is only computed when `rotationY` is set, so an unrotated cube
// refracts direction (0, 0, 0). Its right-handed refraction matrix is then the identity, like its
// reflection matrix, so the reference uses that instead of sampling a degenerate direction.
const getRefractionTextureMatrix = CubeTexture.prototype.getRefractionTextureMatrix;
CubeTexture.prototype.getRefractionTextureMatrix = function (this: CubeTexture) {
    const matrix = getRefractionTextureMatrix.call(this);
    return matrix.m.every((v) => v === 0) ? this.getReflectionTextureMatrix() : matrix;
};
