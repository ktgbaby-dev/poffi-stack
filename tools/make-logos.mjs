// Cuts the supplied Poffi Stack logo (cream disc + orange Ps on black) into transparent PNGs:
// the disc itself is untouched; only the black ground around it is removed. Also makes favicons.
// Usage: node tools/make-logos.mjs   (needs Chrome or the Playwright Chromium)
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = join(root, "public/assets/img/poffi-stack-logo.jpg");
const out = (f) => join(root, "public/assets/img", f);
const b64 = readFileSync(src).toString("base64");

// Disc bounds measured from the source image (1280 x 1256): x 96..1183, y 101..1189.
const DISC = { x: 96, y: 101, d: 1088, w: 1280 };
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].find(existsSync);
const browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function disc(size, file, { inset = 0.004 } = {}) {
  const scale = size / (DISC.d * (1 - 2 * inset));
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <div id="d" style="width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;position:relative">
      <img src="data:image/jpeg;base64,${b64}" style="position:absolute;width:${DISC.w * scale}px;left:${-(DISC.x + DISC.d * inset) * scale}px;top:${-(DISC.y + DISC.d * inset) * scale}px">
    </div></body></html>`);
  await page.locator("#d").screenshot({ path: out(file), omitBackground: true });
}

async function square(size, file) {
  // The original artwork as supplied (disc on black), centred in a square.
  const scale = size / 1180;
  await page.setContent(`<html><body style="margin:0;background:#000">
    <div id="d" style="width:${size}px;height:${size}px;overflow:hidden;position:relative;background:#000">
      <img src="data:image/jpeg;base64,${b64}" style="position:absolute;width:${DISC.w * scale}px;left:${-(DISC.x + DISC.d / 2 - 590) * scale}px;top:${-(DISC.y + DISC.d / 2 - 590) * scale}px">
    </div></body></html>`);
  await page.locator("#d").screenshot({ path: out(file) });
}

await disc(512, "logo-disc-512.png");
await disc(192, "logo-disc-192.png");
await disc(96, "logo-disc-96.png");
await disc(32, "favicon-32.png", { inset: 0.01 });
await square(180, "apple-touch-icon.png");
await square(512, "logo-square-512.png");
await browser.close();
console.log("logos written");
