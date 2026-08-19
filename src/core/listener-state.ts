export type ListenerLike = {
    on: (event: string, handler: (...args: any[]) => unknown) => unknown;
    removeListener: (event: string, handler: (...args: any[]) => unknown) => unknown;
    start: (options?: { retryOnClose?: boolean }) => void;
    stop: () => void;
};

type RuntimeListener = ListenerLike & {
    ws?: { readyState: number } | null;
};

export function isListenerStarted(listener: ListenerLike): boolean {
    return Boolean((listener as RuntimeListener).ws);
}

export function isListenerOpen(listener: ListenerLike): boolean {
    return (listener as RuntimeListener).ws?.readyState === 1;
}
