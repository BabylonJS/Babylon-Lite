highp float sampleDepthLinear(sampler2D source, vec2 uv, float level) {
    float pointDepth = textureLod(source, uv, level).r;
    if (level != 0.0) return pointDepth;
    ivec2 size = textureSize(source, 0);
    vec2 pixel = uv * vec2(size) - 0.5;
    ivec2 base = clamp(ivec2(floor(pixel)), ivec2(0), size - 2);

    ivec2 coords[4] = ivec2[4](base, base + ivec2(1, 0), base + ivec2(0, 1), base + ivec2(1, 1));
    float depths[4];
    vec3 positions[4];
    vec3 normals[4];
    for (int i = 0; i < 4; ++i) {
        if (texelFetch(deviceDepthInput, coords[i], 0).r == 0.0) return pointDepth;
        depths[i] = texelFetch(source, coords[i], 0).r;
        vec2 center = (vec2(coords[i]) + 0.5) / vec2(size);
        positions[i] = vec3((0.5 - center) * materialParams.positionParams * depths[i], depths[i]);
        normals[i] = texelFetch(normalInput, coords[i], 0).xyz;
        normals[i].z = -normals[i].z;
    }
    // Match one real surface before interpolating; normal agreement alone misses parallel depth steps.
    float tolerance = max(1e-6, abs(depths[0]) * 2e-6);
    for (int i = 1; i < 4; ++i) {
        if (dot(normals[0], normals[i]) < 0.9999 ||
            abs(dot(normals[0], positions[i] - positions[0])) > tolerance) return pointDepth;
    }
    // A coherent plane also supplies the correct ray depth at a clamped screen-edge footprint.
    vec2 fraction = pixel - vec2(base);
    float bottom = mix(1.0 / depths[0], 1.0 / depths[1], fraction.x);
    float top = mix(1.0 / depths[2], 1.0 / depths[3], fraction.x);
    float reciprocalDepth = mix(bottom, top, fraction.y);
    if (reciprocalDepth >= -1e-8) return pointDepth;
    return 1.0 / reciprocalDepth;
}
