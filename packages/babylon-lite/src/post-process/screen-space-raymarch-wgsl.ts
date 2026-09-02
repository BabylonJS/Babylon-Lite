/**
 * Shared WGSL raymarch library for the screen-space contact-shadow and global-illumination
 * producers (see `docs/lite/architecture/52-screen-space-effects.md`).
 *
 * `screenSpaceRaymarchWGSL()` is a pure string factory: it allocates nothing at module
 * scope and has no side effects, so importing this module costs nothing unless a caller
 * actually splices the returned source into a shader module. Every function below is a
 * plain WGSL `fn` that reconstructs, projects, or samples depth — no bindings are declared
 * here; producers/resolvers declare their own `@group`/`@binding`s and pass textures and
 * samplers in as function parameters (WGSL permits texture/sampler-typed parameters; see
 * `material/node/blocks/ambient-occlusion-block.ts` for a precedent in this codebase).
 *
 * Coordinate convention (mandatory, see GUIDANCE.md §8 and the architecture doc): the
 * fullscreen UV is storage-oriented with (0,0) at the top-left. `ssWorldFromDepth` and
 * `ssUvFromWorld` are exact inverses under this convention:
 *   ndc = vec3(uv.x*2-1, 1-uv.y*2, depth)  -\> uv = vec2(ndc.x*0.5+0.5, 0.5-ndc.y*0.5)
 *
 * Depth is reverse-Z (near -\> 1, far -\> 0; see `math/mat4-perspective-lh-to-ref.ts`), so a
 * cleared background fragment reads depth \<= 0.
 */

/** Build the shared raymarch WGSL function library. Splice the returned source once per
 *  shader module (producer or temporal resolve) before any code that calls into it. */
import { wgsl } from "../shader/wgsl.js";

export function screenSpaceRaymarchWGSL(): string {
    return wgsl`struct SsHit{hit:bool,uv:vec2f,rayDist:f32,surfaceDist:f32}

fn ssIsClearDepth(depth:f32)->bool{return depth<=0.0;}

fn ssTexelUv(coord:vec2i,dims:vec2f)->vec2f{return (vec2f(coord)+vec2f(0.5))/dims;}

fn ssClampCoord(coord:vec2i,dims:vec2f)->vec2i{return clamp(coord,vec2i(0,0),vec2i(dims)-vec2i(1,1));}

fn ssUvToCoord(uv:vec2f,dims:vec2f)->vec2i{return ssClampCoord(vec2i(uv*dims),dims);}

fn ssWorldFromDepth(uv:vec2f,depth:f32,invViewProj:mat4x4f)->vec3f{
  let ndc=vec3f(uv.x*2.0-1.0,1.0-uv.y*2.0,depth);
  let clip=invViewProj*vec4f(ndc,1.0);
  return clip.xyz/clip.w;
}

fn ssUvFromWorld(world:vec3f,viewProj:mat4x4f)->vec3f{
  let clip=viewProj*vec4f(world,1.0);
  let ndc=clip.xyz/clip.w;
  return vec3f(ndc.x*0.5+0.5,0.5-ndc.y*0.5,ndc.z);
}

fn ssBilinearDepth(uv:vec2f,dims:vec2f,depthTex:texture_depth_2d)->f32{
  let p=uv*dims-vec2f(0.5);
  let base=floor(p);
  let frac=p-base;
  let c00=ssClampCoord(vec2i(base),dims);
  let c10=ssClampCoord(vec2i(base)+vec2i(1,0),dims);
  let c01=ssClampCoord(vec2i(base)+vec2i(0,1),dims);
  let c11=ssClampCoord(vec2i(base)+vec2i(1,1),dims);
  let d00=textureLoad(depthTex,c00,0);
  let d10=textureLoad(depthTex,c10,0);
  let d01=textureLoad(depthTex,c01,0);
  let d11=textureLoad(depthTex,c11,0);
  let dx0=mix(d00,d10,frac.x);
  let dx1=mix(d01,d11,frac.x);
  return mix(dx0,dx1,frac.y);
}

fn ssNormalFromDepth(uv:vec2f,dims:vec2f,invViewProj:mat4x4f,depthTex:texture_depth_2d)->vec3f{
  let coord=ssUvToCoord(uv,dims);
  let dim=vec2i(dims);
  let cL=ssClampCoord(coord+vec2i(-1,0),dims);
  let cR=ssClampCoord(coord+vec2i(1,0),dims);
  let cU=ssClampCoord(coord+vec2i(0,-1),dims);
  let cD=ssClampCoord(coord+vec2i(0,1),dims);
  let dC=textureLoad(depthTex,coord,0);
  let dL=textureLoad(depthTex,cL,0);
  let dR=textureLoad(depthTex,cR,0);
  let dU=textureLoad(depthTex,cU,0);
  let dD=textureLoad(depthTex,cD,0);
  let pC=ssWorldFromDepth(ssTexelUv(coord,dims),dC,invViewProj);
  var pH:vec3f;
  if(coord.x<=0){pH=ssWorldFromDepth(ssTexelUv(cR,dims),dR,invViewProj)-pC;}
  else if(coord.x>=dim.x-1){pH=pC-ssWorldFromDepth(ssTexelUv(cL,dims),dL,invViewProj);}
  else if(abs(dL-dC)<abs(dR-dC)){pH=pC-ssWorldFromDepth(ssTexelUv(cL,dims),dL,invViewProj);}
  else{pH=ssWorldFromDepth(ssTexelUv(cR,dims),dR,invViewProj)-pC;}
  var pV:vec3f;
  if(coord.y<=0){pV=ssWorldFromDepth(ssTexelUv(cD,dims),dD,invViewProj)-pC;}
  else if(coord.y>=dim.y-1){pV=pC-ssWorldFromDepth(ssTexelUv(cU,dims),dU,invViewProj);}
  else if(abs(dU-dC)<abs(dD-dC)){pV=pC-ssWorldFromDepth(ssTexelUv(cU,dims),dU,invViewProj);}
  else{pV=ssWorldFromDepth(ssTexelUv(cD,dims),dD,invViewProj)-pC;}
  let n=cross(pH,pV);
  let n2=dot(n,n);
  if(n2<=1e-12){return vec3f(0.0,1.0,0.0);}
  return n*inverseSqrt(n2);
}

fn ssDualSurfaceHit(worldPos:vec3f,cameraPos:vec3f,viewProj:mat4x4f,invViewProj:mat4x4f,dims:vec2f,depthTex:texture_depth_2d,bias:f32,thickness:f32)->SsHit{
  let proj=ssUvFromWorld(worldPos,viewProj);
  let uv=proj.xy;
  if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0){return SsHit(false,uv,0.0,0.0);}
  let coord=ssUvToCoord(uv,dims);
  let discreteDepth=textureLoad(depthTex,coord,0);
  if(ssIsClearDepth(discreteDepth)){return SsHit(false,uv,0.0,0.0);}
  let continuousDepth=ssBilinearDepth(uv,dims,depthTex);
  let discreteWorld=ssWorldFromDepth(ssTexelUv(coord,dims),discreteDepth,invViewProj);
  let continuousWorld=ssWorldFromDepth(uv,continuousDepth,invViewProj);
  let rayDist=length(worldPos-cameraPos);
  let discreteDist=length(discreteWorld-cameraPos);
  let continuousDist=length(continuousWorld-cameraPos);
  let behindDiscrete=rayDist>discreteDist+bias;
  let behindContinuous=rayDist>continuousDist+bias;
  let withinThickness=(rayDist-discreteDist)<thickness&&(rayDist-continuousDist)<thickness;
  let hit=behindDiscrete&&behindContinuous&&withinThickness;
  return SsHit(hit,uv,rayDist,discreteDist);
}

fn ssHash(value:u32)->u32{
  var x=value;
  x=(x^(x>>16u))*2246822519u;
  x=(x^(x>>13u))*3266489917u;
  return x^(x>>16u);
}

fn ssScreenSpaceNoise(coord:vec2f)->f32{
  let p=vec2u(max(coord,vec2f(0.0))*256.0);
  return f32(ssHash(p.x*374761393u+p.y*668265263u))*2.3283064365386963e-10;
}

fn ssPhaseAngle(coord:vec2f,phase:f32)->f32{
  return fract(ssScreenSpaceNoise(coord)+phase);
}
`;
}
