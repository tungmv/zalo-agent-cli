import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withTemporaryListener } from "./temporary-listener.js";

class FakeListener extends EventEmitter {
    constructor({ startError = null, emitErrorOnStop = false } = {}) {
        super();
        this.startError = startError;
        this.emitErrorOnStop = emitErrorOnStop;
        this.startCalls = [];
        this.stopCalls = 0;
        this.ws = null;
    }

    start(options) {
        this.startCalls.push(options);
        if (this.startError) throw this.startError;
        this.ws = { readyState: 0 };
    }

    stop() {
        this.stopCalls++;
        this.ws = null;
        if (this.emitErrorOnStop) {
            setImmediate(() => this.emit("error", new Error("queued shutdown frame")));
        }
    }

    connect() {
        this.ws = { readyState: 1 };
        this.emit("connected");
    }
}

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

function assertHandlersRemoved(listener) {
    assert.equal(listener.listenerCount("connected"), 0);
    assert.ok(listener.listenerCount("error") <= 1);
    assert.equal(listener.listenerCount("closed"), 0);
}

describe("withTemporaryListener", () => {
    it("starts with retry disabled and waits for connected", async () => {
        const listener = new FakeListener();
        let called = false;
        const resultPromise = withTemporaryListener(listener, async () => {
            called = true;
            return "sent";
        });

        assert.deepEqual(listener.startCalls, [{ retryOnClose: false }]);
        assert.equal(called, false);
        listener.connect();

        assert.equal(await resultPromise, "sent");
        assert.equal(called, true);
        assert.equal(listener.stopCalls, 1);
        assertHandlersRemoved(listener);
    });

    it("handles queued errors during listener shutdown", async () => {
        const listener = new FakeListener({ emitErrorOnStop: true });
        const resultPromise = withTemporaryListener(listener, async () => "sent");
        listener.connect();

        assert.equal(await resultPromise, "sent");
        await flush();
        assert.equal(listener.stopCalls, 1);
        assert.equal(listener.listenerCount("error"), 1);
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        assertHandlersRemoved(listener);
    });

    it("cleans up after an operation failure", async () => {
        const listener = new FakeListener();
        const resultPromise = withTemporaryListener(listener, async () => {
            throw new Error("upload failed");
        });
        listener.connect();

        await assert.rejects(resultPromise, /upload failed/);
        assert.equal(listener.stopCalls, 1);
        assertHandlersRemoved(listener);
    });

    it("rejects when connection times out", async () => {
        const listener = new FakeListener();
        const resultPromise = withTemporaryListener(listener, async () => "sent", { connectTimeoutMs: 10 });

        await assert.rejects(resultPromise, /connection timed out after 10ms/);
        assert.equal(listener.stopCalls, 1);
        assertHandlersRemoved(listener);
    });

    it("rejects on a listener error before connection", async () => {
        const listener = new FakeListener();
        const resultPromise = withTemporaryListener(listener, async () => "sent", { connectTimeoutMs: 100 });
        listener.emit("error", new Error("socket failed"));

        await assert.rejects(resultPromise, /socket failed/);
        assert.equal(listener.stopCalls, 1);
        assertHandlersRemoved(listener);
    });

    it("rejects when the listener closes before connection", async () => {
        const listener = new FakeListener();
        const resultPromise = withTemporaryListener(listener, async () => "sent", { connectTimeoutMs: 100 });
        listener.emit("closed", 3000, "duplicate connection");

        await assert.rejects(resultPromise, /closed \(code 3000: duplicate connection\)/);
        assert.equal(listener.stopCalls, 1);
        assertHandlersRemoved(listener);
    });

    it("rejects when the listener fails during the operation", async () => {
        const listener = new FakeListener();
        let release;
        const resultPromise = withTemporaryListener(
            listener,
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        listener.connect();
        await flush();
        listener.emit("error", new Error("connection lost"));
        release();

        await assert.rejects(resultPromise, /connection lost/);
        assert.equal(listener.stopCalls, 1);
        assertHandlersRemoved(listener);
    });

    it("rejects when the listener closes during the operation", async () => {
        const listener = new FakeListener();
        let release;
        const resultPromise = withTemporaryListener(
            listener,
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        listener.connect();
        await flush();
        listener.emit("closed", 1006, "network failure");
        release();

        await assert.rejects(resultPromise, /closed \(code 1006: network failure\)/);
        assert.equal(listener.stopCalls, 1);
        assertHandlersRemoved(listener);
    });

    it("does not stop a listener that was already running", async () => {
        const listener = new FakeListener();
        listener.ws = { readyState: 1 };

        const result = await withTemporaryListener(listener, async () => "sent");

        assert.equal(result, "sent");
        assert.deepEqual(listener.startCalls, []);
        assert.equal(listener.stopCalls, 0);
        assertHandlersRemoved(listener);
    });

    it("does not stop when start fails synchronously", async () => {
        const listener = new FakeListener({ startError: new Error("already started") });

        await assert.rejects(
            withTemporaryListener(listener, async () => "sent"),
            /already started/,
        );
        assert.equal(listener.stopCalls, 0);
        assertHandlersRemoved(listener);
    });
});
