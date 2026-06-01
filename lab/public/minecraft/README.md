# Minecraft-style voxel demo — game data

This folder holds the texture data the voxel demo reads at runtime. The image
files are **not committed to git** (see `.gitignore`).

They are fetched **automatically** by the demo build (`pnpm build:bundle-demos`
and the Pages-site build) because the `minecraft` entry in `demos-config.json`
declares `"fetch": "voxelpack"`. You can also fetch them manually with:

```sh
pnpm fetch:voxelpack
```

That script downloads a pinned, checksum-verified release of the
[Kenney "Voxel Pack"](https://kenney.nl/assets/voxel-pack) and extracts the
block-face PNGs plus `License.txt` into `voxelpack/`.

## Licensing & attribution

- **Kenney Voxel Pack** is released under the **Creative Commons Zero (CC0)**
  public-domain dedication: free to use, modify and redistribute for any purpose,
  with credit (Kenney / www.kenney.nl) appreciated but **not required**. The full
  text ships in `voxelpack/License.txt` (extracted by the fetch script).
  Attribution: Kenney Vleugels — https://kenney.nl.
- This demo's engine is an **original, clean-room** voxel implementation. It
  contains **no** Mojang code and **no** Minecraft game data. "Minecraft" is a
  trademark of Mojang AB; this demo is an independent homage, not affiliated with
  or endorsed by Mojang.
- We never download, host, or bundle Mojang's proprietary textures or sounds.
  Users who own Minecraft may load their own resource-pack `.zip` in the browser
  at runtime ("Load resource pack…"); such files are parsed client-side only and
  never uploaded.
