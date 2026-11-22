export const TAU = Math.PI * 2;

/** An angle brought into -PI..PI. */
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A gray as painted (0 to 1) in linear light. */
export const lin = (g: number) => Math.pow(g, 2.2);

/** Eases from 0 to 1 as t goes from 0 to 1, flat at both ends; clamped outside. */
export const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
