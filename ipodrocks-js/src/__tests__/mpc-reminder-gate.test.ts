/**
 * @vitest-environment node
 *
 * The "mpcenc is not installed" reminder gate.
 *
 * The Devices panel fires seven independent IPC calls on mount and decides
 * whether to show this modal as soon as the inputs it reads have landed. The
 * decision is latched — shown once per session, and the modal's backdrop covers
 * the panel until it is dismissed — so deciding on an unread preference is not
 * something a later answer can undo. It reached CI as a flake (a click on
 * "+ Add Device" swallowed by a backdrop on a run seeded with the preference
 * set), but the user-facing bug is the same one: "don't remind me" was ignored
 * whenever that call happened to answer last.
 */
import { describe, it, expect } from "vitest";
import { shouldRemindMpcUnavailable } from "../renderer/utils/codec";
import type { CodecConfig } from "../renderer/ipc/api";

const MPC = [{ codec_name: "MPC" }] as unknown as CodecConfig[];
const MP3_ONLY = [{ codec_name: "MP3" }] as unknown as CodecConfig[];

describe("shouldRemindMpcUnavailable", () => {
  it("reminds when a Musepack config exists and mpcenc is missing", () => {
    expect(
      shouldRemindMpcUnavailable({
        codecConfigs: MPC,
        mpcAvailable: false,
        remindDisabled: false,
      })
    ).toBe(true);
  });

  it("stays quiet while the preference has not been read yet", () => {
    // The regression. `null` is "not known", and must never be read as "not
    // disabled" — the other two inputs routinely arrive first.
    expect(
      shouldRemindMpcUnavailable({
        codecConfigs: MPC,
        mpcAvailable: false,
        remindDisabled: null,
      })
    ).toBe(false);
  });

  it("stays quiet once the user has said not to remind them", () => {
    expect(
      shouldRemindMpcUnavailable({
        codecConfigs: MPC,
        mpcAvailable: false,
        remindDisabled: true,
      })
    ).toBe(false);
  });

  it("stays quiet when mpcenc is installed", () => {
    expect(
      shouldRemindMpcUnavailable({
        codecConfigs: MPC,
        mpcAvailable: true,
        remindDisabled: false,
      })
    ).toBe(false);
  });

  it("stays quiet when nothing is configured to encode Musepack", () => {
    expect(
      shouldRemindMpcUnavailable({
        codecConfigs: MP3_ONLY,
        mpcAvailable: false,
        remindDisabled: false,
      })
    ).toBe(false);
  });

  it("stays quiet before the codec list arrives", () => {
    // Same reasoning as the preference: an empty list is also "not known yet".
    for (const codecConfigs of [undefined, [] as CodecConfig[]]) {
      expect(
        shouldRemindMpcUnavailable({
          codecConfigs,
          mpcAvailable: false,
          remindDisabled: false,
        })
      ).toBe(false);
    }
  });

  it("matches the codec name case-insensitively", () => {
    expect(
      shouldRemindMpcUnavailable({
        codecConfigs: [{ codec_name: "mpc" }] as unknown as CodecConfig[],
        mpcAvailable: false,
        remindDisabled: false,
      })
    ).toBe(true);
  });
});
