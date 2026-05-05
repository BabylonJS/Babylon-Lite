struct SceneUniforms {
viewProjection: mat4x4<f32>,
view: mat4x4<f32>,
vEyePosition: vec4<f32>,
envRotationY: f32,
_envPad0: f32, _envPad1: f32, _envPad2: f32,
vSphericalL00: vec4<f32>,
vSphericalL1_1: vec4<f32>,
vSphericalL10: vec4<f32>,
vSphericalL11: vec4<f32>,
vSphericalL2_2: vec4<f32>,
vSphericalL2_1: vec4<f32>,
vSphericalL20: vec4<f32>,
vSphericalL21: vec4<f32>,
vSphericalL22: vec4<f32>,
vImageInfos: vec4<f32>, // exposureLinear, contrast, lodGenerationScale, toneMappingEnabled
vFogInfos: vec4<f32>,
vFogColor: vec4<f32>,
}
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
