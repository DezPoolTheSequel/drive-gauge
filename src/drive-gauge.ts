import { spawn } from "node:child_process";
import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { getUsage, listDrives, normalizeRoot, type UsageResult } from "./drives.js";
import { levelFor, renderSvg, toDataUrl, formatBytes } from "./render.js";
import { resolveSettings, type GaugeSettings } from "./settings.js";

interface KeyState {
	action: KeyAction<JsonObject>;
	settings: GaugeSettings;
	usage?: UsageResult;
	pollTimer?: NodeJS.Timeout;
	flashTimer?: NodeJS.Timeout;
	flashOn: boolean;
	lastImage?: string;
}

const log = () => streamDeck.logger.createScope("gauge");

function candidates(s: GaugeSettings): string[] {
	if (s.source === "custom") return s.customPath ? [s.customPath] : [];
	const list: string[] = [];
	if (s.drive) list.push(s.drive);
	if (s.unc) list.push(s.unc); // mapped drive fallback: keeps working if the letter drops
	return list;
}

function autoLabel(s: GaugeSettings): string {
	if (s.label && s.label.trim()) return s.label.trim();
	if (s.source === "custom") {
		const p = s.customPath.replace(/[\\/]+$/, "");
		const last = p.split(/[\\/]/).filter(Boolean).pop();
		return last ?? p;
	}
	return s.drive || "";
}

@action({ UUID: "com.dez.drivegauge.drive" })
export class DriveGauge extends SingletonAction<JsonObject> {
	private keys = new Map<string, KeyState>();
	private piActionId?: string;

	override async onWillAppear(ev: WillAppearEvent<JsonObject>): Promise<void> {
		if (!ev.action.isKey()) return;
		const st: KeyState = { action: ev.action, settings: resolveSettings(ev.payload.settings), flashOn: true };
		this.keys.set(ev.action.id, st);
		await this.draw(st, true);
		this.schedule(st);
		await this.refresh(st);
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		const st = this.keys.get(ev.action.id);
		if (!st) return;
		clearInterval(st.pollTimer);
		clearInterval(st.flashTimer);
		this.keys.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<JsonObject>): Promise<void> {
		const st = this.keys.get(ev.action.id);
		if (!st) return;
		const before = candidates(st.settings).join("|");
		const beforeRefresh = st.settings.refresh;
		st.settings = resolveSettings(ev.payload.settings);
		if (candidates(st.settings).join("|") !== before) {
			st.usage = undefined;
			await this.draw(st, true);
			await this.refresh(st, true);
		} else {
			await this.draw(st);
		}
		if (st.settings.refresh !== beforeRefresh) this.schedule(st);
	}

	override async onKeyDown(ev: KeyDownEvent<JsonObject>): Promise<void> {
		const st = this.keys.get(ev.action.id);
		if (!st) return;
		const s = st.settings;
		switch (s.press) {
			case "refresh":
				await this.refresh(st, true);
				await ev.action.showOk();
				break;
			case "cycle": {
				// used % → free % → used size → free size → …
				const order: [GaugeSettings["metric"], GaugeSettings["value"]][] = [
					["used", "percent"],
					["free", "percent"],
					["used", "size"],
					["free", "size"],
				];
				const i = order.findIndex(([m, v]) => m === s.metric && v === s.value);
				const [metric, value] = order[(i + 1) % order.length];
				const raw = (ev.payload.settings ?? {}) as JsonObject;
				await ev.action.setSettings({ ...raw, metric, value });
				st.settings = resolveSettings({ ...raw, metric, value });
				await this.draw(st);
				break;
			}
			case "open":
			default: {
				const target = st.usage?.via ?? candidates(s)[0];
				if (!target) return;
				try {
					spawn("explorer.exe", [normalizeRoot(target)], { detached: true, stdio: "ignore", windowsHide: false }).unref();
				} catch (e) {
					log().error(`open failed: ${(e as Error).message}`);
					await ev.action.showAlert();
				}
			}
		}
	}

	override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<JsonObject>): void {
		// The PI asks for drives + status itself once its socket is open (avoids lost messages).
		this.piActionId = ev.action.id;
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
		const msg = (ev.payload ?? {}) as { cmd?: string };
		if (msg.cmd === "listDrives") await this.sendDrives();
		if (msg.cmd === "refresh") {
			this.piActionId = ev.action.id;
			const st = this.keys.get(ev.action.id);
			if (st) await this.refresh(st, true);
		}
	}

	// ------------------------------------------------------------------ internals

	private schedule(st: KeyState): void {
		clearInterval(st.pollTimer);
		st.pollTimer = setInterval(() => void this.refresh(st), st.settings.refresh * 1000);
	}

	private async refresh(st: KeyState, force = false): Promise<void> {
		const list = candidates(st.settings);
		const usage = await getUsage(list, force ? 0 : 2000);
		if (!this.keys.has(st.action.id)) return; // disappeared meanwhile
		if (!usage.ok) log().debug(`usage failed for ${list.join(", ")}: ${usage.error}`);
		st.usage = usage;
		await this.draw(st);
		await this.sendStatus(st);
	}

	private async draw(st: KeyState, loading = false): Promise<void> {
		const s = st.settings;
		const u = st.usage;
		const ok = !!u?.ok;
		const level = ok ? levelFor(s, u!.total, u!.free) : "ok";

		// flashing frame for low space
		const wantFlash = ok && level === "alert" && s.frame === "flash";
		if (wantFlash && !st.flashTimer) {
			st.flashTimer = setInterval(() => {
				st.flashOn = !st.flashOn;
				void this.draw(st);
			}, 700);
		} else if (!wantFlash && st.flashTimer) {
			clearInterval(st.flashTimer);
			st.flashTimer = undefined;
			st.flashOn = true;
		}

		const svg = renderSvg(s, {
			ok,
			total: u?.total ?? 0,
			free: u?.free ?? 0,
			label: autoLabel(s),
			error: candidates(s).length === 0 ? "no drive selected" : u?.error,
			flashOn: st.flashOn,
			loading: loading || !u,
		});
		const img = toDataUrl(svg);
		if (img === st.lastImage) return;
		st.lastImage = img;
		try {
			await st.action.setImage(img);
		} catch (e) {
			log().warn(`setImage failed: ${(e as Error).message}`);
		}
	}

	private async sendDrives(): Promise<void> {
		try {
			const drives = await listDrives();
			await streamDeck.ui.sendToPropertyInspector({ event: "drives", drives } as unknown as JsonValue);
		} catch (e) {
			await streamDeck.ui.sendToPropertyInspector({ event: "drives", drives: [], error: (e as Error).message });
		}
	}

	private async sendStatus(st: KeyState): Promise<void> {
		if (this.piActionId !== st.action.id) return;
		const u = st.usage;
		const s = st.settings;
		const status = u?.ok
			? `Reading ${u.via ?? "?"} — ${formatBytes(u.free, s)} free of ${formatBytes(u.total, s)}`
			: `Can't read ${candidates(s).join(" or ") || "(nothing selected)"}${u?.error ? ` — ${u.error}` : ""}`;
		try {
			await streamDeck.ui.sendToPropertyInspector({ event: "status", ok: !!u?.ok, status });
		} catch {
			/* PI closed */
		}
	}
}
