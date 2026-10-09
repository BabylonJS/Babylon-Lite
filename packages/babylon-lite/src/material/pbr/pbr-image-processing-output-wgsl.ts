import { wgsl } from "../../shader/wgsl.js";

/** Exposure also applies when tone mapping is disabled. */
export const PBR_EXPOSURE_WGSL = wgsl`color*=scene.vImageInfos.x;`;

/** Display conversion shared by ordinary PBR and MeshLoD, after exposure/tone mapping. */
export const PBR_DISPLAY_OUTPUT_WGSL = wgsl`color=pow(color,vec3<f32>(1.0/2.2));
color=clamp(color,vec3<f32>(0.0),vec3<f32>(1.0));
let highContrast=color*color*(3.0-2.0*color);
if(scene.vImageInfos.y<1.0){color=mix(vec3<f32>(0.5),color,scene.vImageInfos.y);}
else{color=mix(color,highContrast,scene.vImageInfos.y-1.0);}
color=max(color,vec3<f32>(0.0));`;
