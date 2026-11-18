#include <metal_stdlib>
using namespace metal;

struct Vertex {
    float4 position [[position]];
    float2 uv;
};

kernel void blur(texture2d<float, access::read> input [[texture(0)]],
                 texture2d<float, access::write> output [[texture(1)]],
                 constant float &radius [[buffer(0)]],
                 uint2 gid [[thread_position_in_grid]]) {
    float4 sum = 0;
    int count = 0;
    for (int dx = -2; dx <= 2; dx++) {
        uint2 at = uint2(int2(gid) + int2(dx, 0));
        sum += input.read(at);
        count += 1;
    }
    output.write(sum / float(count) * radius, gid);
}

fragment half4 shade(Vertex in [[stage_in]], device const float *weights [[buffer(1)]]) {
    float w = weights[0];
    return half4(half3(in.uv.x * w), 1.0h);
}
