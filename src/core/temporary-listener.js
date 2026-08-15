/**
 * Run a one-shot operation that needs the Zalo WebSocket listener.
 *
 * File uploads in zca-js wait for a file_done event from the listener. This
 * helper starts a listener only when needed and cleans up only what it owns.
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const OPEN_READY_STATE = 1;

function assertListener(listener) {
    if (!listener || typeof listener.on !== "function" || typeof listener.removeListener !== "function") {
        throw new TypeError("Invalid Zalo listener: event methods are required");
    }
    if (typeof listener.start !== "function" || typeof listener.stop !== "function") {
        throw new TypeError("Invalid Zalo listener: start() and stop() are required");
    }
}

function asError(error, fallback = "Zalo listener error") {
    if (error instanceof Error) return error;
    if (error?.message) return new Error(error.message);
    return new Error(fallback);
}

function closedError(code, reason) {
    const details = [code === undefined ? null : `code ${code}`, reason || null].filter(Boolean).join(": ");
    return new Error(`Zalo listener closed${details ? ` (${details})` : ""}`);
}

function isStarted(listener) {
    return Boolean(listener.ws);
}

function isOpen(listener) {
    return listener.ws?.readyState === OPEN_READY_STATE;
}

/**
 * Start a temporary listener when necessary and run an async operation once it
 * is connected. A listener that was already running is reused and left alone.
 *
 * @param {object} listener - zca-js listener instance
 * @param {() => Promise<unknown>} operation - Operation that needs the listener
 * @param {object} [options]
 * @param {number} [options.connectTimeoutMs=10000] - Connection timeout
 * @returns {Promise<unknown>} The operation result
 */
export async function withTemporaryListener(
    listener,
    operation,
    { connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {},
) {
    assertListener(listener);
    if (typeof operation !== "function") {
        throw new TypeError("Listener operation must be a function");
    }

    const ownsListener = !isStarted(listener);
    let connected = isOpen(listener);
    let resolveConnected;
    let rejectConnected;
    let rejectFailure;
    let connectionTimer;

    const connectedPromise = new Promise((resolve, reject) => {
        resolveConnected = resolve;
        rejectConnected = reject;
    });
    const listenerFailure = new Promise((_, reject) => {
        rejectFailure = reject;
    });
    listenerFailure.catch(() => {});

    const onConnected = () => {
        connected = true;
        resolveConnected();
    };
    const onError = (error) => {
        const normalized = asError(error);
        if (connected) rejectFailure(normalized);
        else rejectConnected(normalized);
    };
    const onClosed = (code, reason) => {
        const error = closedError(code, reason);
        if (connected) rejectFailure(error);
        else rejectConnected(error);
    };

    listener.on("connected", onConnected);
    listener.on("error", onError);
    listener.on("closed", onClosed);

    let startedByUs = false;
    try {
        if (ownsListener) {
            listener.start({ retryOnClose: false });
            startedByUs = true;
        }

        if (!connected) {
            if (Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0) {
                connectionTimer = setTimeout(
                    () => rejectConnected(new Error(`Zalo listener connection timed out after ${connectTimeoutMs}ms`)),
                    connectTimeoutMs,
                );
            }
            await connectedPromise;
        }

        return await Promise.race([Promise.resolve().then(operation), listenerFailure]);
    } finally {
        if (connectionTimer) clearTimeout(connectionTimer);
        listener.removeListener("connected", onConnected);
        listener.removeListener("error", onError);
        listener.removeListener("closed", onClosed);

        if (startedByUs) {
            // zca-js can deliver a queued WebSocket frame after stop() resets
            // its cipher key. Keep teardown errors handled for one turn.
            const ignoreShutdownError = () => {};
            listener.on("error", ignoreShutdownError);
            try {
                listener.stop();
            } catch {
                // Preserve the operation or connection error, if any.
            }
            const cleanupTimer = setTimeout(() => listener.removeListener("error", ignoreShutdownError), 1_000);
            cleanupTimer.unref?.();
        }
    }
}
