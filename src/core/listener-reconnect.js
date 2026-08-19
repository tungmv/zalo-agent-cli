const DEFAULT_RECONNECT_DELAY_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DUPLICATE_CONNECTION_CODE = 3000;

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Share the session replacement algorithm between the CLI listener and MCP.
 * Event-specific handlers stay with each command; this controller owns only
 * re-login, attachment, restart, and retry sequencing.
 */
export function createListenerReconnect({
    getApi,
    clearSession,
    autoLogin,
    attach,
    start,
    onDuplicate,
    onReconnecting,
    onReconnected,
    onFailure,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
    let reconnectCount = 0;
    let reconnecting = false;

    async function reconnect(code, reason) {
        if (reconnecting) return;
        reconnecting = true;

        if (code === DUPLICATE_CONNECTION_CODE) {
            try {
                await onDuplicate?.(code, reason);
            } finally {
                reconnecting = false;
            }
            return;
        }

        reconnectCount++;
        onReconnecting?.(code, reason, reconnectCount);
        await wait(reconnectDelayMs);

        try {
            clearSession();
            await autoLogin(false);
            const api = getApi();
            attach(api);
            start(api);
            onReconnected?.(reconnectCount);
            reconnecting = false;
        } catch (error) {
            onFailure?.(error, reconnectCount);
            await wait(retryDelayMs);
            try {
                clearSession();
                await autoLogin(false);
                const api = getApi();
                attach(api);
                start(api);
                onReconnected?.(reconnectCount);
                reconnecting = false;
            } catch (retryError) {
                reconnecting = false;
                onFailure?.(retryError, reconnectCount, true);
            }
        }
    }

    return {
        handleClosed: reconnect,
        getReconnectCount: () => reconnectCount,
    };
}
