export type { Bounds2D, Vec3, Vec3Tuple, Vec4, Color3, Color4, Mat4, Quat, Mat4Storage } from "./types.js";
export { randomRange } from "./random-range.js";
export { linearToSrgbByte, srgbByteToLinear, packedSrgbToLinearRgba } from "./color.js";
export { copyColor4, scaleColor4ToRef } from "./color4-ref.js";
export { vec3 } from "./vec3-ctor.js";
export { Vec3Up } from "./vec3-up.js";
export { addVec3 } from "./add-vec3.js";
export { subtractVec3 } from "./subtract-vec3.js";
export { scaleVec3 } from "./scale-vec3.js";
export { dotVec3 } from "./dot-vec3.js";
export { crossVec3 } from "./cross-vec3.js";
export { lengthVec3 } from "./length-vec3.js";
export { normalizeVec3TupleOrUp } from "./normalize-vec3-tuple-or-up.js";
export { normalizeVec3 } from "./normalize-vec3.js";
export { negateVec3 } from "./negate-vec3.js";
export { lerpVec3 } from "./lerp-vec3.js";
export { sampleHermiteSpline, sampleCatmullRomSpline } from "./curve-splines.js";
export { expDampFactor, dampScalar, lerpAngleShortest } from "./damp.js";
export {
    addVec3InPlace,
    addVec3ToRef,
    copyVec3,
    crossVec3InPlace,
    crossVec3ToRef,
    lerpVec3InPlace,
    lerpVec3ToRef,
    negateVec3InPlace,
    negateVec3ToRef,
    normalizeVec3InPlace,
    normalizeVec3ToRef,
    scaleVec3InPlace,
    scaleVec3ToRef,
    subtractVec3InPlace,
    subtractVec3ToRef,
} from "./vec3-ref.js";
export { writeVec3 } from "./write-vec3.js";
export { createIdentityMat4 } from "./create-identity-mat4.js";
export { multiplyMat4 } from "./multiply-mat4.js";
export { createLookAtMat4LH } from "./create-look-at-mat4-lh.js";
export { createPerspectiveMat4LH } from "./create-perspective-mat4-lh.js";
export { writePerspectiveMat4LHIntoBuffer } from "./write-perspective-mat4-lh-into-buffer.js";
export { writeOrthoOffCenterMat4LHIntoBuffer } from "./write-ortho-off-center-mat4-lh-into-buffer.js";
export { invertMat4 } from "./invert-mat4.js";
export { createScalingMat4 } from "./create-scaling-mat4.js";
export { createTranslationMat4 } from "./create-translation-mat4.js";
export { createMat4FromQuat, writeMat4FromQuatIntoBuffer } from "./create-mat4-from-quat.js";
export { composeMat4 } from "./compose-mat4.js";
export { composeMat4IntoBuffer } from "./compose-mat4-into-buffer.js";
export { multiplyMat4IntoBuffer } from "./multiply-mat4-into-buffer.js";
export { transformCoordinatesToRef, transformNormalToRef, mat4GetTranslationToRef } from "./mat4-transform.js";
export type { Aabb } from "./aabb.js";
export { computeAabb } from "./aabb.js";
export { ObservableVec3 } from "./observable-vec3.js";
export { ObservableQuat } from "./observable-quat.js";
export { packMat4IntoF32 } from "./pack-mat4-into-f32.js";
export { shToPolynomial } from "./spherical-harmonics.js";
