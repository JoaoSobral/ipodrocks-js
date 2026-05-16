/**
 * IPC harness for behavioral tests that need to exercise the full
 * `registerIpcHandlers()` glue from `src/main/ipc.ts`.
 *
 * Usage:
 *   import { installElectronMock, setupIpcSession } from "./ipc-harness";
 *
 *   installElectronMock();   // call at module scope BEFORE any app import
 *
 *   // inside a test:
 *   const session = await setupIpcSession({ userDataDir: tmp });
 *   const result = await session.invoke("sync:start", opts);
 *   session.cleanup();
 *
 * The harness mocks Electron's `app`, `ipcMain`, `BrowserWindow`, `dialog`,
 * `shell`, `net`, and `protocol` modules. Handlers registered via
 * `ipcMain.handle` are captured and exposed through `invoke()`.
 */
import { vi } from "vitest";

const capturedHandlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => Promise<unknown>
>();
const sentRendererEvents: Array<{ channel: string; payload: unknown }> = [];

let appPathRoot = "/tmp/ipodrocks-test";

/**
 * Installs the `vi.mock("electron")` stub. Call this at module scope in your
 * test file BEFORE any `import` of app code that transitively pulls electron.
 */
export function installElectronMock(): void {
  vi.mock("electron", () => {
    const fakeSender = {
      send: (channel: string, payload: unknown) => {
        sentRendererEvents.push({ channel, payload });
      },
      isDestroyed: () => false,
    };

    return {
      app: {
        getPath: (name: string) => `${appPathRoot}/${name}`,
        getAppPath: () => appPathRoot,
        getName: () => "ipodrocks-test",
        getVersion: () => "0.0.0-test",
        on: vi.fn(),
        whenReady: () => Promise.resolve(),
        quit: vi.fn(),
      },
      BrowserWindow: class FakeBrowserWindow {
        webContents = fakeSender;
        static getAllWindows() {
          return [];
        }
        static getFocusedWindow() {
          return null;
        }
      },
      ipcMain: {
        handle: (
          channel: string,
          fn: (event: unknown, ...args: unknown[]) => Promise<unknown>
        ) => {
          capturedHandlers.set(channel, fn);
        },
        on: vi.fn(),
        removeHandler: (channel: string) => {
          capturedHandlers.delete(channel);
        },
      },
      dialog: {
        showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
        showSaveDialog: vi.fn().mockResolvedValue({ canceled: true, filePath: undefined }),
        showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
      },
      shell: {
        openPath: vi.fn().mockResolvedValue(""),
        openExternal: vi.fn().mockResolvedValue(undefined),
        showItemInFolder: vi.fn(),
      },
      net: {
        fetch: vi.fn(),
      },
      protocol: {
        registerSchemesAsPrivileged: vi.fn(),
        handle: vi.fn(),
      },
    };
  });
}

export interface IpcSession {
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>;
  sentEvents: Array<{ channel: string; payload: unknown }>;
  cleanup: () => void;
}

export interface IpcSessionOptions {
  /** Tmp directory used as `app.getPath("userData")` root. */
  userDataDir: string;
}

/**
 * Registers all IPC handlers using fresh module state and returns an
 * `invoke()` callable. Each call creates a new ipc.ts module instance via
 * `vi.resetModules()` so previous singletons (Library, DevicesCore) don't
 * leak across tests.
 */
export async function setupIpcSession(opts: IpcSessionOptions): Promise<IpcSession> {
  appPathRoot = opts.userDataDir;
  capturedHandlers.clear();
  sentRendererEvents.length = 0;
  vi.resetModules();

  const ipcModule = await import("../../main/ipc");
  ipcModule.registerIpcHandlers();

  const fakeEvent = {
    sender: {
      send: (channel: string, payload: unknown) => {
        sentRendererEvents.push({ channel, payload });
      },
      isDestroyed: () => false,
    },
  };

  return {
    invoke: async <T = unknown>(channel: string, ...args: unknown[]) => {
      const handler = capturedHandlers.get(channel);
      if (!handler) {
        throw new Error(`IPC channel "${channel}" not registered`);
      }
      return (await handler(fakeEvent, ...args)) as T;
    },
    sentEvents: sentRendererEvents,
    cleanup: () => {
      capturedHandlers.clear();
      sentRendererEvents.length = 0;
    },
  };
}
