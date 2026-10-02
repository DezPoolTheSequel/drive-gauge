import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import streamDeck from "@elgato/streamdeck";

export type DriveType = "local" | "network" | "removable" | "optical" | "ram" | "unknown";

export interface DriveEntry {
	letter: string; // "Z:"
	root: string; // "Z:\"
	type: DriveType;
	label?: string;
	unc?: string;
	fileSystem?: string;
	ready: boolean;
	total: number;
	free: number;
}

export interface UsageResult {
	ok: boolean;
	total: number;
	free: number;
	error?: string;
	via?: string; // which path answered (letter or UNC)
}

const log = () => streamDeck.logger.createScope("drives");

/**
 * Talks to a long-lived PowerShell helper (bin/drive-worker.ps1). The helper calls
 * GetDiskFreeSpaceEx / GetLogicalDrives / WNetGetConnection in the user's own session,
 * which is why mapped network drives show up, and it has per-probe timeouts so a sleeping
 * NAS can't freeze the plugin.
 */
class DriveWorker {
	private proc?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private failures = 0;
	public disabled = false;

	private start(): void {
		if (this.proc || this.disabled) return;
		const script = path.join(path.dirname(process.argv[1] ?? path.join(process.cwd(), "bin", "x")), "drive-worker.ps1");
		const exe = process.env.SystemRoot
			? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
			: "powershell.exe";
		log().info(`starting worker: ${exe} ${script}`);
		const proc = spawn(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
			windowsHide: true,
			stdio: "pipe",
		});
		this.proc = proc;
		proc.stdout.setEncoding("utf8");
		createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (d) => log().warn(`worker stderr: ${String(d).trim()}`));
		proc.on("error", (err) => {
			log().error(`worker failed to start: ${err.message}`);
			this.onExit();
		});
		proc.on("exit", (code) => {
			log().warn(`worker exited (${code})`);
			this.onExit();
		});
	}

	private onExit(): void {
		this.proc = undefined;
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error("worker exited"));
		}
		this.pending.clear();
		this.failures++;
		if (this.failures >= 5) {
			this.disabled = true;
			log().error("worker keeps failing; falling back to Node statfs");
		}
	}

	private onLine(line: string): void {
		let msg: any;
		try {
			msg = JSON.parse(line.replace(/^\uFEFF/, ""));
		} catch {
			log().debug(`worker non-json: ${line}`);
			return;
		}
		if (msg.id === 0 && msg.ready) {
			this.failures = 0;
			log().info(`worker ready (PowerShell ${msg.ps})`);
			return;
		}
		const p = this.pending.get(msg.id);
		if (!p) return;
		clearTimeout(p.timer);
		this.pending.delete(msg.id);
		if (msg.ok) p.resolve(msg);
		else p.reject(new Error(msg.error ?? "worker error"));
	}

	request(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
		this.start();
		const proc = this.proc;
		if (!proc) return Promise.reject(new Error("worker unavailable"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`worker timeout (${cmd})`));
				// A wedged worker is restarted on the next request.
				try {
					proc.kill();
				} catch {
					/* ignore */
				}
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
		});
	}

	stop(): void {
		this.proc?.kill();
	}
}

const worker = new DriveWorker();
const isWindows = process.platform === "win32";

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function normalizeRoot(p: string): string {
	let s = p.trim();
	if (!isWindows) return s;
	s = s.replace(/\//g, "\\");
	if (!s.endsWith("\\")) s += "\\";
	return s;
}

export async function listDrives(): Promise<DriveEntry[]> {
	if (isWindows && !worker.disabled) {
		try {
			const res = await worker.request("list", { timeout: 4000 });
			return asArray<any>(res.drives)
				.map((d) => ({
					letter: String(d.Letter),
					root: String(d.Root),
					type: (d.Type ?? "unknown") as DriveType,
					label: d.Label || undefined,
					unc: d.Unc || undefined,
					fileSystem: d.FileSystem || undefined,
					ready: !!d.Ready,
					total: Number(d.Total) || 0,
					free: Number(d.Free) || 0,
				}))
				.sort((a, b) => a.letter.localeCompare(b.letter));
		} catch (e) {
			log().warn(`list via worker failed: ${(e as Error).message}`);
		}
	}
	return listDrivesFallback();
}

/** Fallback when PowerShell isn't available: probe A-Z with Node's statfs. */
async function listDrivesFallback(): Promise<DriveEntry[]> {
	if (!isWindows) {
		const u = await statfsUsage("/");
		return [{ letter: "/", root: "/", type: "local", ready: u.ok, total: u.total, free: u.free }];
	}
	const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
	const results = await Promise.all(
		letters.map(async (l) => {
			const u = await statfsUsage(`${l}:\\`, 2500);
			return u.ok
				? ({ letter: `${l}:`, root: `${l}:\\`, type: "unknown", ready: true, total: u.total, free: u.free } as DriveEntry)
				: undefined;
		}),
	);
	return results.filter((d): d is DriveEntry => !!d);
}

async function statfsUsage(p: string, timeoutMs = 4000): Promise<UsageResult> {
	let timer: NodeJS.Timeout | undefined;
	try {
		const s = await Promise.race([
			statfs(p),
			new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), timeoutMs))),
		]);
		return { ok: true, total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize), via: p };
	} catch (e) {
		return { ok: false, total: 0, free: 0, error: (e as Error).message };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// --- usage with de-duplication + short cache, so 10 keys on one drive = 1 probe -----------------

const cache = new Map<string, { at: number; value: UsageResult }>();
const inflight = new Map<string, Promise<UsageResult>>();

/**
 * Gets usage for a drive. `candidates` are tried in order (e.g. ["Z:\", "\\nas\media\"]),
 * so a mapped drive keeps working through its UNC path even if the letter goes missing.
 */
export function getUsage(candidates: string[], maxAgeMs = 2000): Promise<UsageResult> {
	const list = candidates.filter(Boolean).map(normalizeRoot);
	if (list.length === 0) return Promise.resolve({ ok: false, total: 0, free: 0, error: "no drive selected" });
	const key = list.join("|").toLowerCase();
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < maxAgeMs) return Promise.resolve(hit.value);
	const running = inflight.get(key);
	if (running) return running;

	const job = (async (): Promise<UsageResult> => {
		let result: UsageResult = { ok: false, total: 0, free: 0, error: "unavailable" };
		if (isWindows && !worker.disabled) {
			try {
				const res = await worker.request("usage", { paths: list, timeout: 4000 });
				const rows = asArray<any>(res.usage);
				const good = rows.find((r) => r.Ok);
				result = good
					? { ok: true, total: Number(good.Total), free: Number(good.Free), via: good.Path }
					: { ok: false, total: 0, free: 0, error: rows[0]?.Error ?? "unavailable" };
			} catch (e) {
				result = { ok: false, total: 0, free: 0, error: (e as Error).message };
			}
		}
		if (!result.ok && (worker.disabled || !isWindows)) {
			for (const p of list) {
				result = await statfsUsage(p);
				if (result.ok) break;
			}
		}
		cache.set(key, { at: Date.now(), value: result });
		return result;
	})().finally(() => inflight.delete(key));

	inflight.set(key, job);
	return job;
}

export function shutdownDrives(): void {
	worker.stop();
}
