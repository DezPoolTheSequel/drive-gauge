import streamDeck from "@elgato/streamdeck";
import { DriveGauge } from "./drive-gauge.js";
import { shutdownDrives } from "./drives.js";

streamDeck.logger.setLevel("info");
// Works on Stream Deck 6.x and 7.x (we never call getSettings, so behaviour is identical).
streamDeck.settings.useLegacySettingsBehavior = true;
streamDeck.actions.registerAction(new DriveGauge());
streamDeck.connect();

for (const sig of ["SIGINT", "SIGTERM", "exit"] as const) process.on(sig, () => shutdownDrives());
