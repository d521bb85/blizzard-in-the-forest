/**
 * Waits for the Jersey 10 pixel font to load (never rejects; falls back after `timeoutMs`),
 * so pages can fade in without a fallback-font flash or layout jump.
 */
export function waitForPixelFont(timeoutMs = 2000): Promise<void> {
  if (!document.fonts) return Promise.resolve();
  const load = document.fonts
    .load('400 16px "Jersey 10"')
    .then(() => document.fonts.ready)
    .then(() => undefined)
    .catch(() => undefined);
  const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs));
  return Promise.race([load, timeout]);
}

/**
 * Centring puts a pixel-font box on a half CSS pixel when the leftover width is odd.
 * Toggles `nudge` on `target` (which adds 1px of horizontal padding) to keep every glyph
 * edge aligned to the screen's pixel grid.
 */
export function snapEven(target: HTMLElement, content: HTMLElement, container: HTMLElement = target, inset = 0): void {
  target.classList.remove("nudge");
  const room = container.clientWidth - inset;
  if (Math.round(room - content.getBoundingClientRect().width) % 2 !== 0) {
    target.classList.add("nudge");
  }
}
