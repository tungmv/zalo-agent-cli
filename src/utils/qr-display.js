/**
 * Cross-platform QR display utility.
 * Displays Zalo's login QR directly in the terminal and saves the server PNG to file.
 * Uses node-qrcode's terminal renderer with the same token URL as Zalo's PNG.
 *
 * Display methods:
 * 1. iTerm2/Kitty/WezTerm inline image (renders PNG directly in terminal)
 * 2. Save PNG to config dir
 * 3. Base64 data URL (for IDE/agent preview)
 * 4. File path with platform-specific open hint
 */

import { resolve } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { platform } from "os";
import QRCode from "qrcode";
import { CONFIG_DIR } from "../core/credentials.js";
import { info } from "./output.js";

const QR_PATH = resolve(CONFIG_DIR, "qr.png");
const QR_LOGIN_URL_PREFIX = "http://zaloapp.com/qr/l?tk=";

/** Get platform-specific command to open a file. */
function getOpenCommand() {
    switch (platform()) {
        case "darwin":
            return "open";
        case "win32":
            return "start";
        default:
            return "xdg-open";
    }
}

/**
 * Display QR code from a zca-js login QR event.
 * Async — safe to call from zca-js callback; rendering is performed by node-qrcode.
 * In JSON mode (--json), outputs structured event for AI agents.
 * @param {object} event - zca-js QR callback event
 */
export async function displayQR(event) {
    const imageB64 = event.data?.image || "";
    const jsonMode = process.env.ZALO_JSON_MODE === "1";

    // Always save PNG to config dir (needed by HTTP server and agents)
    if (imageB64) {
        try {
            mkdirSync(CONFIG_DIR, { recursive: true });
            writeFileSync(QR_PATH, Buffer.from(imageB64, "base64"));
        } catch {}
    }

    // Also fire-and-forget the zca-js built-in save
    if (event.actions?.saveToFile) {
        event.actions.saveToFile(QR_PATH).catch(() => {});
    }

    // JSON mode: structured output for AI agents — no terminal escapes, no noise
    if (jsonMode) {
        if (imageB64) {
            console.log(
                JSON.stringify({
                    event: "qr",
                    image: imageB64,
                    file: QR_PATH,
                    dataUrl: `data:image/png;base64,${imageB64}`,
                }),
            );
        }
        return;
    }

    // Zalo's PNG encodes the token URL; data.code is only the polling code.
    const qrCode = event.data?.token ? `${QR_LOGIN_URL_PREFIX}${event.data.token}` : "";
    if (qrCode) {
        try {
            const terminalQR = await QRCode.toString(qrCode, { type: "terminal", small: true });
            console.log(terminalQR);
        } catch (error) {
            info(`Could not render QR in terminal: ${error.message}`);
        }
    } else if (imageB64) {
        // Keep the image fallback when an event does not include the token.
        const b64ForTerm = Buffer.from(imageB64, "base64").toString("base64");
        process.stdout.write(`\x1b]1337;File=inline=1;width=30;preserveAspectRatio=1:${b64ForTerm}\x07\n`);
    }

    if (imageB64) {
        const openCmd = getOpenCommand();
        info(`QR image saved: ${QR_PATH}`);
        info(`To open: ${openCmd} "${QR_PATH}"`);
        info("Scan the QR code above with Zalo > QR Scanner.");
    }
}

/** Get the QR image path. */
export function getQRPath() {
    return QR_PATH;
}
