# Drive Gauge

A Stream Deck plugin that shows free/used space for **local drives, mapped network drives, and any
UNC share** (`\\NAS\media`) — drawn as a ring, arc gauge, pie, bar, or plain text, with your own
fonts, font sizes, and colours. **Windows only.**

Built because SimpleStats sees mapped network drives but has no styling options, and Disk Health
Deck has great styling but can't see mapped drives (it reads physical disks through
LibreHardwareMonitor, and a network share isn't a physical disk).

## Features

- **Drives:** local, removable, mapped network drives (including disconnected persistent mappings),
  or a custom path / UNC share that doesn't need a drive letter at all.
- **Mapped-drive fallback:** when you pick a mapped drive, its UNC path is remembered too, so the key
  keeps working if the letter drops.
- **Styles:** ring, 270° arc gauge, pie, horizontal bar, vertical bar, text only. Adjustable
  thickness, gauge size, rounded ends.
- **Text:** any installed font, bold/normal, separate sizes for value/label/bottom line, value offset.
  Text auto-shrinks to fit.
- **Colours:** background, track, fill, value, label, bottom line, warning, alert — plus presets.
- **Low-space alerts:** warn/alert thresholds in % or GB; fill changes colour and the frame flashes
  (or stays solid).
- **Key press:** open the drive in Explorer, refresh now, or cycle used% / free% / used / free.
- A status line in the settings panel shows exactly which path is being read and what it returned.

## Requirements

- Windows 10+
- Stream Deck 6.6+ (any model with keys)
- [Node.js](https://nodejs.org/) 20+ (only for building from source)

## Install (prebuilt)

Double-click `com.dez.drivegauge.streamDeckPlugin` (from `npm run pack`, or a GitHub release).

## Build from source

```sh
git clone https://github.com/DezPoolTheSequel/drive-gauge.git
cd drive-gauge
npm install
npm run build
```

Then enable Stream Deck's developer mode (one-time) and link the plugin:

```sh
npx streamdeck dev
npx streamdeck link com.dez.drivegauge.sdPlugin
```

> If you already installed the packaged `.streamDeckPlugin`, uninstall it in Stream Deck first —
> the linked dev copy and the installed copy share the same UUID.

While editing, `npm run watch` rebuilds on save and restarts the plugin automatically.

| Script | What it does |
| --- | --- |
| `npm run build` | Bundle `src/` into `com.dez.drivegauge.sdPlugin/bin/plugin.js` |
| `npm run watch` | Rebuild on save + restart the plugin |
| `npm run typecheck` | TypeScript check |
| `npm run pack` | Build and package `dist/com.dez.drivegauge.streamDeckPlugin` |
| `npm run icons` | Regenerate the PNG icons |
| `npm run test:render` | Run the plugin against a fake Stream Deck and render sample keys to `tools/out/` |

## How it works

- `src/plugin.ts` — entry point.
- `src/drive-gauge.ts` — the key action: polling, alerts, key press, talking to the settings panel.
- `src/render.ts` — draws each key as a 144×144 SVG. Stream Deck's SVG renderer ignores
  `dominant-baseline`, so text is centred by hand.
- `src/drives.ts` — drive listing and free-space reads, with de-duplication and caching so many keys
  on one drive cost one probe.
- `com.dez.drivegauge.sdPlugin/bin/drive-worker.ps1` — a long-lived PowerShell helper that calls
  `GetLogicalDrives`, `GetDiskFreeSpaceEx`, and `WNetGetConnection`. It runs in your own Windows
  session, which is why it sees the same mapped drives you do. Every probe has a timeout, so a
  sleeping NAS can't freeze the plugin. If PowerShell can't start, the plugin falls back to Node's
  `fs.statfs`.
- `com.dez.drivegauge.sdPlugin/ui/drive.html` — the settings panel (plain HTML/JS, no framework).

## Troubleshooting

**Mapped drives don't appear:** Stream Deck is probably running as administrator. Windows hides a
user's mapped drives from elevated programs. Start Stream Deck normally, or use the custom path
option with the UNC share.

Logs: `com.dez.drivegauge.sdPlugin/logs/` (or in the installed plugin folder under
`%APPDATA%\Elgato\StreamDeck\Plugins\`).

## License

Do whatever you want with it.
