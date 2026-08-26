# Visual test fixtures

Every fixture in this directory is hand-authored for Babylon Lottie Player and covered by the repository's
Apache-2.0 license. They are synthetic geometric test documents, not exported product artwork and
not derived from anything in the gitignored `anims/` directory or the Babylon Assets repository.

`manifest.json` is the inventory consumed by the visual tests. Each entry names the public player
variant and the rendering features the fixture is intended to isolate. Babylon's Lottie player is
the reference where it supports the feature; `lottie-web` canvas is the local reference for masks,
mattes, and other features missing from the Babylon reference package.

`images/four-color.png.base64` is an original geometric test image used to verify that a URL-loaded
Lottie document resolves its image directory relative to the JSON response URL. The visual build
decodes it to `four-color.png` in the ignored output directory.
