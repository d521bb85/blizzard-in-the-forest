import * as THREE from "three";
import { blizzardUniforms, NOISE_GLSL, SUN_GLSL } from "./fog";

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 fogColor;
uniform float uFogTime;
varying vec3 vDir;
${NOISE_GLSL}
${SUN_GLSL}
void main() {
  gl_FragColor = vec4(fogColor + bzSunGlow(normalize(vDir)), 1.0);
}
`;

/**
 * The sky: nothing but fog, with the sun's glow coming through. A dome that
 * travels with the camera and is drawn first, behind everything else.
 */
export class Sky {
  readonly mesh: THREE.Mesh;

  constructor(fogColor: THREE.Color, radius: number) {
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      uniforms: { ...blizzardUniforms, fogColor: { value: fogColor } }
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }

  update(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
