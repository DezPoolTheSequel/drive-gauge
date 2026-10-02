import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
const out = "com.dez.drivegauge.sdPlugin/imgs";
const png = (svg, w, file) => fs.writeFileSync(file, new Resvg(svg, { fitTo: { mode: "width", value: w } }).render().asPng());

// Monochrome glyph: a drive with a gauge arc (category + action list icons)
const glyph = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
 <rect x="5" y="24" width="30" height="10" rx="2.5" fill="none" stroke="${c}" stroke-width="2.6"/>
 <circle cx="29" cy="29" r="1.8" fill="${c}"/>
 <path d="M 8 20 A 12 12 0 0 1 32 20" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round" opacity="0.45"/>
 <path d="M 8 20 A 12 12 0 0 1 26 9.6" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;
png(glyph("#FFFFFF"), 28, `${out}/plugin/category-icon.png`);
png(glyph("#FFFFFF"), 56, `${out}/plugin/category-icon@2x.png`);
png(glyph("#FFFFFF"), 20, `${out}/actions/drive/icon.png`);
png(glyph("#FFFFFF"), 40, `${out}/actions/drive/icon@2x.png`);

// Colour plugin icon
const big = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
 <rect width="144" height="144" rx="28" fill="#101318"/>
 <circle cx="72" cy="72" r="46" fill="none" stroke="#2B313B" stroke-width="14"/>
 <path d="M 72 26 A 46 46 0 1 1 26.3 77" fill="none" stroke="#3DDC84" stroke-width="14" stroke-linecap="round"/>
 <rect x="50" y="62" width="44" height="20" rx="4" fill="none" stroke="#D7DCE3" stroke-width="4"/>
 <circle cx="85" cy="72" r="3" fill="#3DDC84"/>
</svg>`;
png(big, 288, `${out}/plugin/marketplace.png`);
png(big, 576, `${out}/plugin/marketplace@2x.png`);
png(big, 72, `${out}/actions/drive/key.png`);
png(big, 144, `${out}/actions/drive/key@2x.png`);
console.log("icons ok");
