import type { GaugeSettings } from "./settings.js";

export interface RenderState {
	ok: boolean;
	total: number;
	free: number;
	label: string;
	error?: string;
	flashOn: boolean;
	loading?: boolean;
}

const W = 144;
const H = 144;

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const color = (c: string | undefined, fallback: string) => (c && /^#[0-9a-fA-F]{3,8}$/.test(c.trim()) ? c.trim() : fallback);

// ---------------------------------------------------------------- number formatting

export function formatBytes(bytes: number, s: Pick<GaugeSettings, "units" | "decimals">): string {
	const base = s.units === "decimal" ? 1000 : 1024;
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let v = Math.max(0, bytes);
	let i = 0;
	while (v >= base && i < units.length - 1) {
		v /= base;
		i++;
	}
	return `${fmtNum(v, s.decimals)} ${units[i]}`;
}

/** Same unit for both numbers, e.g. "1.62 / 1.82 TB". */
function formatPair(a: number, b: number, s: Pick<GaugeSettings, "units" | "decimals">): string {
	const base = s.units === "decimal" ? 1000 : 1024;
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let i = 0;
	let vb = Math.max(0, b);
	while (vb >= base && i < units.length - 1) {
		vb /= base;
		i++;
	}
	const va = Math.max(0, a) / Math.pow(base, i);
	return `${fmtNum(va, s.decimals)} / ${fmtNum(vb, s.decimals)} ${units[i]}`;
}

function fmtNum(v: number, decimals: string): string {
	let d: number;
	if (decimals === "0" || decimals === "1" || decimals === "2") d = Number(decimals);
	else d = v < 10 ? 2 : v < 100 ? 1 : 0;
	return v.toFixed(d);
}

function fmtPct(p: number, decimals: string): string {
	const d = decimals === "1" || decimals === "2" ? Number(decimals) : 0;
	return `${(p * 100).toFixed(d)}%`;
}

// ---------------------------------------------------------------- thresholds

export type Level = "ok" | "warn" | "alert";

export function levelFor(s: GaugeSettings, total: number, free: number): Level {
	if (total <= 0) return "ok";
	const gb = s.units === "decimal" ? 1e9 : 1024 ** 3;
	const measure = s.thresholdUnit === "gb" ? free / gb : (free / total) * 100;
	if (s.alertBelow > 0 && measure < s.alertBelow) return "alert";
	if (s.warnBelow > 0 && measure < s.warnBelow) return "warn";
	return "ok";
}

// ---------------------------------------------------------------- geometry helpers

function polar(cx: number, cy: number, r: number, deg: number) {
	const a = ((deg - 90) * Math.PI) / 180;
	return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** Arc path from startDeg sweeping clockwise by sweepDeg (0° = 12 o'clock). */
function arcPath(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number): string {
	const sweep = Math.max(0, Math.min(359.99, sweepDeg));
	const p0 = polar(cx, cy, r, startDeg);
	const p1 = polar(cx, cy, r, startDeg + sweep);
	const large = sweep > 180 ? 1 : 0;
	return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

function sectorPath(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number): string {
	if (sweepDeg >= 359.99) return `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`;
	const p0 = polar(cx, cy, r, startDeg);
	const p1 = polar(cx, cy, r, startDeg + sweepDeg);
	const large = sweepDeg > 180 ? 1 : 0;
	return `M ${cx} ${cy} L ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} Z`;
}

/**
 * Text helper. Stream Deck renders SVG with a "tiny" renderer that ignores dominant-baseline,
 * so vertical centering is done by hand (cap height ≈ 0.7em → baseline = centre + 0.35em).
 */
function text(
	str: string,
	x: number,
	centreY: number,
	size: number,
	fill: string,
	s: GaugeSettings,
	opts: { weight?: string; anchor?: string; outline?: string } = {},
): string {
	if (!str || size <= 0) return "";
	const y = centreY + size * 0.35;
	const font = esc(s.fontFamily || "Segoe UI");
	const weight = opts.weight ?? s.fontWeight;
	const anchor = opts.anchor ?? "middle";
	const common = `x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${font}, Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"`;
	const outline = opts.outline
		? `<text ${common} fill="${opts.outline}" stroke="${opts.outline}" stroke-width="${Math.max(2, size / 7).toFixed(1)}" stroke-linejoin="round">${esc(str)}</text>`
		: "";
	return `${outline}<text ${common} fill="${fill}">${esc(str)}</text>`;
}

/** Shrink a font size so the string fits maxWidth (rough average glyph width ≈ 0.6em bold). */
function fit(str: string, size: number, maxWidth: number, weight: string): number {
	if (!str) return size;
	const em = weight === "bold" ? 0.6 : 0.55;
	const est = str.length * size * em;
	return est <= maxWidth ? size : Math.max(8, Math.floor(maxWidth / (str.length * em)));
}

// ---------------------------------------------------------------- main renderer

export function renderSvg(s: GaugeSettings, st: RenderState): string {
	const bg = color(s.bgColor, "#101318");
	const track = color(s.trackColor, "#2B313B");
	const level: Level = st.ok ? levelFor(s, st.total, st.free) : "ok";
	const fill =
		level === "alert" ? color(s.alertColor, "#FF4D5E") : level === "warn" ? color(s.warnColor, "#F4C542") : color(s.fillColor, "#3DDC84");
	const subFillEarly = color(s.subColor, "#8A94A3");
	const valueFill = !st.ok ? subFillEarly : s.valueColorMode === "fixed" ? color(s.valueColor, "#FFFFFF") : fill;
	const labelFill = color(s.labelColor, "#D7DCE3");
	const subFill = color(s.subColor, "#8A94A3");

	const used = Math.max(0, st.total - st.free);
	const frac = st.ok && st.total > 0 ? (s.metric === "free" ? st.free / st.total : used / st.total) : 0;

	// ---- strings
	let valueStr: string;
	let subStr = "";
	if (!st.ok) {
		valueStr = st.loading ? "…" : "—";
		subStr = st.loading ? "" : st.error === "no drive selected" ? "pick a drive" : "offline";
	} else {
		const metricBytes = s.metric === "free" ? st.free : used;
		valueStr = s.value === "percent" ? fmtPct(frac, s.decimals) : s.value === "size" ? formatBytes(metricBytes, s) : "";
		switch (s.sub) {
			case "usedTotal":
				subStr = formatPair(used, st.total, s);
				break;
			case "freeTotal":
				subStr = formatPair(st.free, st.total, s);
				break;
			case "total":
				subStr = formatBytes(st.total, s);
				break;
			case "free":
				subStr = `${formatBytes(st.free, s)} free`;
				break;
			case "used":
				subStr = `${formatBytes(used, s)} used`;
				break;
			case "percent":
				subStr = `${fmtPct(frac, s.decimals)} ${s.metric}`;
				break;
			default:
				subStr = "";
		}
	}

	const showLabel = s.showLabel && !!st.label;
	const labelSize = s.labelSize;
	const subSize = s.subSize;
	const top = showLabel ? 10 + labelSize : 6;
	const bottom = subStr ? H - 8 - subSize : H - 6;
	const midY = (top + bottom) / 2;
	const thick = Math.max(2, Math.min(40, s.thickness));
	const scale = Math.max(40, Math.min(130, s.scale)) / 100;
	const cap = s.roundCaps ? "round" : "butt";

	const parts: string[] = [];
	parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/>`);

	const valueY = midY + s.valueOffset;

	switch (s.style) {
		case "ring":
		case "arc": {
			const avail = Math.min(W - 12, bottom - top);
			const r = Math.max(10, (avail / 2) * scale - thick / 2);
			const isArc = s.style === "arc";
			const start = isArc ? 225 : 0; // arc: 270° gauge open at the bottom
			const span = isArc ? 270 : 360;
			const cy = isArc ? midY + r * 0.12 : midY;
			if (isArc) parts.push(`<path d="${arcPath(72, cy, r, start, span)}" fill="none" stroke="${track}" stroke-width="${thick}" stroke-linecap="${cap}"/>`);
			else parts.push(`<circle cx="72" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="none" stroke="${track}" stroke-width="${thick}"/>`);
			if (frac > 0.002) {
				if (!isArc && frac >= 0.999)
					parts.push(`<circle cx="72" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="none" stroke="${fill}" stroke-width="${thick}"/>`);
				else
					parts.push(`<path d="${arcPath(72, cy, r, start, span * frac)}" fill="none" stroke="${fill}" stroke-width="${thick}" stroke-linecap="${cap}"/>`);
			}
			const inner = 2 * (r - thick / 2) - 8;
			parts.push(text(valueStr, 72, cy + s.valueOffset, fit(valueStr, s.valueSize, inner, s.fontWeight), valueFill, s));
			break;
		}
		case "pie": {
			const avail = Math.min(W - 12, bottom - top);
			const r = Math.max(10, (avail / 2) * scale);
			parts.push(`<circle cx="72" cy="${midY.toFixed(2)}" r="${r.toFixed(2)}" fill="${track}"/>`);
			if (frac > 0.002) parts.push(`<path d="${sectorPath(72, midY, r, 0, 360 * frac)}" fill="${fill}"/>`);
			parts.push(
				text(valueStr, 72, valueY, fit(valueStr, s.valueSize, W - 12, s.fontWeight), s.valueColorMode === "fixed" || !st.ok ? valueFill : "#FFFFFF", s, {
					outline: bg,
				}),
			);
			break;
		}
		case "bar": {
			const barW = (W - 20) * Math.min(1, scale);
			const x0 = (W - barW) / 2;
			const by = bottom - thick - 4;
			const rx = s.roundCaps ? thick / 2 : 2;
			parts.push(`<rect x="${x0.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${thick}" rx="${rx}" fill="${track}"/>`);
			if (frac > 0.002) {
				const fw = Math.max(rx * 2, barW * frac);
				parts.push(`<rect x="${x0.toFixed(1)}" y="${by.toFixed(1)}" width="${fw.toFixed(1)}" height="${thick}" rx="${rx}" fill="${fill}"/>`);
			}
			parts.push(text(valueStr, 72, (top + by) / 2 + s.valueOffset, fit(valueStr, s.valueSize, W - 10, s.fontWeight), valueFill, s));
			break;
		}
		case "vbar": {
			const barH = (bottom - top - 4) * Math.min(1, scale);
			const y0 = top + (bottom - top - barH) / 2;
			const bx = 12;
			const rx = s.roundCaps ? thick / 2 : 2;
			parts.push(`<rect x="${bx}" y="${y0.toFixed(1)}" width="${thick}" height="${barH.toFixed(1)}" rx="${rx}" fill="${track}"/>`);
			if (frac > 0.002) {
				const fh = Math.max(rx * 2, barH * frac);
				parts.push(`<rect x="${bx}" y="${(y0 + barH - fh).toFixed(1)}" width="${thick}" height="${fh.toFixed(1)}" rx="${rx}" fill="${fill}"/>`);
			}
			const tx = (bx + thick + W - 4) / 2;
			parts.push(text(valueStr, tx, valueY, fit(valueStr, s.valueSize, W - 8 - (bx + thick), s.fontWeight), valueFill, s));
			break;
		}
		case "text":
		default:
			parts.push(text(valueStr, 72, valueY, fit(valueStr, s.valueSize, W - 10, s.fontWeight), valueFill, s));
			break;
	}

	if (showLabel) parts.push(text(st.label, 72, 6 + labelSize / 2, fit(st.label, labelSize, W - 10, s.fontWeight), labelFill, s));
	if (subStr) parts.push(text(subStr, 72, H - 6 - subSize / 2, fit(subStr, subSize, W - 8, "normal"), subFill, s, { weight: "normal" }));

	if (st.ok && level === "alert" && s.frame !== "off" && (s.frame === "solid" || st.flashOn)) {
		parts.push(`<rect x="3" y="3" width="${W - 6}" height="${H - 6}" rx="14" fill="none" stroke="${color(s.alertColor, "#FF4D5E")}" stroke-width="6"/>`);
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

export const toDataUrl = (svg: string) => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
