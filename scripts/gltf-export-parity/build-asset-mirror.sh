#!/usr/bin/env bash
# Temporary handoff tooling for the glTF-export parity scenes — delete before merging.
#
# Builds a local mirror of every remote asset the glTF-export parity scenes (and their Babylon.js reference pages) load,
# for sandboxes that cannot reach the asset hosts. Sources: public GitHub repos (git is usually allowed) and npm.
# The committed scenes keep the playgrounds' original URLs; only scripts/gltf-export-parity/xrun.mjs uses the mirror.
#
# Usage: scripts/gltf-export-parity/build-asset-mirror.sh [workDir]
#   workDir defaults to $GLTF_PARITY_WORK or ~/.cache/gltf-parity. Layout:
#     <workDir>/mirror/<host>/<path>        mirrored files (served by xrun.mjs through Playwright request routing)
#     <workDir>/bjs-reference-images/*.png  Babylon.js visualization reference images (for `xrun.mjs fidelity`)
#     <workDir>/node_modules/pixelmatch     comparator used by `xrun.mjs fidelity`
#     <workDir>/repos/                      partial clones of the source repos
# One asset cannot be rebuilt from GitHub: https://i.imgur.com/JbvoYlB.png (scene 327). Put a copy at
# <workDir>/mirror/i.imgur.com/JbvoYlB.png by hand if you need to re-run scene 327 locally.
set -euo pipefail
WORK="${1:-${GLTF_PARITY_WORK:-$HOME/.cache/gltf-parity}}"
MIR="$WORK/mirror"
REPOS="$WORK/repos"
BJS_REV="${BJS_REV:-676f462}" # Babylon.js master commit the visual tests were ported from
mkdir -p "$MIR" "$REPOS" "$WORK/bjs-reference-images"

clone() { # url dir
    [ -d "$REPOS/$2" ] || git clone -q --filter=blob:none --no-checkout "$1" "$REPOS/$2"
}
put() { # repoDir rev path dest
    mkdir -p "$(dirname "$MIR/$4")"
    git -C "$REPOS/$1" show "$2:$3" > "$MIR/$4"
}

clone https://github.com/BabylonJS/Babylon.js.git babylonjs
git -C "$REPOS/babylonjs" fetch -q origin "$BJS_REV" 2>/dev/null || true
PG=packages/tools/playground/public
for f in misc.jpg environment.dds down.png grass.jpg palm.png ktx2/sample_uastc.ktx2; do put babylonjs "$BJS_REV" "$PG/textures/$f" "playground.babylonjs.com/textures/$f"; done
put babylonjs "$BJS_REV" "$PG/scenes/BoomBox.glb" playground.babylonjs.com/scenes/BoomBox.glb
for f in Alien.gltf Alien.bin Alien_baseColor.png Alien_normal.png Alien_occlusionRoughnessMetallic.png; do put babylonjs "$BJS_REV" "$PG/scenes/Alien/$f" "playground.babylonjs.com/scenes/Alien/$f"; done
BS=packages/tools/babylonServer/public
for f in draco_encoder_wasm_wrapper.js draco_encoder.wasm draco_encoder.js draco_wasm_wrapper_gltf.js draco_decoder_gltf.wasm draco_decoder_gltf.js \
    draco_wasm_wrapper.js draco_decoder.wasm draco_decoder.js ktx2Transcoders/1/msc_basis_transcoder.js ktx2Transcoders/1/msc_basis_transcoder.wasm \
    ktx2Transcoders/1/uastc_astc.wasm ktx2Transcoders/1/uastc_bc7.wasm ktx2Transcoders/1/uastc_r8_unorm.wasm ktx2Transcoders/1/uastc_rg8_unorm.wasm \
    ktx2Transcoders/1/uastc_rgba8_srgb_v2.wasm ktx2Transcoders/1/uastc_rgba8_unorm_v2.wasm; do
    put babylonjs "$BJS_REV" "$BS/$f" "cdn.babylonjs.com/$f"
done
for n in $(git -C "$REPOS/babylonjs" ls-tree --name-only "$BJS_REV" packages/tools/tests/test/visualization/ReferenceImages/ | grep -iE "gltfSerializer|exportGltfKHRTextureTransform"); do
    git -C "$REPOS/babylonjs" show "$BJS_REV:$n" > "$WORK/bjs-reference-images/$(basename "$n")"
done

clone https://github.com/BabylonJS/Assets.git assets # assets.babylonjs.com/<p> = Assets/<p>; models.babylonjs.com/<p> = Assets/meshes/<p>
for f in core/environments/backgroundGround.png core/environments/backgroundSkybox.dds core/environments/environmentSpecular.env; do put assets HEAD "$f" "assets.babylonjs.com/$f"; done
for f in alien.glb Xbot.glb TeapotsGalore/TeapotsGalore.gltf TeapotsGalore/mesh.bin TeapotsGalore/mesh_2.bin TeapotsGalore/transforms.bin; do put assets HEAD "meshes/$f" "models.babylonjs.com/$f"; done

clone https://github.com/KhronosGroup/glTF-Sample-Models.git khronos
put khronos HEAD 2.0/ClearCoatTest/glTF-Binary/ClearCoatTest.glb "cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models@master/2.0/ClearCoatTest/glTF-Binary/ClearCoatTest.glb"

# npm: the KTX2 decoder bundle, glslang/twgsl (used by Babylon.js's GLSL post-process path on WebGPU), and pixelmatch.
cd "$WORK"
[ -f package.json ] || npm init -y > /dev/null
npm install --no-audit --no-fund --silent babylonjs-ktx2decoder@9.28.0 @babylonjs/core@9.28.0 pixelmatch@5.3.0 > /dev/null
cp node_modules/babylonjs-ktx2decoder/babylon.ktx2Decoder.js "$MIR/cdn.babylonjs.com/"
# @babylonjs/core 9.28.0 requests its CDN files under a versioned prefix.
V="$MIR/cdn.babylonjs.com/v9.28.0"
mkdir -p "$V"
cp -r "$MIR/cdn.babylonjs.com/"*.js "$MIR/cdn.babylonjs.com/"*.wasm "$MIR/cdn.babylonjs.com/ktx2Transcoders" "$V/"
cp -r node_modules/@babylonjs/core/assets/glslang node_modules/@babylonjs/core/assets/twgsl "$V/" 2> /dev/null || echo "note: glslang/twgsl not found in @babylonjs/core assets (only needed by the clearcoat reference page)"
echo "mirror ready: $MIR ($(find "$MIR" -type f | wc -l) files); reference images: $WORK/bjs-reference-images"
