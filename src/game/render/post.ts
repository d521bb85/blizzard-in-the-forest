import * as THREE from "three";
import { blizzardUniforms } from "./fog";

const VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Console-era output: big square pixels, no smoothing, 15-bit colour with dither.
// Black and white, or (uColour = 1) the same picture with the scene's colour kept.
// Everything here depends only on the scene pixel, so it runs once per scene pixel,
// at the scene's own resolution; BLIT then blows the result up to the screen.
const GRADE = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uSceneRes;
uniform float uFade;
uniform float uColour;
uniform float uThermal;
uniform float uTime;

// The console's own dither: a fixed 4x4 pattern added to each 8-bit value before
// it is cut down to the 5 bits the frame buffer keeps.
const float DITHER_STRENGTH = 0.35;
// How far colours stand from gray: above 1 they are richer than the scene made them.
const float COLOUR_SATURATION = 1.35;
const mat4 DITHER = mat4(
  -4.0,  0.0, -3.0,  1.0,
   2.0, -2.0,  3.0, -1.0,
  -3.0,  1.0, -4.0,  0.0,
   3.0, -1.0,  2.0, -2.0
);

// Through the yeti's eyes heat glows from dark red through orange and yellow to white.
vec3 heatColour(float h) {
  vec3 c = mix(vec3(0.3, 0.04, 0.22), vec3(0.78, 0.1, 0.12), smoothstep(0.0, 0.3, h));
  c = mix(c, vec3(1.0, 0.48, 0.06), smoothstep(0.25, 0.6, h));
  c = mix(c, vec3(1.0, 0.86, 0.3), smoothstep(0.55, 0.85, h));
  return mix(c, vec3(1.0, 0.98, 0.86), smoothstep(0.85, 1.0, h));
}

// The scene target's alpha holds how warm each pixel is, as 1 - heat (see fog.ts).
float heatAt(vec2 uv) {
  return clamp(1.0 - texture2D(tScene, uv).a, 0.0, 1.0);
}

float tone(float l) {
  l = l * 0.92;
  l = (l * (2.51 * l + 0.03)) / (l * (2.43 * l + 0.59) + 0.14);
  l = pow(clamp(l, 0.0, 1.0), 1.0 / 2.2);
  return mix(l, smoothstep(0.04, 1.0, l), 0.75);
}

/**
 * The yeti's eyes: the light of day they make out badly, a dim, flat, swimming blur
 * all but drained of colour; heat they see sharp and bright, with a glow round it.
 */
vec3 thermal(vec2 uv) {
  vec2 px = 1.0 / uSceneRes;
  // The cold world wavers a little, slowly, as through tears or rising breath.
  vec2 swim = vec2(sin(uv.y * 11.0 + uTime * 0.8), cos(uv.x * 8.0 - uTime * 0.6)) * px * 1.6;
  vec2 u = uv + swim;
  vec3 c = texture2D(tScene, u).rgb * 0.36;
  float glow = 0.0;
  for (int i = 0; i < 4; i++) {
    float a = float(i) * 1.5708 + 0.785;
    vec2 d = vec2(cos(a), sin(a)) * px;
    c += texture2D(tScene, u + d * 2.0).rgb * 0.16;
    glow = max(glow, heatAt(uv + d * 1.6));
    glow = max(glow, heatAt(uv + d.yx * vec2(3.0, -3.0)) * 0.7);
  }
  float l = tone(dot(c, vec3(0.2126, 0.7152, 0.0722)));
  // Cold is gray, low and flat, with only a breath of blue-green in it.
  vec3 cold = mix(0.08, 0.54, l) * vec3(0.93, 1.0, 1.05);
  float h = max(heatAt(uv), glow * 0.55);
  // Heat keeps a little of the light's shading, so a warm body still has a shape.
  float lit = tone(dot(texture2D(tScene, uv).rgb, vec3(0.2126, 0.7152, 0.0722)));
  vec3 warmth = heatColour(h) * mix(1.0, 0.72 + 0.56 * lit, smoothstep(0.85, 0.3, h));
  return mix(cold, warmth, smoothstep(0.03, 0.2, h));
}

void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 uv = (cell + 0.5) / uSceneRes;
  vec3 c = texture2D(tScene, uv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Each channel's share of the brightness, as the screen will show it: gray is all ones.
  vec3 hue = pow(max(c, 0.0) / max(l, 1e-4), vec3(1.0 / 2.2));

  // Filmic shoulder and toe, then gamma.
  l = tone(l);

  // In colour the same curve sets the brightness and the hue rides on it. A channel
  // pushed past white is pulled back towards gray, so bright snow pales, not clips.
  vec3 rgb = l + (l * hue - l) * COLOUR_SATURATION;
  float top = max(rgb.r, max(rgb.g, rgb.b));
  if (top > 1.0) rgb = l + (rgb - l) * ((1.0 - l) / (top - l));
  float chroma = uColour;
  if (uThermal > 0.5) {
    rgb = thermal(uv);
    chroma = 1.0;
  }

  // Vignette, stepped per scene pixel like everything else.
  vec2 q = uv - 0.5;
  q.x *= uSceneRes.x / uSceneRes.y;
  float vig = smoothstep(1.0, 0.2, length(q));
  float dim = mix(0.4, 1.0, vig) * uFade;
  l *= dim;
  rgb *= dim;

  // 15-bit colour: 32 levels of gray (or of each channel), the wide fog gradients held
  // together by the dither pattern, which shows as a fine weave over them.
  float d = DITHER[int(mod(cell.y, 4.0))][int(mod(cell.x, 4.0))];
  // Only part of the way: at full strength the weave is all one sees in the fog.
  l = mix(l, floor(clamp(l * 255.0 + d, 0.0, 255.0) / 8.0) * 8.0 / 248.0, DITHER_STRENGTH);
  rgb = mix(rgb, floor(clamp(rgb * 255.0 + d, 0.0, 255.0) / 8.0) * 8.0 / 248.0, DITHER_STRENGTH);

  gl_FragColor = vec4(mix(vec3(clamp(l, 0.0, 1.0)), clamp(rgb, 0.0, 1.0), chroma), 1.0);
}
`;

// Each screen pixel shows the graded scene pixel under it, 8 bits a channel like the screen.
const BLIT = /* glsl */ `
uniform sampler2D tGraded;
uniform vec2 uSceneRes;
uniform vec2 uCrop;
uniform float uPixel;
void main() {
  // The scene pixel under this screen pixel; any leftover is cropped evenly from both sides.
  vec2 cell = floor((gl_FragCoord.xy + uCrop) / uPixel);
  gl_FragColor = texture2D(tGraded, (cell + 0.5) / uSceneRes);
}
`;

/** Renders the scene into a small target and blows it up to the screen, pixel for pixel. */
export class RetroPass {
  readonly target: THREE.WebGLRenderTarget;
  /** The scene once graded, at the scene's size, 8 bits a channel as the screen shows it. */
  private graded: THREE.WebGLRenderTarget;
  private gradeScene = new THREE.Scene();
  private blitScene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly material: THREE.ShaderMaterial;
  private blit: THREE.ShaderMaterial;
  private tri = new THREE.BufferGeometry();

  /** halfFloat: false falls back to 8-bit colour where float targets are not renderable. */
  constructor(halfFloat = true) {
    // No multisampling and no filtering: hard, stair-stepped edges are the point.
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true
    });
    this.graded = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false
    });
    const sceneRes = { value: new THREE.Vector2(1, 1) };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: GRADE,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: this.target.texture },
        uSceneRes: sceneRes,
        uFade: { value: 0 },
        // The same switch the scene's materials read.
        uColour: blizzardUniforms.uColour,
        /** 1: seen through the yeti's eyes, which see heat. */
        uThermal: { value: 0 },
        uTime: blizzardUniforms.uFogTime
      }
    });
    this.blit = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BLIT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tGraded: { value: this.graded.texture },
        uSceneRes: sceneRes,
        uCrop: { value: new THREE.Vector2() },
        uPixel: { value: 1 }
      }
    });
    const tri = this.tri;
    tri.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    for (const [scene, material] of [
      [this.gradeScene, this.material],
      [this.blitScene, this.blit]
    ] as const) {
      const mesh = new THREE.Mesh(tri, material);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
  }

  /** The scene is sceneW x sceneH pixels, each shown as pixel x pixel screen pixels. */
  setSize(sceneW: number, sceneH: number, pixel: number, outW: number, outH: number): void {
    this.target.setSize(sceneW, sceneH);
    this.graded.setSize(sceneW, sceneH);
    this.material.uniforms.uSceneRes.value.set(sceneW, sceneH);
    const u = this.blit.uniforms;
    u.uPixel.value = pixel;
    u.uCrop.value.set(Math.floor((sceneW * pixel - outW) / 2), Math.floor((sceneH * pixel - outH) / 2));
  }

  /** Precompiles the output shaders: grading into the small target, the blit to the screen. */
  compile(renderer: THREE.WebGLRenderer): Promise<unknown> {
    renderer.setRenderTarget(this.graded);
    const grade = renderer.compileAsync(this.gradeScene, this.camera);
    renderer.setRenderTarget(null);
    return Promise.all([grade, renderer.compileAsync(this.blitScene, this.camera)]);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(this.graded);
    renderer.render(this.gradeScene, this.camera);
    renderer.setRenderTarget(null);
    renderer.render(this.blitScene, this.camera);
  }

  dispose(): void {
    this.target.dispose();
    this.graded.dispose();
    this.material.dispose();
    this.blit.dispose();
    this.tri.dispose();
  }
}
