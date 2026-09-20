/**
 * IPC harness for behavioral tests that need to exercise the full
 * `registerIpcHandlers()` glue from `src/main/ipc/`.
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
 * Kept as the explicit marker at the top of a test file that this harness is
 * what supplies `electron`. The mock itself is registered below, at module top
 * level: vitest hoists `vi.mock` there regardless, and since v5 it refuses to
 * run one written inside a function. Importing this module is what installs
 * it — which is safe because, unlike `music-metadata-mock`, nothing
 * re-exports this from `harness/index.ts`, so it is only ever pulled in by a
 * test that wants it.
 */
export function installElectronMock(): void {
  /* no-op; see above */
}

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

  // Register a host on the *fresh* module graph resetModules just created, and
  // do it before importing the IPC modules — the database path is read the
  // first time a handler touches the library. The paths mirror the `app.getPath`
  // mock above (`${appPathRoot}/${name}`), which is what these tests have
  // always resolved to. Without this the host auto-detects, and because
  // `vi.mock("electron")` cannot intercept a CommonJS `require`, it would
  // resolve the real user-data directory instead of this temp one.
  const hostModule = await import("../../main/host");
  hostModule.setHost({
    kind: "node",
    platform: process.platform,
    paths: {
      userData: () => `${appPathRoot}/userData`,
      temp: () => `${appPathRoot}/temp`,
      music: () => `${appPathRoot}/music`,
      isPackaged: () => false,
      version: () => "0.0.0-test",
    },
    secrets: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, "utf-8"),
      decryptString: (b: Buffer) => b.toString("utf-8"),
    },
    shell: {
      openExternal: async () => ({ opened: true }),
    },
    dialogs: {
      available: true,
      pickFolder: async () => null,
      saveFile: async () => null,
    },
  });

  // Handlers register with the transport-neutral bridge rather than ipcMain, so
  // capture them from that registry — same module graph resetModules just made.
  // The ipcMain mock above stays for anything that still pokes at it directly.
  const bridgeModule = await import("../../main/host/bridge");
  bridgeModule.resetBridge();
  bridgeModule.onHandlerRegistered((channel, fn) => {
    capturedHandlers.set(channel, fn as (e: unknown, ...a: unknown[]) => Promise<unknown>);
  });

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
