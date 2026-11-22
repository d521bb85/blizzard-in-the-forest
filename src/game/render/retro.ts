import * as THREE from "three";

/**
 * The look of a late-90s console: the scene renders at about 240 lines, and
 * every vertex lands on a whole pixel of that grid, so edges crawl and
 * surfaces wobble a little as the camera moves.
 */
export const retroUniforms = {
  /** Half the scene target's size in pixels: clip space spans 2 units. */
  uSnap: { value: new THREE.Vector2(160, 120) }
};

/** Texels per metre of the snow "texture". */
export const SNOW_TEXELS = 8;

type Shader = THREE.WebGLProgramParametersWithUniforms;

export interface RetroOptions {
  /**
   * A GLSL vec2 expression valid at the end of the vertex shader, passed on
   * without perspective correction, like texture coordinates on the console:
   * read it in the fragment shader with `retroAffine()`.
   */
  affine?: string;
  /**
   * The same for a GLSL vec3 expression, read with `retroAffine3()`: a model's own
   * coordinates, for a texture that sticks to it.
   */
  affine3?: string;
  /**
   * Project through the world position instead of the per-mesh modelViewMatrix,
   * so vertices that two meshes share at the same world position (terrain chunk
   * seams) come out bit-identical and always snap to the same pixel. Only for
   * meshes without instancing, skinning or morphs.
   */
  worldSpace?: boolean;
}

/** Snaps vertices to the pixel grid. Call after any other injection. */
export function injectRetro(shader: Shader, { affine, affine3, worldSpace = false }: RetroOptions = {}): void {
  Object.assign(shader.uniforms, retroUniforms);
  const varying = (affine ? "varying vec3 vRetroAffine;\n" : "") + (affine3 ? "varying vec4 vRetroAffine3;\n" : "");
  // Appended at the very end of main(), after every other chunk has set gl_Position.
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\nuniform vec2 uSnap;\n${varying}`)
    .replace(
      /}\s*$/,
      `${worldSpace ? "  gl_Position = projectionMatrix * (viewMatrix * (modelMatrix * vec4(transformed, 1.0)));\n" : ""}${
        affine ? `  vRetroAffine = vec3(${affine}, 1.0) * gl_Position.w;\n` : ""
      }${affine3 ? `  vRetroAffine3 = vec4(${affine3}, 1.0) * gl_Position.w;\n` : ""}
  if (gl_Position.w > 0.0) {
    // Round in window space, so the grid is the pixel corners whether the size is odd or even.
    vec2 win = (gl_Position.xy / gl_Position.w + 1.0) * uSnap;
    gl_Position.xy = (floor(win + 0.5) / uSnap - 1.0) * gl_Position.w;
  }
}
`
    );
  if (affine || affine3) {
    // Interpolating (a * w, w) perspective-correctly and dividing undoes the correction.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>\n${varying}${affine ? "vec2 retroAffine() { return vRetroAffine.xy / vRetroAffine.z; }\n" : ""}${
        affine3 ? "vec3 retroAffine3() { return vRetroAffine3.xyz / vRetroAffine3.w; }\n" : ""
      }`
    );
  }
}
