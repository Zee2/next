// GPGPU simulation (GPUComputationRenderer injects `resolution` and the
// texturePosition / textureVelocity / textureColor samplers).

const common = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  vec3 hash3(vec2 p) { return vec3(hash(p), hash(p + 17.13), hash(p + 31.77)) * 2.0 - 1.0; }
`;

export const velocityShader = /* glsl */ `
  uniform sampler2D tTarget;
  uniform float uDt;

  uniform vec3 uRayOrigin;
  uniform vec3 uRayDir;
  uniform float uPresence;
  uniform vec3 uPointerVel;

  uniform float uRadius;
  uniform float uSwirl;
  uniform float uPush;
  uniform float uDrag;
  uniform float uBurst;

  uniform float uSpring;
  uniform float uDamping;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uNoiseTime;
  uniform float uMorph;
  uniform vec3 uFitCenter;
  uniform float uFitScale;

  ${common}

  vec3 flow(vec3 q, float t) {
    return vec3(
      sin(q.y * 1.7 + t * 0.6) + sin(q.z * 2.3 - t * 0.4),
      sin(q.z * 1.9 + t * 0.5) + sin(q.x * 2.1 + t * 0.3),
      sin(q.x * 1.5 - t * 0.7) + sin(q.y * 2.7 + t * 0.2)
    ) * 0.5;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec3 p = texture2D(texturePosition, uv).xyz;
    vec3 v = texture2D(textureVelocity, uv).xyz;
    // Shapes are stored in their own units; fit them to the (fixed) camera here.
    vec3 target = (texture2D(tTarget, uv).xyz - uFitCenter) * uFitScale;
    float r = hash(uv);

    // Spring towards the target; per-particle stiffness keeps it organic.
    // uMorph (0→1, eased on the CPU) ramps the pull in after a shape change.
    vec3 acc = (target - p) * uSpring * (0.55 + 0.9 * r) * uMorph;

    // Pointer: distance from the particle to the pointer ray.
    vec3 rel = p - uRayOrigin;
    vec3 off = rel - uRayDir * dot(rel, uRayDir);
    float d2 = dot(off, off);
    float r2 = uRadius * uRadius;
    float fall = exp(-d2 / r2) * uPresence;
    vec3 radial = off * inversesqrt(max(d2, 1e-8));
    vec3 tangent = cross(uRayDir, radial);
    acc += fall * (tangent * uSwirl + radial * uPush + uPointerVel * uDrag);
    // Taps: a wider radial shockwave.
    acc += radial * exp(-d2 / (r2 * 4.0)) * uBurst;

    // Idle drift.
    acc += flow(p * uNoiseScale + r * 6.0, uNoiseTime) * uNoise;

    v += acc * uDt;
    v *= exp(-uDamping * uDt);
    gl_FragColor = vec4(v, 1.0);
  }
`;

export const positionShader = /* glsl */ `
  uniform sampler2D tTarget;
  uniform float uDt;

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 p = texture2D(texturePosition, uv);
    vec3 v = texture2D(textureVelocity, uv).xyz;
    float targetSize = texture2D(tTarget, uv).w;
    p.xyz += v * uDt;
    p.w = mix(p.w, targetSize, 1.0 - exp(-uDt * 4.0));
    gl_FragColor = p;
  }
`;

export const colorShader = /* glsl */ `
  uniform sampler2D tTargetColor;
  uniform sampler2D tPrevColor;
  uniform float uMorph; // linear 0→1 progress through the current transition

  ${common}

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    // Hold the old colour, then shift mid-transition (staggered a little per particle).
    float start = 0.3 + 0.25 * hash(uv + 3.1);
    float k = smoothstep(start, start + 0.35, uMorph);
    gl_FragColor = mix(texture2D(tPrevColor, uv), texture2D(tTargetColor, uv), k);
  }
`;

// Rendering

export const pointsVertex = /* glsl */ `
  attribute vec2 reference;
  uniform sampler2D tPosition;
  uniform sampler2D tVelocity;
  uniform sampler2D tColor;
  uniform float uSize;
  uniform float uProjScale;
  uniform float uSpeedGlow; // already scaled down during transitions
  // Depth fade: view depth of the shape centre, its fitted radius, and the fade curve.
  uniform float uDepthCenter;
  uniform float uDepthRadius;
  uniform float uDepthFade;
  uniform float uDepthFadeStart;
  uniform float uDepthFadeEnd;
  varying vec4 vColor;

  void main() {
    vec4 p = texture2D(tPosition, reference);
    float speed = length(texture2D(tVelocity, reference).xyz);
    vec4 mv = modelViewMatrix * vec4(p.xyz, 1.0);
    gl_Position = projectionMatrix * mv;
    float glow = min(speed * uSpeedGlow, 1.5);
    gl_PointSize = max(1.0, uSize * p.w * (1.0 + glow * 0.4) * uProjScale / -mv.z);
    vec4 c = texture2D(tColor, reference);
    // -1 = front of the shape, +1 = back; fade points towards the back.
    float depth = (-mv.z - uDepthCenter) / uDepthRadius;
    float fade = 1.0 - uDepthFade * smoothstep(uDepthFadeStart, uDepthFadeEnd, depth);
    vColor = vec4(c.rgb * (1.0 + glow), c.a * fade);
    // Unused (fully transparent) particles: move outside the clip volume so they cost no fill.
    if (c.a < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

export const pointsFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec4 vColor;

  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d = length(q);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.15, d) * vColor.a * uOpacity;
    gl_FragColor = vec4(vColor.rgb, a);
  }
`;
