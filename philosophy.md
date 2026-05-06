# Lite Philosophy

Babylon.js was built around broad usability: simple APIs, strong developer ergonomics, performance, and long-term compatibility across many use cases. Bundle size was not its primary constraint.

Babylon Lite has a different center of gravity. Lite is built around **minimal size** and **maximum performance** first. Simplicity is still valuable, and we should absolutely keep APIs clean when we can, but simplicity must never come at the expense of size or performance.

When tradeoffs conflict, Lite prioritizes:

1. **Size** - unused features must cost zero bytes whenever possible.
2. **Performance** - runtime paths should be direct, modern, and WebGPU-native.
3. **Simplicity** - desirable, but subordinate to size and performance.

This means Lite is not a compatibility layer and does not try to preserve every Babylon.js behavior, abstraction, or historical API shape. Familiarity with Babylon.js matters, especially for portability, but **backward compatibility is not a first-class goal** for Lite. APIs may be narrower, features may be opt-in, and implementation complexity is acceptable when it protects bundle size, runtime performance, or tree-shaking.

The goal is not to make Lite dumb or difficult to use. The goal is to make it **slim, fast, and precise**: the smallest practical code that produces Babylon.js-quality results without carrying the weight of unused features or legacy constraints.
