// Scene 342 — Babylon.js reference for the right-handed twin of scene 265. Babylon.js 9.28 renders this
// glTF's EXT_lights_image_based lighting wrongly in a right-handed scene (the white dielectric row turns
// black, even with the light's rotation inverted), while a right-handed scene must look exactly like its
// left-handed source. The reference is therefore scene 265's, left-handed (see BJS_RH_BROKEN in
// handedness-guard.test.ts).
import "./scene265";
