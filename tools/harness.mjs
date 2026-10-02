// Fake Stream Deck app: launches the plugin, sends events, captures rendered keys.
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const port = 28123;
const wss = new WebSocketServer({ port });
const images = [];
const toPI = [];
let sock;
const send = (o) => sock.send(JSON.stringify(o));
const ACTION = "com.dez.drivegauge.drive";

const scenarios = [
  ["ring-used", { source: "custom", customPath: "/", label: "NAS", style: "ring" }],
  ["arc-free-size", { source: "custom", customPath: "/", label: "Z:", style: "arc", metric: "free", value: "size", sub: "freeTotal", fillColor: "#36A3FF" }],
  ["pie", { source: "custom", customPath: "/", label: "Media", style: "pie", fontFamily: "DejaVu Sans" }],
  ["bar", { source: "custom", customPath: "/", label: "X:", style: "bar", metric: "free", value: "size", sub: "free", bgColor: "#16070F", trackColor: "#3A1426", fillColor: "#FF3D7F" }],
  ["vbar", { source: "custom", customPath: "/", label: "D:", style: "vbar", thickness: 16, valueSize: 26 }],
  ["text", { source: "custom", customPath: "/", label: "Games", style: "text", metric: "free", value: "size", valueSize: 34 }],
  ["alert", { source: "custom", customPath: "/", label: "C:", style: "ring", thresholdUnit: "percent", alertBelow: 99, frame: "solid" }],
  ["offline", { source: "drive", drive: "Q:", unc: "\\\\nas\\gone", style: "ring" }],
];

wss.on("connection", (ws) => {
  sock = ws;
  ws.on("message", async (raw) => {
    const m = JSON.parse(raw);
    if (m.event === "registerPlugin") {
      // run scenarios sequentially on one key
      let i = 0;
      const next = () => {
        if (i >= scenarios.length) return finish();
        const [name, settings] = scenarios[i++];
        current = name;
        const evt = i === 1 ? "willAppear" : "didReceiveSettings";
        send({ action: ACTION, event: evt, context: "ctx1", device: "dev1",
          payload: { controller: "Keypad", coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings } });
        setTimeout(next, 1500);
      };
      setTimeout(next, 300);
      // PI flow
      setTimeout(() => {
        send({ action: ACTION, event: "propertyInspectorDidAppear", context: "ctx1", device: "dev1" });
        send({ action: ACTION, event: "sendToPlugin", context: "ctx1", payload: { cmd: "listDrives" } });
        send({ action: ACTION, event: "sendToPlugin", context: "ctx1", payload: { cmd: "refresh" } });
      }, 600);
    } else if (m.event === "setImage") {
      images.push([current, m.payload.image]);
    } else if (m.event === "sendToPropertyInspector") {
      toPI.push(m.payload);
    } else if (m.event === "logMessage") {
      // console.log("LOG", m.payload.message);
    }
  });
});
let current = "";

const info = { application: { font: "x", language: "en", platform: "windows", platformVersion: "10", version: "6.9.0.0" },
  plugin: { uuid: "com.dez.drivegauge", version: "1.0.0.0" }, devicePixelRatio: 2,
  colors: {}, devices: [{ id: "dev1", name: "SD", size: { columns: 8, rows: 4 }, type: 7 }] };

const child = spawn(process.execPath, ["bin/plugin.js", "-port", String(port), "-pluginUUID", "u1", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)],
  { cwd: "com.dez.drivegauge.sdPlugin", stdio: "inherit" });

function finish() {
  fs.mkdirSync("tools/out", { recursive: true });
  const last = {};
  for (const [name, img] of images) last[name] = img;
  for (const [name, img] of Object.entries(last)) {
    const svg = decodeURIComponent(img.replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
    fs.writeFileSync(`tools/out/${name}.svg`, svg);
    fs.writeFileSync(`tools/out/${name}.png`, new Resvg(svg, { fitTo: { mode: "width", value: 144 }, font: { loadSystemFonts: true } }).render().asPng());
  }
  console.log("images:", Object.keys(last).join(", "));
  console.log("PI msgs:", JSON.stringify(toPI).slice(0, 600));
  child.kill(); wss.close(); process.exit(0);
}
