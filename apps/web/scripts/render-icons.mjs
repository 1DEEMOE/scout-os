// Usage (from apps/web): node scripts/render-icons.mjs public/icons
/* global process */
// Renders the original Scout OS mark (rounded teal square + compass) to PNG app icons.
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/package.json")("@playwright/test");
const out = process.argv[2];
const mark = (size, pad) => `<!doctype html><html><body style="margin:0;background:transparent">
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
  <rect width="24" height="24" rx="${pad ? 0 : 5.5}" fill="#17616a"/>
  <g transform="${pad ? "translate(4.8 4.8) scale(0.6)" : ""}">
    <circle cx="12" cy="12" r="6.5" fill="none" stroke="#ffffff" stroke-width="1.6" opacity="0.55"/>
    <path d="M12 6.5 L14.2 12 L12 17.5 L9.8 12 Z" fill="#ffffff"/>
  </g>
</svg></body></html>`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage();
for (const [name, size, maskable] of [["icon-192.png", 192, false], ["icon-512.png", 512, false], ["maskable-512.png", 512, true], ["apple-touch-icon.png", 180, true]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(mark(size, maskable));
  await page.locator("svg").screenshot({ path: `${out}/${name}`, omitBackground: true });
}
await browser.close();
