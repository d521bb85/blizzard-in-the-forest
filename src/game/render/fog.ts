import * as THREE from "three";

/**
 * Shared uniforms for the blizzard: a drifting, gusting 3D fog that replaces
 * three.js's uniform fog in every material that opts in.
 */
export const blizzardUniforms = {
  uWindOffset: { value: new THREE.Vector3() },
  uFogDensity: { value: 0.05 },
  uFogTime: { value: 0 },
  uCamWorld: { value: new THREE.Matrix4() },
  uWindDir: { value: new THREE.Vector2(1, 0) },
  uGust: { value: 0.5 },
  /** Towards the sun, and how much of it gets through the clouds right now. */
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSun: { value: 0 },
  /** 0: the world in black and white; 1: in colour. Every material's tint is mixed in by it. */
  uColour: { value: 0 }
};

export const NOISE_GLSL = /* glsl */ `
float bzHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float bzNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(bzHash(i), bzHash(i + vec3(1, 0, 0)), f.x),
        mix(bzHash(i + vec3(0, 1, 0)), bzHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(bzHash(i + vec3(0, 0, 1)), bzHash(i + vec3(1, 0, 1)), f.x),
        mix(bzHash(i + vec3(0, 1, 1)), bzHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
`;

/**
 * Fog density along the view ray, from a wind-advected noise field. The noise
 * has periods of 8-22 m, so it is evaluated per vertex; only the distance
 * falloff runs per fragment.
 */
export const FOG_DENSITY_GLSL = /* glsl */ `
uniform vec3 uWindOffset;
uniform float uFogDensity;
uniform float uFogTime;
${NOISE_GLSL}
float bzFogDensity(vec3 wp) {
  vec3 rd = wp - cameraPosition;
  float d = length(rd);
  vec3 dir = rd / max(d, 1e-4);
  float reach = min(d, 55.0);
  float acc = 0.0;
  for (int i = 0; i < 4; i++) {
    float t = (float(i) + 0.5) * 0.25 * reach;
    vec3 p = cameraPosition + dir * t - uWindOffset;
    acc += bzNoise(p * vec3(0.045, 0.08, 0.045)) * 0.65
         + bzNoise(p * vec3(0.12, 0.2, 0.12) + uFogTime * 0.07) * 0.35;
  }
  acc *= 0.25;
  float dens = uFogDensity * mix(0.55, 1.6, smoothstep(0.25, 0.75, acc));
  // Low-lying blowing snow thickens the air near the ground.
  float low = exp(-max(wp.y - cameraPosition.y + 1.6, 0.0) * 0.7);
  return dens * (1.0 + low * 0.25);
}
float bzFogFactor(float dens, float d) {
  return 1.0 - exp(-dens * dens * d * d);
}
`;

/**
 * The sun behind the clouds: light the fog scatters towards the eye, strongest
 * around the sun's direction, with a pale disc where it is nearly through. Added
 * to the fog colour, so whatever the fog hides (trees, far snow, the sky) takes it
 * on as much as it is fogged. Needs NOISE_GLSL and uFogTime.
 */
export const SUN_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform float uSun;
uniform float uColour;
// In colour the sun comes through warm; the weights keep its brightness as it was.
const vec3 BZ_SUN_WARM = vec3(1.32, 0.97, 0.58);
vec3 bzSunGlow(vec3 dir) {
  float c = dot(dir, uSunDir);
  if (c < 0.6) return vec3(0.0);
  float halo = pow(max(c, 0.0), 24.0) * 0.55 + pow(max(c, 0.0), 160.0) * 0.6;
  float disc = smoothstep(0.99935, 0.99965, c);
  // Clouds drift across it: a slow, coarse noise over the patch of sky around the sun.
  vec3 q = (dir - uSunDir) * 9.0 + vec3(uFogTime * 0.035, uFogTime * 0.012, -uFogTime * 0.02);
  float clouds = smoothstep(0.25, 0.85, bzNoise(q) * 0.65 + bzNoise(q * 2.3 + 4.1) * 0.35);
  return mix(vec3(1.0), BZ_SUN_WARM, uColour) * (uSun * (halo + disc * (0.35 + 0.65 * clouds)) * (0.6 + 0.4 * clouds));
}
`;

type Shader = THREE.WebGLProgramParametersWithUniforms;

/**
 * The eyes that see heat see further through falling snow: to heat the fog is as thick as
 * it is to light only this many times as far off. (It hides exp(-(k d)^2) of a thing's
 * light; of its heat, exp(-(HEAT_FOG k d)^2): a warm face still glows at 40 m, but well
 * beyond where its light is gone, its heat is gone too.)
 */
export const HEAT_FOG = 0.55;

/**
 * Swaps the standard fog chunks for the blizzard fog. Call inside onBeforeCompile.
 *
 * `heat`, a GLSL float expression valid in the fragment shader (0 cold to 1 as warm as a
 * face), makes the material write how warm it is into the alpha channel of the scene's
 * target, as 1 - heat, dimmed by the fog: the eyes that see heat read it there (post.ts).
 * Everything else writes 1, cold.
 */
export function injectBlizzardFog(shader: Shader, heat?: string): void {
  Object.assign(shader.uniforms, blizzardUniforms);
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <fog_pars_vertex>",
      `#include <fog_pars_vertex>\nuniform mat4 uCamWorld;\nvarying vec3 vBzWorld;\nvarying float vBzDens;\n${FOG_DENSITY_GLSL}`
    )
    .replace(
      "#include <fog_vertex>",
      "#include <fog_vertex>\nvBzWorld = (uCamWorld * mvPosition).xyz;\nvBzDens = bzFogDensity(vBzWorld);"
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <fog_pars_fragment>",
      `#include <fog_pars_fragment>\nvarying vec3 vBzWorld;\nvarying float vBzDens;\nuniform float uFogTime;\n${NOISE_GLSL}\n${SUN_GLSL}`
    )
    .replace(
      "#include <fog_fragment>",
      `{
        vec3 bzRay = vBzWorld - cameraPosition;
        vec3 bzFog = fogColor + bzSunGlow(normalize(bzRay));
        float bzFogged = 1.0 - exp(-vBzDens * vBzDens * dot(bzRay, bzRay));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, bzFog, bzFogged);
        ${heat ? `gl_FragColor.a = 1.0 - clamp(${heat}, 0.0, 1.0) * exp(-vBzDens * vBzDens * dot(bzRay, bzRay) * ${(HEAT_FOG * HEAT_FOG).toFixed(4)});` : ""}
      }`
    );
}
