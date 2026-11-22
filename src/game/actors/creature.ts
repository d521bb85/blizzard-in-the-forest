import * as THREE from "three";
import { TAU, lin } from "../lib/math";
import { injectBlizzardFog } from "../render/fog";
import { injectRetro } from "../render/retro";
import { COLOUR_LIFT } from "../world/world";

/**
 * What the deer and the yeti are made with: shapes painted in grays (snow on what faces
 * up), and the coat material that colours them, fogs them and lets them dissolve.
 */

/** Gives a geometry a flat grayscale colour, with a light dusting of snow on top-facing faces. */
export function paint(geo: THREE.BufferGeometry, gray: number, snow = 0): THREE.BufferGeometry {
  geo.deleteAttribute("uv");
  const n = geo.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const c = lin(gray + Math.max(0, n.getY(i) - 0.55) * snow);
    colors.set([c, c, c], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("own", new THREE.BufferAttribute(new Float32Array(n.count * 4), 4));
  geo.setAttribute("heat", new THREE.BufferAttribute(new Float32Array(n.count).fill(1), 1));
  return geo;
}

/**
 * How warm a painted part is, as a share of its creature's warmth (1, as painted, is
 * the creature's own): thick fur or a sheepskin keeps the heat in and shows cool, bare
 * skin shows hot. Only the eyes that see heat see it.
 */
export function warm(geo: THREE.BufferGeometry, share: number): THREE.BufferGeometry {
  (geo.attributes.heat as THREE.BufferAttribute).array.fill(share);
  return geo;
}

/**
 * Gives a painted geometry a colour of its own for the world in colour, in place of its
 * coat's palette (an eye, a tooth), and how strongly it glows with it. In black and white
 * it stays the gray it was painted.
 */
export function dye(geo: THREE.BufferGeometry, colour: THREE.ColorRepresentation, glow = 0): THREE.BufferGeometry {
  const c = new THREE.Color(colour);
  const own = geo.attributes.own as THREE.BufferAttribute;
  for (let i = 0; i < own.count; i++) own.setXYZW(i, c.r, c.g, c.b, glow);
  return geo;
}

export function ellipsoid(rx: number, ry: number, rz: number, x: number, y: number, z: number, tilt = 0): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 12, 8);
  g.scale(rx, ry, rz);
  g.rotateX(tilt);
  g.translate(x, y, z);
  return g;
}

/** One cross-section of a lofted shape: its centre, its two half-widths, and its grey. */
export type Ring = [c0: number, c1: number, r0: number, r1: number, gray: number];

/**
 * A loft through elliptical rings, capped at both ends. Along "y" the rings run
 * downwards and are (z, y, rx, rz) — a leg hanging from its joint at the origin;
 * along "z" they run front to back and are (z, y, rx, ry) — a torso.
 */
export function loft(axis: "y" | "z", rings: Ring[], snow: number, seg = 7): THREE.BufferGeometry {
  const pos: number[] = [];
  const grays: number[] = [];
  const index: number[] = [];
  for (const [c0, c1, r0, r1, gray] of rings) {
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * TAU;
      if (axis === "y") pos.push(Math.cos(a) * r0, c1, c0 + Math.sin(a) * r1);
      else pos.push(Math.cos(a) * r0, c1 + Math.sin(a) * r1, c0);
      grays.push(gray);
    }
  }
  const n = rings.length;
  const first = rings[0];
  const last = rings[n - 1];
  const capStart = pos.length / 3;
  pos.push(0, first[1], first[0], 0, last[1], last[0]);
  grays.push(first[4], last[4]);
  // The torso's rings sit in a mirrored frame, so its faces wind the other way round.
  const tri = axis === "y" ? (a: number, b: number, c: number) => index.push(a, b, c) : (a: number, b: number, c: number) => index.push(a, c, b);
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      tri(a, b, b + seg);
      tri(a, b + seg, a + seg);
    }
  }
  for (let j = 0; j < seg; j++) {
    const k = (j + 1) % seg;
    tri(capStart, k, j);
    tri(capStart + 1, (n - 1) * seg + j, (n - 1) * seg + k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  const normal = g.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array(normal.count * 3);
  for (let i = 0; i < normal.count; i++) {
    const c = lin(grays[i] + Math.max(0, normal.getY(i) - 0.55) * snow);
    colors.set([c, c, c], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.setAttribute("own", new THREE.BufferAttribute(new Float32Array(normal.count * 4), 4));
  g.setAttribute("heat", new THREE.BufferAttribute(new Float32Array(normal.count).fill(1), 1));
  return g;
}

/** A cylinder from a to b. */
export function rod(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, 5, 1);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

/**
 * A coat's colours for the world in colour. The geometry stays painted in grays; the
 * gray picks a colour from dark to pale, and only that colour's hue is used, so every
 * part keeps the brightness it has in black and white.
 */
export interface CoatPalette {
  dark: THREE.ColorRepresentation;
  mid: THREE.ColorRepresentation;
  pale: THREE.ColorRepresentation;
  /** The grays (as painted, 0 to 1) at which the coat is fully dark, mid and pale. */
  stops: [dark: number, mid: number, pale: number];
  /** What faces the ground: belly, throat, the insides of the legs. */
  under: THREE.ColorRepresentation;
}

/**
 * Each creature has its own material (all sharing one program) so it can dissolve on
 * its own: veil blends it into the fog and drops a growing share of its pixels,
 * which at the scene's coarse pixels reads as drifting snow. In colour it takes its
 * coat from a palette; snow lying on top of it stays white. `warmth` is how warm it shows
 * to the eyes that see heat (0 cold to 1 as warm as a face), each part's share of it painted
 * with warm().
 */
export function createCoatMaterial(veil: { value: number }, coat: CoatPalette, warmth = 0): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const tints = {
    uCoatDark: { value: new THREE.Color(coat.dark) },
    uCoatMid: { value: new THREE.Color(coat.mid) },
    uCoatPale: { value: new THREE.Color(coat.pale) },
    uCoatUnder: { value: new THREE.Color(coat.under) },
    uCoatStops: { value: new THREE.Vector3(...coat.stops) },
    uWarmth: { value: warmth }
  };
  mat.onBeforeCompile = (shader) => {
    injectBlizzardFog(shader, "vHeat * (1.0 - uVeil)");
    shader.uniforms.uVeil = veil;
    Object.assign(shader.uniforms, tints);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 own;\nattribute float heat;\nuniform float uWarmth;\nvarying vec4 vOwn;\nvarying vec2 vLie;\nvarying float vHeat;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vOwn = own;
        vHeat = heat * uWarmth;
        // How much the surface faces up (snow lies on it) and down (the belly).
        vLie = vec2(smoothstep(0.55, 0.9, normal.y), smoothstep(0.2, 0.8, -normal.y));`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <fog_pars_fragment>",
        `#include <fog_pars_fragment>
        uniform float uVeil;
        uniform vec3 uCoatDark;
        uniform vec3 uCoatMid;
        uniform vec3 uCoatPale;
        uniform vec3 uCoatUnder;
        uniform vec3 uCoatStops;
        varying vec4 vOwn;
        varying vec2 vLie;
        varying float vHeat;`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
          float gray = pow(max(diffuseColor.r, 0.0), 1.0 / 2.2);
          vec3 hue = mix(
            mix(uCoatDark, uCoatMid, smoothstep(uCoatStops.x, uCoatStops.y, gray)),
            uCoatPale, smoothstep(uCoatStops.y, uCoatStops.z, gray));
          hue = mix(hue, uCoatUnder, vLie.y * 0.7);
          hue = mix(hue, vec3(1.0), vLie.x);
          // Only the hue: the painted gray keeps its brightness, but for the darkest, lifted out of the black.
          float lift = mix(${COLOUR_LIFT.toFixed(1)}, 1.0, smoothstep(0.0, 0.3, diffuseColor.r));
          vec3 tinted = diffuseColor.rgb * lift * hue / max(dot(hue, LUMA), 1e-3);
          if (vOwn.r + vOwn.g + vOwn.b > 0.0) tinted = vOwn.rgb;
          diffuseColor.rgb = mix(diffuseColor.rgb, tinted, uColour);
        }`
      )
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vOwn.rgb * (vOwn.a * uColour);"
      )
      .replace(
        "#include <premultiplied_alpha_fragment>",
        `if (bzHash(vec3(floor(gl_FragCoord.xy), 7.3)) < uVeil * uVeil * 1.02) discard;
        // Into the same colour as the fog around it, sun glow included.
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor + bzSunGlow(normalize(vBzWorld - cameraPosition)), uVeil);
        #include <premultiplied_alpha_fragment>`
      );
    injectRetro(shader);
  };
  return mat;
}
