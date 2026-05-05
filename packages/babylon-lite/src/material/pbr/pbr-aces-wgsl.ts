/**
 * ACES Fitted tonemap WGSL helpers.
 * Kept in a separate module so scenes using the default exponential tonemap
 * don't pay the ~0.5 KB string cost. Dynamic-imported by pbr-renderable.ts only
 * when scene.imageProcessing.toneMappingType === "aces".
 */

export const ACES_HELPERS_WGSL = `
const ACESInputMat = mat3x3<f32>(vec3<f32>(0.59719,0.07600,0.02840),vec3<f32>(0.35458,0.90834,0.13383),vec3<f32>(0.04823,0.01566,0.83777));
const ACESOutputMat = mat3x3<f32>(vec3<f32>(1.60475,-0.10208,-0.00327),vec3<f32>(-0.53108,1.10813,-0.07276),vec3<f32>(-0.07367,-0.00605,1.07602));
fn RRTAndODTFit(v: vec3<f32>) -> vec3<f32> { let a = v*(v+0.0245786)-0.000090537; let b = v*(0.983729*v+0.4329510)+0.238081; return a/b; }
fn ACESFitted(color: vec3<f32>) -> vec3<f32> { var c = ACESInputMat*color; c = RRTAndODTFit(c); c = ACESOutputMat*c; return saturate(c); }
`;

export const ACES_TONEMAP_CALL_WGSL = `color *= scene.vImageInfos.x;
color = ACESFitted(color);`;
