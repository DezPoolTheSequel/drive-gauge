export type Style = "ring" | "arc" | "pie" | "bar" | "vbar" | "text";
export type Metric = "free" | "used";
export type ValueMode = "percent" | "size" | "none";
export type SubMode = "usedTotal" | "freeTotal" | "total" | "free" | "used" | "percent" | "none";

export interface GaugeSettings {
	[key: string]: string | number | boolean | undefined;
	// --- source
	source: "drive" | "custom";
	drive: string; // "Z:"
	unc: string; // remembered UNC for mapped drives ("\\nas\media")
	driveType: string;
	driveLabel: string;
	customPath: string; // any path or UNC share
	// --- what to show
	metric: Metric;
	value: ValueMode;
	sub: SubMode;
	style: Style;
	label: string; // "" = automatic
	showLabel: boolean;
	units: "binary" | "decimal";
	decimals: string; // "auto" | "0" | "1" | "2"
	// --- fonts
	fontFamily: string;
	fontWeight: "normal" | "bold";
	valueSize: number;
	labelSize: number;
	subSize: number;
	valueOffset: number;
	// --- colours
	bgColor: string;
	trackColor: string;
	fillColor: string;
	valueColorMode: "match" | "fixed";
	valueColor: string;
	labelColor: string;
	subColor: string;
	warnColor: string;
	alertColor: string;
	// --- thresholds (always about FREE space)
	thresholdUnit: "percent" | "gb";
	warnBelow: number;
	alertBelow: number;
	frame: "flash" | "solid" | "off";
	// --- shape
	thickness: number;
	scale: number;
	roundCaps: boolean;
	// --- behaviour
	refresh: number; // seconds
	press: "open" | "refresh" | "cycle";
}

export const DEFAULTS: GaugeSettings = {
	source: "drive",
	drive: "C:",
	unc: "",
	driveType: "",
	driveLabel: "",
	customPath: "",
	metric: "used",
	value: "percent",
	sub: "usedTotal",
	style: "ring",
	label: "",
	showLabel: true,
	units: "binary",
	decimals: "auto",
	fontFamily: "Segoe UI",
	fontWeight: "bold",
	valueSize: 30,
	labelSize: 20,
	subSize: 13,
	valueOffset: 0,
	bgColor: "#101318",
	trackColor: "#2B313B",
	fillColor: "#3DDC84",
	valueColorMode: "match",
	valueColor: "#FFFFFF",
	labelColor: "#D7DCE3",
	subColor: "#8A94A3",
	warnColor: "#F4C542",
	alertColor: "#FF4D5E",
	thresholdUnit: "percent",
	warnBelow: 20,
	alertBelow: 10,
	frame: "flash",
	thickness: 12,
	scale: 100,
	roundCaps: true,
	refresh: 30,
	press: "open",
};

const NUMERIC: (keyof GaugeSettings)[] = [
	"valueSize",
	"labelSize",
	"subSize",
	"valueOffset",
	"warnBelow",
	"alertBelow",
	"thickness",
	"scale",
	"refresh",
];
const BOOLEAN: (keyof GaugeSettings)[] = ["showLabel", "roundCaps"];

/** Merge stored settings over defaults and coerce types (the PI stores some values as strings). */
export function resolveSettings(raw: Partial<Record<string, unknown>> | undefined): GaugeSettings {
	const s: GaugeSettings = { ...DEFAULTS };
	for (const [k, v] of Object.entries(raw ?? {})) {
		if (v === undefined || v === null) continue;
		(s as any)[k] = v;
	}
	for (const k of NUMERIC) {
		const n = Number(s[k]);
		(s as any)[k] = Number.isFinite(n) ? n : DEFAULTS[k];
	}
	for (const k of BOOLEAN) {
		const v = s[k];
		(s as any)[k] = v === true || v === "true" || v === 1 || v === "1" || v === "on";
	}
	s.refresh = Math.min(3600, Math.max(5, s.refresh));
	return s;
}
