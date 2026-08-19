import fs from "node:fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import {
    LoginQRCallbackEventType,
    Zalo,
    type API,
    type ContextSession,
    type Credentials,
    type ImageMetadataGetter,
    type LoginQRCallback,
    type LoginQRCallbackEvent,
    type Options,
} from "zca-js";
import { getActive } from "./accounts.js";
import { loadCredentials } from "./credentials.js";
import { info } from "../utils/output.js";

export type Session = {
    api: API;
    ownId: string;
    proxyUrl: string | null;
    transport: ClientTransport;
};

type ZaloClient = Pick<Zalo, "login" | "loginQR">;

type ClientTransport = {
    agent?: InstanceType<typeof HttpsProxyAgent>;
    polyfill?: typeof fetch;
    close?: () => void | Promise<void>;
};

type ClientFactory = (
    proxyUrl: string | null,
    logging: boolean,
) => {
    client: ZaloClient;
    transport: ClientTransport;
};

export type ZaloClientDependencies = {
    createClient?: ClientFactory;
};

export const readImageMetadata: ImageMetadataGetter = async (filePath) => {
    const stat = await fs.promises.stat(filePath);
    const buf = Buffer.alloc(32);
    const file = await fs.promises.open(filePath, "r");
    try {
        await file.read(buf, 0, buf.length, 0);
    } finally {
        await file.close();
    }

    let width = 0;
    let height = 0;

    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        width = buf.readUInt32BE(16);
        height = buf.readUInt32BE(20);
    } else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
        width = buf.readUInt16LE(6);
        height = buf.readUInt16LE(8);
    } else if (buf[0] === 0xff && buf[1] === 0xd8) {
        const jpegFile = await fs.promises.open(filePath, "r");
        try {
            const segment = Buffer.alloc(9);
            let position = 2;
            while (position < stat.size - 9) {
                const { bytesRead } = await jpegFile.read(segment, 0, 4, position);
                if (bytesRead < 4 || segment[0] !== 0xff) break;

                const marker = segment[1];
                const isStartOfFrame =
                    (marker >= 0xc0 && marker <= 0xc3) ||
                    (marker >= 0xc5 && marker <= 0xc7) ||
                    (marker >= 0xc9 && marker <= 0xcb) ||
                    (marker >= 0xcd && marker <= 0xcf);
                if (isStartOfFrame) {
                    await jpegFile.read(segment, 0, 7, position + 2);
                    height = segment.readUInt16BE(3);
                    width = segment.readUInt16BE(5);
                    break;
                }

                position += 2 + segment.readUInt16BE(2);
            }
        } finally {
            await jpegFile.close();
        }
    }

    if (width === 0 || height === 0) return null;
    return { width, height, size: stat.size };
};

export function createProxyFetch(proxyUrl: string): typeof fetch {
    const dispatcher = new ProxyAgent(proxyUrl);
    return (input, init) => fetch(input, { ...init, dispatcher } as RequestInit);
}

export function createClientTransport(proxyUrl: string | null): ClientTransport {
    if (!proxyUrl) return {};

    const agent = new HttpsProxyAgent(proxyUrl);
    const dispatcher = new ProxyAgent(proxyUrl);
    return {
        agent,
        polyfill: (input, init) => fetch(input, { ...init, dispatcher } as RequestInit),
        close: () => dispatcher.close(),
    };
}

function defaultClientFactory(proxyUrl: string | null, logging: boolean) {
    const transport = createClientTransport(proxyUrl);
    const options: Partial<Options> = {
        logging,
        imageMetadataGetter: readImageMetadata,
        ...transport,
    };
    return { client: new Zalo(options), transport };
}

class ZaloConnectionManager {
    private current: Session | null = null;
    private generation = 0;
    private readonly createClient: ClientFactory;

    constructor({ createClient = defaultClientFactory }: ZaloClientDependencies = {}) {
        this.createClient = createClient;
    }

    get api(): API | null {
        return this.current?.api || null;
    }

    get ownId(): string | null {
        return this.current?.ownId || null;
    }

    get sessionGeneration(): number {
        return this.generation;
    }

    getApi(): API {
        if (!this.current) throw new Error("Not logged in. Run: zalo-agent login");
        return this.current.api;
    }

    async loginWithCredentials(credentials: Credentials, proxyUrl: string | null = null) {
        const logging = !process.env.ZALO_JSON_MODE;
        const { client, transport } = this.createClient(proxyUrl, logging);
        try {
            const api = await client.login(credentials);
            const ownId = api.getOwnId();
            this.replaceSession({ api, ownId, proxyUrl, transport });
            return { api, ownId };
        } catch (error) {
            await transport.close?.();
            throw error;
        }
    }

    async loginWithQR(
        proxyUrl: string | null = null,
        onQrGenerated:
            | ((event: Extract<LoginQRCallbackEvent, { type: LoginQRCallbackEventType.QRCodeGenerated }>) => void)
            | null = null,
    ) {
        const logging = !process.env.ZALO_JSON_MODE;
        const { client, transport } = this.createClient(proxyUrl, logging);
        const callback: LoginQRCallback = (event) => {
            if (event.type === LoginQRCallbackEventType.QRCodeGenerated && onQrGenerated) onQrGenerated(event);
        };

        try {
            const api = await client.loginQR({}, callback);
            const ownId = api.getOwnId();
            this.replaceSession({ api, ownId, proxyUrl, transport });
            return { api, ownId };
        } catch (error) {
            await transport.close?.();
            throw error;
        }
    }

    extractCredentials(): Credentials {
        const context = this.getApi().getContext() as ContextSession;
        return {
            imei: context.imei,
            cookie: context.cookie!.toJSON()!.cookies,
            userAgent: context.userAgent,
            language: context.language,
        };
    }

    async autoLogin(jsonMode = false) {
        if (this.current) return;

        const active = getActive();
        if (!active) return;

        const credentials = loadCredentials(active.ownId) as Credentials | null;
        if (!credentials) return;

        try {
            await this.loginWithCredentials(credentials, active.proxy || null);
            if (!jsonMode) info(`Auto-login: ${active.name || active.ownId}`);
        } catch {
            // Login is best-effort during command preflight.
        }
    }

    clearSession() {
        const previous = this.current;
        this.current = null;
        this.generation += 1;
        this.dispose(previous);
    }

    private replaceSession(session: Session) {
        const previous = this.current;
        this.current = session;
        this.generation += 1;
        this.dispose(previous);
    }

    private dispose(session: Session | null) {
        if (!session) return;
        try {
            session.api.listener.stop();
        } catch {
            // The listener may already be closed.
        }
        void session.transport.close?.();
    }
}

const manager = new ZaloConnectionManager({
    createClient: (proxyUrl, logging) => defaultClientFactory(proxyUrl, logging),
});

export function getApi(): API {
    return manager.getApi();
}

export function getOwnId(): string | null {
    return manager.ownId;
}

export function isLoggedIn(): boolean {
    return manager.api !== null;
}

export function clearSession(): void {
    manager.clearSession();
}

export function loginWithCredentials(credentials: Credentials, proxyUrl: string | null = null) {
    return manager.loginWithCredentials(credentials, proxyUrl);
}

export function loginWithQR(
    proxyUrl: string | null = null,
    onQrGenerated:
        | ((event: Extract<LoginQRCallbackEvent, { type: LoginQRCallbackEventType.QRCodeGenerated }>) => void)
        | null = null,
) {
    return manager.loginWithQR(proxyUrl, onQrGenerated);
}

export function extractCredentials(): Credentials {
    return manager.extractCredentials();
}

export function autoLogin(jsonMode = false) {
    return manager.autoLogin(jsonMode);
}

export function createZaloClient(dependencies: ZaloClientDependencies = {}) {
    return new ZaloConnectionManager(dependencies);
}
