# The Playroom assets

This directory contains the runtime asset subset used by the Babylon Lite port
of **BabylonJS/ThePlayroom** at revision
`d22ce23ef308e28d1f8b6598b4c72ea944205925`.

The user explicitly authorized copying and redistributing this private
application's content in Babylon-Lite on 2026-09-16, with its existing notices
and attribution preserved. The source packages declare `ISC`, but the pinned
repository contains no license text, named copyright holder, or per-asset
license declarations. Consequently, the copied assets are not described here
as Apache-2.0, MIT, ISC, CC0, or any other independently verified asset license.

`asset-manifest.json` records every runtime file's source, byte length, SHA-256,
and any lossless transformation. `shader-texture-bindings.json` records the
embedded JPEG extraction needed to give repeated NME image blocks unique local
bindings. `gltf/bunny-rig.json` is derived metadata for the source-specific
ten-body ragdoll.

Seven inactive files were intentionally omitted: two unused environments,
`table.glb`, two unused textures, and two unused snow-globe sounds. The old
application bundle and its Havok runtime are not included; this demo uses the
repository's existing `HavokPhysics.wasm`.
