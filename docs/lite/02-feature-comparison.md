# Feature Comparison — Babylon Lite vs Babylon.js

This page maps the feature gap between **Babylon Lite** and **Babylon.js (BJS)**, category by category. It is the honest, detailed view of what Lite supports today, what is partially supported, and what it intentionally won't support — so you can decide whether Lite fits your project.

> **Babylon Lite is not a replacement for Babylon.js.** The two engines move forward side by side. Lite optimizes for the smallest bundle and the highest performance on WebGPU; Babylon.js optimizes for the broadest, most mature feature set with WebGL **and** WebGPU support. Closing the gap below is our top priority — features land in Babylon.lite as isolated, tree-shakable modules, so the engine grows without bloating your bundle.

## Legend

| Symbol | Meaning |
| --- | --- |
| ✅ | Supported |
| ⚡ | Partial — a subset is implemented; see notes |
| — | Not yet available |
| 🚫 | Won't support — out of scope by design |
| ★ | Lite advantage — area where Lite leads Babylon.js |

---

<!-- AUTOGEN:feature-comparison START — generated from lab/lite/docs/feature-comparison.html by scripts/gen-feature-comparison.ts. Do not edit between these markers by hand. -->

## Rendering API

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| ★ WebGPU | ✅ | ✅ | Lite is WebGPU-exclusive — zero abstraction overhead |
| WebGL 2.0 | 🚫 | ✅ | Not planned — WebGPU only by design |
| WebGL 1.0 | 🚫 | ✅ | Not planned — WebGPU only by design |
| 4× MSAA | ✅ | ✅ |  |
| Depth / Stencil Buffer | ✅ | ✅ | depth24plus-stencil8 |
| HDR Rendering | ✅ | ✅ |  |
| Tone Mapping | ✅ | ✅ | Image processing pipeline |
| Exposure / Contrast | ✅ | ✅ | Via ImageProcessingConfig |
| Canvas Resize Handling | ✅ | ✅ | Automatic per-frame |
| Draw Call Counting | ✅ | ✅ |  |
| EffectRenderer / EffectWrapper | ✅ | ✅ | Scenes 74-76 — direct swapchain renderer plus RTT task path |
| Fullscreen Effect Passes | ✅ | ✅ | Single fullscreen triangle, no vertex/index buffers |
| Effect RenderTarget Output | ✅ | ✅ | Scene 75 — render effect into texture, then use it in a material |
| Effect Texture Bindings | ✅ | ✅ | Scene 76 — Texture2D + sampler binding via setEffectTexture() |
| Frame-Graph RTT Material Override | ✅ | ✅ | Scene 110 — offscreen pass renders selected meshes with an override material and camera, then samples the RTT in the main pass |

---

## Materials

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| PBR Metallic-Roughness | ✅ | ✅ | Full GGX / Smith / Schlick BRDF |
| PBR Specular-Glossiness | ✅ | ✅ | KHR_materials_pbrSpecularGlossiness |
| Standard Material (Blinn-Phong) | ✅ | ✅ | Diffuse, specular, ambient, emissive |
| Background Material | ✅ | ✅ | Ground plane + skybox rendering |
| Normal Mapping | ✅ | ✅ | Cotangent frame, invertNormalMapX |
| Emissive Textures | ✅ | ✅ |  |
| Occlusion (AO) Maps | ✅ | ✅ | ORM texture packing |
| Metallic Reflectance Map | ✅ | ✅ | metallicReflectanceTexture support |
| Specular Anti-Aliasing | ✅ | ✅ | getAARoughnessFactors when normal map present |
| Alpha Blend / Alpha Test | ✅ | ✅ | OPAQUE, BLEND, MASK modes |
| Double-Sided Rendering | ✅ | ✅ |  |
| Opacity Textures | ✅ | ✅ | With depth-write disabled for transparent |
| Bump / Height Mapping | ✅ | ✅ |  |
| Lightmap Textures | ✅ | ✅ | Standard material UV2 |
| Ambient Textures | ✅ | ✅ |  |
| Reflection Textures | ✅ | ✅ | Spherical + planar coord modes |
| UV Scaling / Offset | ✅ | ✅ |  |
| UV2 Channel | ✅ | ✅ | For lightmaps and AO |
| Node Material | ✅ | ✅ | NME snippet parser with lab-proven core, compatibility, PBR, math/modes, color, UV/texture/procedural, normal/screen/depth/matrix/scene-state, loop, and storage blocks (Scenes 60-89) |
| Shader Material | ✅ | ✅ | WGSL-only ShaderMaterial with typed uniforms, samplers, defines, alpha blend/test (Scenes 159-163) |
| Material Plugins | ✅ | ✅ | Opt-in enableMaterialPlugins() — custom WGSL injection on PBR/Standard, zero bundle cost when unused (Scene 217) |
| PBR Clear Coat | ✅ | ✅ | Scene 19 |
| PBR Sheen | ✅ | ✅ | Scene 21 |
| PBR Anisotropy | ✅ | ✅ | Scene 23 |
| PBR Subsurface / Translucency | ✅ | ✅ | Scene 26 — thickness map, translucency, tint |
| Material Variants (KHR_materials_variants) | ✅ | ✅ | Scene 27 — runtime variant selection |
| PBR Iridescence | ✅ | ✅ | Native PBR thin-film iridescence (Scene 177); NME iridescence remains covered separately by Scene 87 |
| Grid Material | ✅ | ✅ | Procedural GridMaterial parity with @babylonjs/materials (Scene 213) |

---

## Lights

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| Hemispheric Light | ✅ | ✅ |  |
| Directional Light | ✅ | ✅ |  |
| Point Light | ✅ | ✅ |  |
| Spot Light | ✅ | ✅ | With cone angle + exponent falloff |
| Multi-Light (N lights) | ✅ | ✅ | Dynamic UBO packing |
| Per-Mesh Light Inclusion | ✅ | ✅ | Scene 111 — includedOnlyMeshIds-style light selection across Standard, PBR, NME, and supported shadow generators |
| Light Intensity / Color | ✅ | ✅ | Diffuse + specular per light |
| Area Lights | — | ✅ |  |

---

## Cameras

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| Arc Rotate Camera | ✅ | ✅ | Orbit / zoom / pan / inertia |
| Auto-Framing (fitToScene) | ✅ | ✅ | Default camera for loaded models |
| Free Camera | ✅ | ✅ | Scene 18, 24, 25 — WASD/arrow controls |
| Geospatial Camera | ✅ | ✅ | Globe-orbit camera (center/yaw/pitch/radius) with fly-to + controls (Scene 225) |
| Follow Camera | — | ✅ |  |
| Universal Camera | — | ✅ |  |
| VR / XR Camera | — | ✅ |  |
| Device Orientation Camera | — | ✅ |  |

---

## Mesh & Geometry

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| Sphere | ✅ | ✅ | Configurable segments |
| Box | ✅ | ✅ |  |
| Torus | ✅ | ✅ | Configurable thickness/tessellation |
| Ground Plane | ✅ | ✅ |  |
| Ground from Heightmap | ✅ | ✅ | GPU texture → vertex displacement |
| Thin Instances | ✅ | ✅ | add / remove / set / flush API |
| Observable Transforms | ✅ | ✅ | ObservableVec3 auto-dirty on mutation |
| Transform Hierarchy | ✅ | ✅ | Version-based lazy world matrix, IWorldMatrixProvider on all entities |
| Clone Transform Node | ✅ | ✅ |  |
| Cylinder | ✅ | ✅ | Cylinder / cone / prism via diameterTop/Bottom |
| Plane | ✅ | ✅ | size or width/height |
| Disc / Ring | ✅ | ✅ | Configurable arc & tessellation |
| Polyhedra | ✅ | ✅ | 15 BJS presets, flat & smooth normals |
| Ribbon / Tube / Extrude | ✅ | ✅ | Path3D parallel-transport frames, closePath/closeArray, cap modes |
| CSG / CSG2 (Boolean Ops) | ✅ | ✅ | Scenes 90/91 — legacy mesh CSG plus Manifold-backed CSG2 subtract, intersect, and union/add operations |
| Instanced Meshes | 🚫 | ✅ | Won't support BJS InstancedMesh API; use thin instances instead |

---

## Skeleton & Animation

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| Skeletal Animation | ✅ | ✅ | GPU bone textures (rgba32float) |
| 4-Bone Skinning | ✅ | ✅ | JOINTS_0 / WEIGHTS_0 |
| 8-Bone Skinning | ✅ | ✅ | JOINTS_1 / WEIGHTS_1 |
| Morph Targets | ✅ | ✅ | Up to 4 targets, position + normal deltas |
| Animation Groups | ✅ | ✅ | play / pause / stop / seek / loop / speed |
| Linear Interpolation | ✅ | ✅ |  |
| Step Interpolation | ✅ | ✅ |  |
| Cubic Spline | ✅ | ✅ |  |
| Deterministic Seek | ✅ | ✅ | Fixed-timestep for parity testing |
| Animation Blending | ✅ | ✅ | Weighted blend, cross-fade, and additive animation groups (Scenes 155-158) |
| Animation Events | — | ✅ |  |
| Animation Weights | ✅ | ✅ | AnimationGroup weight control through AnimationManager |
| Vertex Animation Textures (VAT) | ✅ | ✅ | Baked skeletal animation played on the GPU, incl. per-instance thin-instanced VAT (Scenes 218-219) |

---

## Environment & IBL

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| Babylon .env Files | ✅ | ✅ | RGBD cubemap decode |
| HDR Panoramas (.hdr) | ✅ | ✅ | Equirect → cubemap → prefiltered IBL |
| Image-Based Lighting | ✅ | ✅ | Split-sum approximation |
| BRDF Lookup Table | ✅ | ✅ | Pre-baked PNG, RGBD compute decode |
| Spherical Harmonics | ✅ | ✅ | Irradiance from environment |
| DDS Cube Skybox | ✅ | ✅ |  |
| Cubemap Skybox | ✅ | ✅ | 6-face cube texture |
| HDR Skybox | ✅ | ✅ |  |
| Ground + Skybox Background | ✅ | ✅ | Fresnel ground opacity, premultiplied alpha |
| Fog (Linear / Exp / Exp²) | ✅ | ✅ |  |
| Environment Rotation | ✅ | ✅ |  |
| Reflection Probes | — | ✅ |  |

---

## Shadows

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| ESM Shadows (Directional) | ✅ | ✅ | Depth + Gaussian blur passes |
| Shadow Map Size Config | ✅ | ✅ |  |
| Shadow Bias / Darkness | ✅ | ✅ |  |
| Frustum Edge Falloff | ✅ | ✅ |  |
| PCF Shadows | ✅ | ✅ | Spot + directional PCF (Scenes 18, 111) |
| Cascaded Shadow Maps | ✅ | ✅ | Directional CSM, up to 4 cascades, PCF5, Standard + PBR receivers (Scenes 214-215) |
| Point Light Shadows | — | ✅ |  |
| Spot Light Shadows | ✅ | ✅ | Scene 18 (PCF) |
| Material-Aware Shadow Depth | ✅ | ✅ | Shadow material views and alpha-discard casters for Standard, PBR, and NodeMaterial (Scenes 116, 140, 141) |
| Contact Hardening Shadows | — | ✅ |  |

---

## Loaders

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| glTF 2.0 / GLB | ✅ | ✅ | Meshes, materials, skins, morphs, animations |
| .babylon Format | ✅ | ✅ | Meshes, standard materials, lights |
| Environment .env | ✅ | ✅ |  |
| HDR Panorama .hdr | ✅ | ✅ |  |
| Skybox Cube Textures | ✅ | ✅ |  |
| 2D Texture Loading | ✅ | ✅ | With mipmap generation |
| OBJ / MTL | — | ✅ |  |
| STL | — | ✅ |  |
| FBX | — | ✅ |  |
| KTX1 Compressed Textures | ✅ | ✅ | Scene 25 — ASTC / BC / ETC2 auto-format + PNG fallback |
| KTX2 Textures | ✅ | ✅ | Scene 112 — KHR_texture_basisu glTF texture sources |
| Basis Universal (.basis) | ✅ | ✅ | Scene 36 — transcoder fetched from BJS CDN; BC7 / ASTC / ETC2 / BC3 auto-select + RGBA32 fallback |

---

## glTF 2.0 Extensions (Khronos + vendor)

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| KHR_materials_pbrSpecularGlossiness | ✅ | ✅ | Archived ext — mapped to metallic-roughness (Scene 6) |
| KHR_materials_variants | ✅ | ✅ | Scene 27 — runtime variant selection |
| KHR_materials_unlit | ✅ | ✅ | Scene 32 — base color output, no lighting |
| KHR_materials_clearcoat | ✅ | ✅ | Scene 28 — glTF loader auto-wires clearcoat + roughness + normal textures |
| KHR_materials_sheen | ✅ | ✅ | Scene 29 — glTF loader with BJS-spec albedo scaling |
| KHR_materials_anisotropy | ✅ | ✅ | glTF loader auto-wires strength + rotation (manual API: Scene 23) |
| KHR_materials_volume | ✅ | ✅ | glTF loader auto-wires attenuation + thickness (Scene 30); manual API Scene 26 |
| KHR_materials_transmission | ✅ | ✅ | Frame-graph scene-texture transmission (Scenes 30/33/112) |
| KHR_materials_ior | ✅ | ✅ | Index of refraction override (Scene 30) |
| KHR_materials_specular | ✅ | ✅ | Dielectric specular intensity/color (Scene 30) |
| KHR_materials_iridescence | ✅ | ✅ | glTF loader auto-wires factor/IOR/thickness and packed texture channels (Scene 178) |
| KHR_materials_emissive_strength | ✅ | ✅ | HDR emissive multiplier (Scene 31) |
| KHR_materials_dispersion | ✅ | ✅ | Scene 212 — wavelength-dependent (chromatic) refraction on volumetric glass |
| KHR_lights_punctual | ✅ | ✅ | Scene 33 — point / spot / directional lights from glTF |
| KHR_texture_transform | ✅ | ✅ | Material-wide UV offset / scale / rotate resolved at load (Scene 29) |
| KHR_texture_basisu | ✅ | ✅ | Scene 112 — FlightHelmetKTX from BabylonJS/Assets |
| KHR_draco_mesh_compression | ✅ | ✅ | Draco-compressed mesh geometry (Scene 30) |
| KHR_mesh_quantization | ✅ | ✅ | Scene 211 — 8/16-bit quantized vertex attributes dequantized at load |
| KHR_animation_pointer | ✅ | ✅ | Scene 34 — animate arbitrary JSON pointers (e.g. node visibility) |
| KHR_node_visibility | ✅ | ✅ | Scene 34 — per-node visibility flag |
| KHR_audio / KHR_audio_emitter | — | ✅ | Positional / ambient audio |
| KHR_xmp_json_ld | ✅ | ✅ | Scene 210 — XMP JSON-LD metadata parsed and exposed |
| EXT_mesh_gpu_instancing | ✅ | ✅ | Scene 35 — per-node instance transforms (TRS accessors → thin instances) |
| EXT_meshopt_compression | ✅ | ✅ | Scene 211 — meshoptimizer bitstream decode (BrainStem skinned + animated) |
| EXT_texture_webp | ✅ | ✅ | Scene 37 — EXT_texture_webp source selection with browser-native decode |
| EXT_texture_avif | — | ✅ | AVIF texture source |
| EXT_lights_image_based | — | ✅ | IBL specified in glTF asset |
| MSFT_lod | — | ✅ | Discrete level-of-detail |
| MSFT_minecraftMesh | — | ✅ | Minecraft-style voxel meshes |
| MSFT_audio_emitter | — | ✅ | Legacy positional audio |
| ExtrasAsMetadata | — | ✅ | Promote glTF `extras` to runtime metadata |

---

## Textures

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| 2D Textures | ✅ | ✅ |  |
| Cube Textures | ✅ | ✅ |  |
| Solid Color Textures | ✅ | ✅ | Procedural 1×1 fill |
| GPU Mipmap Generation | ✅ | ✅ | Compute shader mipmaps |
| sRGB Handling | ✅ | ✅ | Format-based gamma correction |
| Sampler Configuration | ✅ | ✅ | Filter, address mode, anisotropy |
| InvertY Control | ✅ | ✅ |  |
| Procedural Textures | — | ✅ |  |
| Video Textures | — | ✅ |  |
| Dynamic Textures | — | ✅ |  |
| Render Target Textures | ✅ | ✅ | Frame-graph RTT + sampled Texture2D, including pass-local material override (Scenes 75, 110) |
| Multi-Render Targets | — | ✅ |  |

---

## Math Utilities

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| Vec3 / Vec4 | ✅ | ✅ | add, sub, scale, dot, cross, normalize, lerp |
| Mat4 (4×4 Matrix) | ✅ | ✅ | Multiply, inverse, lookAt, perspective, compose |
| Quaternion | ✅ | ✅ | Slerp, toMatrix, from Euler |
| Color3 / Color4 | ✅ | ✅ |  |
| ObservableVec3 | ✅ | — | Auto-dirty on mutation (Lite-specific) |
| LH Column-Major Layout | ✅ | ✅ | Aligned with WGSL/WebGPU conventions |
| ★ High-Precision / Floating-Origin Matrices | ✅ | ⚡ | Scenes 200/201 — F64 matrix caches + eye-relative floating-origin upload remove far-from-origin jitter at ~5e6 world units; BJS offers useHighPrecisionMatrix but not the eye-relative floating-origin path |

---

## Architecture & Developer Experience

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| ★ 100% Tree-Shakable | ✅ | ⚡ | Zero module-level side effects in Lite |
| ★ Minimal Bundle Size | ✅ | — | Dramatically smaller than BJS for same scene |
| ★ Zero Side Effects | ✅ | — | No register*() at import time, no globalThis |
| ★ One-Way Data Ownership | ✅ | — | Components are plain data; scene is sole owner |
| ★ Materials Own Shaders | ✅ | — | Self-contained material + pipeline units |
| TypeScript | ✅ | ✅ | Strict typing throughout |
| Vite Native | ✅ | ⚡ | First-class Vite integration |
| Familiar BJS-like API | ✅ | ✅ | Easy migration for BJS developers |
| Hot Material Swap | ✅ | ✅ | Object.defineProperty setter + rebuild queue |
| Dispose / Cleanup | ✅ | ✅ | Full GPU resource cleanup on dispose |
| GPU Frame Timer | ✅ | ✅ | Optional zero-cost GPU frame profiling via WebGPU timestamp queries (setGpuTimingEnabled) |
| Multi-Canvas / Multi-Scene | ✅ | ✅ | One engine drives many canvases/scenes via createSurface; GPU resources are device-scoped (Scenes 227-228) |

---

## Advanced Features

| Feature | Lite | BJS | Notes |
| --- | :---: | :---: | --- |
| Physics Engine | ⚡ | ✅ | Havok Physics V2 subset (Scene 40); no Ammo.js/Cannon.js/Oimo compatibility layer |
| Particle System | — | ✅ | CPU + GPU particles |
| Post-Processing Pipeline | ⚡ | ✅ | Frame-graph post-process viewports, pipelined blur/chromatic passes, and Bloom are covered (Scenes 142-144); no built-in DOF/SSAO stack yet |
| GUI (2D / 3D UI) | — | ✅ |  |
| Sprites / SpriteManager | ⚡ | ✅ | 2D layers, depth-hosted sprites, facing/axis-locked/cutout billboards (Scenes 50-57); not the full BJS SpriteManager API |
| Gaussian Splatting | ✅ | ✅ | .ply / .splat / .sog / .spz loaders, transform baking, material plugin fragments, depth rendering, and GPU picking (Scenes 120-129) |
| Octree / Frustum Culling | — | ✅ |  |
| Level of Detail (LOD) | — | ✅ |  |
| Ray Casting / Picking | ✅ | ✅ | GPU ID pass + CPU ray/triangle details, normal/UV helpers, thin-instance and deformed mesh coverage (Scenes 113-115) |
| WebXR / VR / AR | — | ✅ |  |
| Glow / Highlight Layer | — | ✅ |  |
| Screen-Space Reflections | — | ✅ |  |
| SSAO | — | ✅ |  |
| Lens Flare | — | ✅ |  |
| Volumetric Light Scattering | — | ✅ |  |
| Decals | — | ✅ |  |
| Solid Particle System | — | ✅ |  |
| Fluid Rendering | — | ✅ |  |
| Bones IK | — | ✅ |  |
| Navigation Mesh | ⚡ | ✅ | Recast V2 navmesh, crowd pathing, tile-cache obstacles, off-mesh links, and raycast (Scenes 170-175) |
| Device Lost Recovery | ✅ | ✅ | Opt-in automatic WebGPU device-loss recovery (Scene 164) |
| OffscreenCanvas / Worker Rendering | ✅ | ✅ | Engine runs unchanged on a DOM canvas or an OffscreenCanvas transferred to a Web Worker (Offscreen demo) |
| Text Rendering | ✅ | ✅ | GPU text renderer with layered layout + editor (Scenes 180-181) |
| Gizmos | ✅ | ✅ | Position / rotation / scale, bounding-box, camera + light gizmos on a utility layer (Scenes 221-224) |
| Geometry Buffer Renderer | ✅ | ✅ | Frame-graph geometry renderer producing normal / depth / position textures; feeds DoF + CoC (Scenes 145-149) |
| Large World Rendering (Floating Origin) | ✅ | ✅ | Camera-relative rendering + multi-region physics for huge world coordinates (Scenes 200-209) |
| Scene Optimizer | — | ✅ |  |
| Asset Manager | — | ✅ |  |
| Scene Serialization | — | ✅ |  |

<!-- AUTOGEN:feature-comparison END -->

---

## How to read the gap

- **✅ on both sides** means the feature is covered in Lite to parity with Babylon.js — validated by a pixel-diff against Babylon.js where a parity scene exists.
- **⚡ on Lite** means a meaningful subset is available today; the notes describe exactly what is and isn't covered. These are the most likely candidates to fully finish next.
- **— on Lite** means the feature isn't available yet. If your project depends on one of these, Babylon.js is the right option today — and let us know, because your feedback will help shape the Lite roadmap.
- **🚫 on Lite** means the feature is intentionally out of scope (e.g. WebGL, the classic `InstancedMesh` API). These reflect deliberate design trade-offs that buy Lite its size and speed; use the noted alternative (e.g. thin instances).

This table tracks the current state and will be updated regularly as the gaps close between Babylon.lite and Babylon.js. 

## Next steps

- 🚀 **[Getting Started](01-getting-started.md)** — install Lite, learn the mental model, and render your first scene.
- 🔁 **[Porting Guide](03-porting-guide.md)** — translate a Babylon.js scene to Babylon Lite, side by side.
- 🧱 **[Architecture docs](architecture/)** — deep dives into the engine internals.
- 🏠 **[Welcome](00-welcome.md)** — the big-picture introduction and "which engine should I use?" decision tree.
