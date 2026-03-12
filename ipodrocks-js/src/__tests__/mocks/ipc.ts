/**
 * IPC mock for renderer component tests.
 * Stubs window.api.invoke and window.api.on.
 */

const invokeHandlers: Record<string, (...args: unknown[]) => unknown> = {};
const onHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

export function mockIpcInvoke(channel: string, handler: (...args: unknown[]) => unknown): void {
  invokeHandlers[channel] = handler;
}

export function mockIpcOn(channel: string, handler: (...args: unknown[]) => void): void {
  if (!onHandlers[channel]) onHandlers[channel] = [];
  onHandlers[channel].push(handler);
}

export function setupIpcMocks(): void {
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = invokeHandlers[channel];
    if (handler) return handler(...args);
    return undefined;
  };

  const on = (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
    if (!onHandlers[channel]) onHandlers[channel] = [];
    onHandlers[channel].push(callback);
    return () => {
      onHandlers[channel] = onHandlers[channel].filter((h) => h !== callback);
    };
  };

  const send = (): void => {};

  (globalThis as unknown as { window: { api: unknown } }).window = {
    api: { invoke, on, send },
  };
}

export function resetIpcMocks(): void {
  for (const key of Object.keys(invokeHandlers)) delete invokeHandlers[key];
  for (const key of Object.keys(onHandlers)) delete onHandlers[key];
}
