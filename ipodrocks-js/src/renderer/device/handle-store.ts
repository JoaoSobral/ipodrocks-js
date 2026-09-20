/**
 * Remembering which folder is which device, across tab closes.
 *
 * `showDirectoryPicker()` needs a user gesture, so re-prompting on every page
 * load would make the app unusable. A `FileSystemDirectoryHandle` is
 * structured-cloneable and can be stored in IndexedDB, which survives a reload;
 * the *permission* does not, so a stored handle always has to be re-checked
 * with `queryPermission` and, if it has lapsed, re-granted with
 * `requestPermission` — and that needs a gesture too, which is why the Devices
 * panel offers a "Reconnect" button rather than trying silently on mount.
 *
 * localStorage is not an option here: it only stores strings, and a handle is
 * an opaque object. This is the one thing in the app that genuinely needs
 * IndexedDB.
 */

const DB_NAME = "ipodrocks-devices";
const DB_VERSION = 1;
const STORE = "handles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function saveDeviceHandle(
  deviceId: number,
  handle: FileSystemDirectoryHandle
): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.put(handle, String(deviceId)));
  } catch (err) {
    // A private window, or blocked site data. The device still works for this
    // session; it just has to be picked again next time.
    console.warn("[device] could not remember the device folder", err);
  }
}

export async function loadDeviceHandle(
  deviceId: number
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await withStore<FileSystemDirectoryHandle | undefined>(
      "readonly",
      (store) => store.get(String(deviceId)) as IDBRequest<FileSystemDirectoryHandle | undefined>
    );
    return handle ?? null;
  } catch {
    return null;
  }
}

export async function forgetDeviceHandle(deviceId: number): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.delete(String(deviceId)));
  } catch {
    /* nothing to clean up */
  }
}

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
};

/** Does this handle still carry write permission, without prompting? */
export async function hasWritePermission(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  const h = handle as PermissionHandle;
  if (!h.queryPermission) return true; // OPFS, and anything without the gate.
  try {
    return (await h.queryPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/**
 * Asks for write permission. **Must be called from a user gesture** — Chrome
 * rejects it otherwise, and the rejection looks exactly like a refusal.
 */
export async function requestWritePermission(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  const h = handle as PermissionHandle;
  if (!h.requestPermission) return true;
  try {
    return (await h.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/**
 * Is this browser capable of holding a device at all?
 *
 * The File System Access API does not exist in Firefox or Safari, and not at
 * all on iOS. Web mode has to say so plainly rather than failing at the picker
 * with a `TypeError`.
 */
export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/**
 * Opens the browser's folder picker and returns the handle, or null if the
 * user dismissed it.
 *
 * Split out of `DeviceClient.pickAndAttach()` because the Add form needs the
 * folder *before* the device row exists — there is no id yet to attach to or
 * to store the handle under. The call must still happen straight out of the
 * click: Chrome refuses a picker that is not inside a user gesture, and the
 * refusal is indistinguishable from the user cancelling.
 */
export async function pickDeviceFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsDirectoryPicker()) return null;
  try {
    return await (
      window as unknown as {
        showDirectoryPicker(o: { mode: "readwrite" }): Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker({ mode: "readwrite" });
  } catch {
    // Dismissed. Not an error worth showing.
    return null;
  }
}
