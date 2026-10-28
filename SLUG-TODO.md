
✅ remove internals and just use @internal?
  ✅ store bands on GlyphCurves directly (_bandsCache)?
✅ similar: shared atlas attached to map, maybe instead a createCurveStore with an internal member for the atlas?
✅ public-types.ts is weird
❌ render bundles?
❌ removing glyphs that are no longer in the text being rendered - to hard, not enough value, not standard
✅ check for anything that isn't or can't be cleaned up

API
✅ TextDescriptor: maybe don't pass in curve sets, but instead a callback that can ask for the glyph curves for a glyph, or just a function/API for adding glyphs (how do we key the shared atlas? right now it is the curveset, but we also have a curveset id now, so could we use that?)
❌ DefaultTextDescriptor: More output info, including origin (x/y)
✅ Instancing probably needs to consider font size
⏹️ Shaders need more updates that Branimir understands
⏹️ "highlight" (background color)