import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LoginQRCallbackEventType } from "zca-js";
import { createClientTransport, createZaloClient, readImageMetadata } from "./zalo-client.js";

class FakeListener extends EventEmitter {
    stopCalls = 0;

    start() {}

    stop() {
        this.stopCalls++;
    }
}

function createApi(ownId) {
    return {
        listener: new FakeListener(),
        getOwnId: () => ownId,
        getContext: () => ({
            imei: `imei-${ownId}`,
            cookie: {
                toJSON: () => ({ cookies: [{ name: "zpsid", value: `cookie-${ownId}` }] }),
            },
            userAgent: "test-agent",
            language: "vi",
        }),
    };
}

function credentials() {
    return {
        imei: "imei",
        cookie: [{ name: "zpsid", value: "cookie" }],
        userAgent: "test-agent",
        language: "vi",
    };
}

describe("typed Zalo client lifecycle", () => {
    it("replaces sessions and disposes the previous listener and transport", async () => {
        const apis = [createApi("first"), createApi("second")];
        const transports = [];
        const proxies = [];
        let index = 0;
        const manager = createZaloClient({
            createClient(proxyUrl) {
                proxies.push(proxyUrl);
                const transport = {
                    closeCalls: 0,
                    close() {
                        this.closeCalls++;
                    },
                };
                transports.push(transport);
                const api = apis[index++];
                return {
                    transport,
                    client: {
                        login: async () => api,
                        loginQR: async () => api,
                    },
                };
            },
        });

        const first = await manager.loginWithCredentials(credentials(), "http://proxy-one:8080");
        assert.equal(first.ownId, "first");
        assert.equal(manager.getApi(), apis[0]);

        const second = await manager.loginWithCredentials(credentials(), "socks5://proxy-two:1080");
        assert.equal(second.ownId, "second");
        assert.equal(manager.getApi(), apis[1]);
        assert.equal(apis[0].listener.stopCalls, 1);
        assert.equal(transports[0].closeCalls, 1);
        assert.deepEqual(proxies, ["http://proxy-one:8080", "socks5://proxy-two:1080"]);

        manager.clearSession();
        assert.equal(apis[1].listener.stopCalls, 1);
        assert.equal(transports[1].closeCalls, 1);
        assert.throws(() => manager.getApi(), /Not logged in/);
    });

    it("passes typed QR options and forwards generated QR events", async () => {
        const api = createApi("qr-account");
        let receivedOptions;
        let receivedEvent;
        const manager = createZaloClient({
            createClient() {
                return {
                    transport: {},
                    client: {
                        login: async () => api,
                        loginQR: async (options, callback) => {
                            receivedOptions = options;
                            callback({
                                type: LoginQRCallbackEventType.QRCodeGenerated,
                                data: {
                                    code: "code",
                                    image: "base64",
                                    options: { enabledCheckOCR: false, enabledMultiLayer: false },
                                    token: "token",
                                },
                                actions: { saveToFile: async () => {}, retry: () => {}, abort: () => {} },
                            });
                            return api;
                        },
                    },
                };
            },
        });

        await manager.loginWithQR(null, (event) => {
            receivedEvent = event;
        });

        assert.deepEqual(receivedOptions, {});
        assert.equal(receivedEvent.data.image, "base64");
        assert.equal(manager.ownId, "qr-account");
    });

    it("serializes credentials from the active context", async () => {
        const api = createApi("saved-account");
        const manager = createZaloClient({
            createClient: () => ({
                transport: {},
                client: { login: async () => api, loginQR: async () => api },
            }),
        });

        await manager.loginWithCredentials(credentials());
        assert.deepEqual(manager.extractCredentials(), {
            imei: "imei-saved-account",
            cookie: [{ name: "zpsid", value: "cookie-saved-account" }],
            userAgent: "test-agent",
            language: "vi",
        });
    });
});

describe("Zalo image and proxy adapters", () => {
    it("reads PNG dimensions and size", async () => {
        const directory = await mkdtemp(join(tmpdir(), "zalo-client-"));
        const filePath = join(directory, "image.png");
        const image = Buffer.alloc(24);
        image.set([0x89, 0x50, 0x4e, 0x47], 0);
        image.writeUInt32BE(320, 16);
        image.writeUInt32BE(240, 20);
        await writeFile(filePath, image);

        try {
            assert.deepEqual(await readImageMetadata(filePath), { width: 320, height: 240, size: 24 });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("creates a transport covering HTTP and WebSocket proxy options", async () => {
        const transport = createClientTransport("http://user:secret@127.0.0.1:8080");
        assert.ok(transport.agent);
        assert.equal(typeof transport.polyfill, "function");
        assert.equal(typeof transport.close, "function");
        await transport.close();
    });
});
