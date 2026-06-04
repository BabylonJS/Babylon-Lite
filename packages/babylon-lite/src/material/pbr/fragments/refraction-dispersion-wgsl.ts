// Chromatic-dispersion refracted-environment sample (KHR_materials_dispersion).
//
// A pure data module: the per-RGB 3-ray WGSL is dynamically imported only by
// scenes that actually use dispersion (see pbr-refraction.ts), so it ships in
// no other transmission scene's bundle. The string is injected into the
// refraction fragment factory (makeRefractionRttExt) rather than mutating any
// shared module state, keeping shader generation scene-isolated.
//
// Splits the refracted ray into per-RGB index-of-refraction offsets, matching
// BJS pbrBlockSubSurface: realIOR=1/eta, spread=0.04*dispersion*(realIOR-1),
// iors=[1/(realIOR-spread), eta, 1/(realIOR+spread)].

/** Per-RGB chromatic-dispersion refracted-environment sample WGSL, injected into
 *  the refraction fragment when a scene contains a dispersive transmissive material. */
export const DISPERSION_SAMPLE_WGSL = `let eta=material.refractionParams.y;
let realIOR=1.0/eta;
let spread=0.04*material.volumeParams.w*(realIOR-1.0);
let etaR=1.0/(realIOR-spread);
let etaB=1.0/(realIOR+spread);
let cpR=scene.viewProjection*vec4<f32>(input.worldPos+refract(-V,N,etaR)*th,1.0);
let cpG=scene.viewProjection*vec4<f32>(input.worldPos+refract(-V,N,eta)*th,1.0);
let cpB=scene.viewProjection*vec4<f32>(input.worldPos+refract(-V,N,etaB)*th,1.0);
let uvR=(cpR.xy/cpR.w)*vec2<f32>(0.5,-0.5)+vec2<f32>(0.5,0.5);
let uvG=(cpG.xy/cpG.w)*vec2<f32>(0.5,-0.5)+vec2<f32>(0.5,0.5);
let uvB=(cpB.xy/cpB.w)*vec2<f32>(0.5,-0.5)+vec2<f32>(0.5,0.5);
let er=vec3<f32>(textureSampleLevel(refractionTexture,refractionSampler_,uvR,lv).r,textureSampleLevel(refractionTexture,refractionSampler_,uvG,lv).g,textureSampleLevel(refractionTexture,refractionSampler_,uvB,lv).b)*material.environmentIntensity;`;
