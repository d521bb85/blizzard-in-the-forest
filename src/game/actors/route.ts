import { coreRadius, type Collider } from "../world/collider";
import type { World } from "../world/world";

/** How far a spruce's skirt of branches reaches, for a deer: it would rather go round than push under. */
const skirtRadius = (c: Collider) => c.r * 0.8 + 0.3;
/** Extra cost per metre under a skirt. */
const SKIRT_COST = 4;
/** Metres between nodes along the arc, and between rings. */
const STEP = 1;
const RING_STEP = 0.75;
/** How many rings, outwards from the starting one, a route may use to get round trees. */
const RINGS = 12;
/** Cost per metre of being off the ideal ring, which drifts outwards along the crossing. */
const OFF_RING_COST = 0.35;

export interface Arc {
  /** Centre: where the walker stood. */
  x: number;
  z: number;
  /** Starting radius, and how much further out the ideal ring ends. */
  radius: number;
  drift: number;
  /** Start and end bearings, in the (sin, cos) heading convention. */
  from: number;
  to: number;
}

/**
 * Plans a crossing round a centre point over a polar grid (bearing x ring) in
 * which every move goes along the arc or outwards, never inwards: whatever the
 * route does to get round trees, it never brings the deer nearer the centre.
 * The grid has no way back, so dynamic programming over bearings is enough.
 */
export class ArcPlanner {
  private colliders: Collider[] = [];
  private cost = new Float32Array(0);
  private parent = new Int32Array(0);
  private blocked = new Uint8Array(0);

  constructor(private world: World) {}

  /**
   * Writes the route as x, z pairs, one per node, the first being the start.
   * If trees wall off the way, the route ends where it has to.
   * Returns false when not even the start is open.
   */
  plan(arc: Arc, out: number[]): boolean {
    out.length = 0;
    const span = arc.to - arc.from;
    const cols = Math.max(2, Math.ceil((Math.abs(span) * arc.radius) / STEP) + 1);
    const n = cols * RINGS;
    if (this.cost.length < n) {
      this.cost = new Float32Array(n);
      this.parent = new Int32Array(n);
      this.blocked = new Uint8Array(n);
    }
    const bearing = (i: number) => arc.from + (span * i) / (cols - 1);
    const ringR = (j: number) => arc.radius + j * RING_STEP;
    const nodeX = (i: number, j: number) => arc.x + Math.sin(bearing(i)) * ringR(j);
    const nodeZ = (i: number, j: number) => arc.z + Math.cos(bearing(i)) * ringR(j);

    // Trees: cores are walls, skirts cost extra.
    const outer = ringR(RINGS - 1) + 6;
    this.world.collidersIn(arc.x - outer, arc.z - outer, arc.x + outer, arc.z + outer, this.colliders);
    const blocked = this.blocked;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < RINGS; j++) {
        const x = nodeX(i, j);
        const z = nodeZ(i, j);
        let b = 0;
        for (const c of this.colliders) {
          const dx = x - c.x;
          const dz = z - c.z;
          const d2 = dx * dx + dz * dz;
          const core = coreRadius(c) + 0.35;
          if (d2 < core * core) {
            b = 255;
            break;
          }
          const skirt = skirtRadius(c);
          if (d2 < skirt * skirt) b = Math.min(254, b + SKIRT_COST);
        }
        blocked[i * RINGS + j] = b;
      }
    }

    // Start on the innermost open ring of the first column.
    let start = -1;
    for (let j = 0; j < RINGS && start < 0; j++) if (blocked[j] < 255) start = j;
    if (start < 0) return false;

    const cost = this.cost;
    const parent = this.parent;
    cost.fill(Infinity, 0, n);
    cost[start] = 0;
    parent[start] = -1;
    const ideal = (i: number) => arc.radius + (arc.drift * i) / (cols - 1);
    const arcLen = (j: number) => (Math.abs(span) * ringR(j)) / (cols - 1);
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < RINGS; j++) {
        const k = i * RINGS + j;
        if (blocked[k] === 255 || (i === 0 && j <= start)) continue;
        const w = 1 + blocked[k];
        const off = Math.abs(ringR(j) - ideal(i)) * OFF_RING_COST;
        let best = Infinity;
        let from = -1;
        // Along the arc, along and outwards, or straight outwards.
        if (i > 0) {
          const a = cost[k - RINGS] + arcLen(j) * w + off;
          if (a < best) [best, from] = [a, k - RINGS];
          if (j > 0) {
            const b = cost[k - RINGS - 1] + Math.hypot(arcLen(j), RING_STEP) * w + off;
            if (b < best) [best, from] = [b, k - RINGS - 1];
          }
        }
        if (j > 0) {
          const c = cost[k - 1] + RING_STEP * w * 1.3;
          if (c < best) [best, from] = [c, k - 1];
        }
        if (best < Infinity) {
          cost[k] = best;
          parent[k] = from;
        }
      }
    }

    // End at the furthest column reached, on its cheapest ring.
    let end = start;
    for (let i = cols - 1; i > 0 && end === start; i--) {
      let best = Infinity;
      for (let j = 0; j < RINGS; j++) {
        const k = i * RINGS + j;
        if (cost[k] < best) {
          best = cost[k];
          end = k;
        }
      }
    }
    const nodes: number[] = [];
    for (let k = end; k !== -1; k = parent[k]) nodes.push(k);
    for (let m = nodes.length - 1; m >= 0; m--) {
      const k = nodes[m];
      out.push(nodeX((k / RINGS) | 0, k % RINGS), nodeZ((k / RINGS) | 0, k % RINGS));
    }
    return true;
  }
}
