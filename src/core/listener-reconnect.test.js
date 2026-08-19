import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createListenerReconnect } from "./listener-reconnect.js";

function createHarness({ autoLogin } = {}) {
    const calls = [];
    let api = { id: "initial" };
    let clearCount = 0;
    let loginCount = 0;
    const controller = createListenerReconnect({
        getApi: () => api,
        clearSession: () => {
            clearCount++;
        },
        autoLogin:
            autoLogin ||
            (async () => {
                loginCount++;
                api = { id: `account-${loginCount}` };
            }),
        attach: (nextApi) => calls.push(["attach", nextApi.id]),
        start: (nextApi) => calls.push(["start", nextApi.id]),
        onDuplicate: (...args) => calls.push(["duplicate", ...args]),
        onReconnecting: (...args) => calls.push(["reconnecting", ...args]),
        onReconnected: (...args) => calls.push(["reconnected", ...args]),
        onFailure: (...args) => calls.push(["failure", ...args]),
        reconnectDelayMs: 0,
        retryDelayMs: 0,
    });
    return { calls, controller, getState: () => ({ api, clearCount, loginCount }) };
}

describe("listener reconnect controller", () => {
    it("re-authenticates, reattaches handlers, and restarts the active listener", async () => {
        const harness = createHarness();

        await harness.controller.handleClosed(1006, "network closed");

        assert.deepEqual(harness.calls, [
            ["reconnecting", 1006, "network closed", 1],
            ["attach", "account-1"],
            ["start", "account-1"],
            ["reconnected", 1],
        ]);
        assert.deepEqual(harness.getState(), { api: { id: "account-1" }, clearCount: 1, loginCount: 1 });
        assert.equal(harness.controller.getReconnectCount(), 1);
    });

    it("handles a failed login with one immediate retry", async () => {
        let attempts = 0;
        const harness = createHarness({
            autoLogin: async () => {
                attempts++;
                if (attempts === 1) throw new Error("temporary login failure");
            },
        });

        await harness.controller.handleClosed(1006, "network closed");

        assert.equal(attempts, 2);
        assert.equal(harness.calls.filter(([type]) => type === "failure").length, 1);
        assert.deepEqual(harness.calls.at(-2), ["start", "initial"]);
        assert.deepEqual(harness.calls.at(-1), ["reconnected", 1]);
    });

    it("stops reconnect processing for duplicate sessions", async () => {
        const harness = createHarness();

        await harness.controller.handleClosed(3000, "duplicate");

        assert.deepEqual(harness.calls, [["duplicate", 3000, "duplicate"]]);
        assert.deepEqual(harness.getState(), { api: { id: "initial" }, clearCount: 0, loginCount: 0 });
    });
});
