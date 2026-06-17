# Sandblox

Playable build-and-test sandbox for small block worlds. The demo combines a blocky character, editable thin-instanced parts, local save/import/export, and a runtime-fetched starter map.

## Dev workflow

The demo HTML loads the pre-built bundle from `/lite/bundle/demos/sandblox.js` (not raw TS), so build the demo bundles and start the lab dev server:

```sh
pnpm dev:lab
```

Then open **http://localhost:5174/lite/demo-sandblox.html**. Re-run the build (or `pnpm build:bundle-demo sandblox`) after editing the demo source to refresh the served bundle.

## Notes

- The default map lives at `lab/public/sandblox/default-map.json`, is copied into the served demo asset directory at build time, and is fetched via `demoAssetUrl` on first/fresh boot.
- Custom camera input uses right-click orbit instead of `attachControl`.
- Animation groups must be stopped or zero-weighted unless active.
