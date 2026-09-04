/**
 * @vitest-environment node
 *
 * The "Delete all" reset erases whole folders on a user's device, so the set of
 * folders it will touch is worth pinning on its own, away from the sync that
 * calls it.
 *
 * The hazard is specific: `Device.musicFolder` and friends fall back with
 * `?? "Music"`, which does NOT catch an empty string stored in the profile.
 * `path.join(mount, "")` resolves to the mount root, so an empty folder name
 * would turn "clear the Music folder" into "erase the device", Rockbox and all.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";

import { Device } from "../../main/devices/device";
import { resolveResettableFolders } from "../../main/sync/device-reset";
import type { DeviceProfile } from "../../shared/types";

const MOUNT = path.resolve("/media/ipod");

function deviceWith(overrides: Partial<DeviceProfile>): Device {
  return new Device({
    id: 1,
    name: "Test iPod",
    mountPath: MOUNT,
    ...overrides,
  } as DeviceProfile);
}

describe("delete-all folder guard", () => {
  it("resolves the three content folders under the mount", () => {
    const { reset, refused } = resolveResettableFolders(deviceWith({}));

    expect(refused).toEqual([]);
    expect(reset).toEqual([
      path.join(MOUNT, "Music"),
      path.join(MOUNT, "Podcasts"),
      path.join(MOUNT, "Audiobooks"),
    ]);
  });

  it("refuses a folder name that resolves to the device root", () => {
    // An empty string is a stored value, not a missing one, so `?? "Music"`
    // never fires and path.join collapses it to the mount itself.
    const { reset, refused } = resolveResettableFolders(
      deviceWith({ musicFolder: "" } as Partial<DeviceProfile>)
    );

    expect(reset).not.toContain(MOUNT);
    expect(reset).toEqual([
      path.join(MOUNT, "Podcasts"),
      path.join(MOUNT, "Audiobooks"),
    ]);
    expect(refused).toHaveLength(1);
    expect(refused[0].path).toBe(MOUNT);
    expect(refused[0].reason).toMatch(/device root/);
  });

  it("refuses a folder that escapes the mount", () => {
    const { reset, refused } = resolveResettableFolders(
      deviceWith({ podcastFolder: "../../home/pedro" } as Partial<DeviceProfile>)
    );

    expect(reset.every((p) => p.startsWith(MOUNT + path.sep))).toBe(true);
    expect(refused.map((r) => r.reason)).toContain(
      "podcast folder resolves to the device root"
    );
  });

  it("collapses two content types pointing at one folder", () => {
    const { reset } = resolveResettableFolders(
      deviceWith({ audiobookFolder: "Music" } as Partial<DeviceProfile>)
    );

    expect(reset).toEqual([
      path.join(MOUNT, "Music"),
      path.join(MOUNT, "Podcasts"),
    ]);
  });

  it("refuses everything when the device has no mount path", () => {
    const { reset, refused } = resolveResettableFolders(
      deviceWith({ mountPath: "" } as Partial<DeviceProfile>)
    );

    expect(reset).toEqual([]);
    expect(refused[0].reason).toMatch(/no mount path/);
  });
});
