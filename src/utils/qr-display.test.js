/**
 * Tests for QR display utility — JSON mode structured output for AI agents.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { displayQR, getQRPath } from "./qr-display.js";
import { existsSync, unlinkSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import QRCode from "qrcode";

// Tiny valid 1x1 white PNG as base64 (for testing without real QR)
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const LOGIN_CODE = "test-zalo-login-code";
const LOGIN_TOKEN = "zaloqr:v2_test-token";
const LOGIN_URL = `http://zaloapp.com/qr/l?tk=${LOGIN_TOKEN}`;

describe("displayQR", () => {
    let originalLog;
    let captured;

    beforeEach(() => {
        // Capture console.log output
        originalLog = console.log;
        captured = [];
        console.log = (...args) => captured.push(args.join(" "));

        // Ensure config dir exists for file save
        const qrDir = dirname(getQRPath());
        mkdirSync(qrDir, { recursive: true });
    });

    afterEach(() => {
        console.log = originalLog;
        delete process.env.ZALO_JSON_MODE;

        // Clean up saved QR file
        try {
            unlinkSync(getQRPath());
        } catch {}
    });

    it("JSON mode outputs structured event with all fields", async () => {
        process.env.ZALO_JSON_MODE = "1";
        await displayQR({ data: { image: TINY_PNG_B64 } });

        assert.equal(captured.length, 1, "should output exactly one JSON line");
        const parsed = JSON.parse(captured[0]);
        assert.equal(parsed.event, "qr");
        assert.equal(parsed.image, TINY_PNG_B64);
        assert.ok(parsed.file.endsWith("qr.png"), "file path should end with qr.png");
        assert.ok(parsed.dataUrl.startsWith("data:image/png;base64,"), "dataUrl should be a data URL");
        assert.ok(parsed.dataUrl.includes(TINY_PNG_B64), "dataUrl should contain full base64");
    });

    it("JSON mode does not output terminal escape sequences", async () => {
        process.env.ZALO_JSON_MODE = "1";

        // Also capture stdout.write
        const stdoutWrites = [];
        const originalWrite = process.stdout.write;
        process.stdout.write = (data) => stdoutWrites.push(data);

        await displayQR({ data: { image: TINY_PNG_B64 } });

        process.stdout.write = originalWrite;

        // No iTerm2 escape sequences
        const hasEscape = stdoutWrites.some((w) => typeof w === "string" && w.includes("\x1b]1337"));
        assert.ok(!hasEscape, "JSON mode should not output terminal escape sequences");
    });

    it("saves QR PNG file in both modes", async () => {
        process.env.ZALO_JSON_MODE = "1";
        await displayQR({ data: { image: TINY_PNG_B64 } });
        assert.ok(existsSync(getQRPath()), "QR PNG should be saved to disk");
    });

    it("handles empty image gracefully in JSON mode", async () => {
        process.env.ZALO_JSON_MODE = "1";
        await displayQR({ data: {} });
        assert.equal(captured.length, 0, "should not output anything for empty image");
    });

    it("human mode renders the same token URL as the saved PNG", async () => {
        const imageDataUrl = await QRCode.toDataURL(LOGIN_URL);
        const imageB64 = imageDataUrl.replace(/^data:image\/png;base64,/, "");
        const expectedTerminalQR = await QRCode.toString(LOGIN_URL, { type: "terminal", small: true });

        await displayQR({ data: { code: LOGIN_CODE, token: LOGIN_TOKEN, image: imageB64 } });

        assert.equal(captured[0], expectedTerminalQR, "terminal QR should encode the token URL");
        assert.equal(readFileSync(getQRPath()).toString("base64"), imageB64, "PNG should preserve the server image");
        const output = captured.join("\n");
        assert.match(output, /\u001b\[47m/, "should use node-qrcode terminal rendering");
        assert.match(output, /QR Scanner/, "should tell the user how to scan");
        assert.doesNotMatch(output, /data:image\/png;base64,/, "human output should not dump image base64");
    });
});
