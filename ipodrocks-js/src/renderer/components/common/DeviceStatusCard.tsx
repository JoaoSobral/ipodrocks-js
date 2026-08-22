import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "./Button";
import { Card } from "./Card";
import { ErrorBox } from "./ErrorBox";
import { ProgressBar } from "./ProgressBar";
import { Spinner } from "./Spinner";
import { checkDevice } from "../../ipc/api";
import { formatGb } from "../../utils/format";
import type { CheckResult } from "../../ipc/api";

/**
 * `device:check` is expensive — it walks every content folder on the device
 * with a stat() per file, reads the whole library table, and rewrites
 * `device_synced_tracks`. So the result is cached per device: selecting a
 * device the first time runs one check, switching back to it reuses that
 * result, and only a sync completing (`refreshKey`) or the Refresh button
 * invalidates it.
 */
interface DeviceStatusCardProps {
  deviceId: number | "";
  /** Bumped by the parent when a sync finishes, to force a fresh check. */
  refreshKey?: number;
}

/** The handler answers `{ error }` for an unknown device — not part of CheckResult. */
type CheckResponse = CheckResult & { error?: string };

/**
 * Colour carries the state, not the category: green means this content type is
 * fully on the device, amber means something is still waiting to be copied,
 * and grey means there is nothing of that kind at all. A card that is all
 * green is a device with nothing left to sync.
 */
type Tone = "ok" | "pending" | "empty";

/**
 * The `--warning` token is a pale yellow in the light theme — fine as a tint
 * behind something, too weak to read as text on white. Amber-600 is the same
 * hue at a legible weight, so the light theme borrows it and the dark theme
 * keeps the token.
 */
const WARNING_TEXT = "text-amber-600 dark:text-warning";

const TONE_CLASSES: Record<Tone, { box: string; chip: string; value: string }> = {
  ok: {
    box: "border-success/30 bg-success/10",
    chip: "bg-success/15 text-success",
    value: "text-success",
  },
  pending: {
    box: "border-warning/40 bg-warning/10",
    chip: `bg-warning/20 ${WARNING_TEXT}`,
    value: WARNING_TEXT,
  },
  empty: {
    box: "border-border bg-muted/30",
    chip: "bg-muted text-muted-foreground",
    value: "text-muted-foreground",
  },
};

function toneFor(synced: number, toSync: number): Tone {
  if (toSync > 0) return "pending";
  return synced > 0 ? "ok" : "empty";
}

function StatTile({
  icon,
  label,
  value,
  tone,
  footnote,
  testId,
}: {
  icon: string;
  label: string;
  value: number;
  tone: Tone;
  /** Sub-line under the number; amber when it names work still to do. */
  footnote: string;
  testId: string;
}) {
  const c = TONE_CLASSES[tone];
  return (
    <div className={`rounded-lg border p-3 ${c.box}`} data-testid={testId}>
      <div className="flex items-center gap-2.5">
        <span
          className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-sm ${c.chip}`}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p
            className={`text-lg font-bold leading-none tabular-nums ${c.value}`}
            data-testid={`${testId}-value`}
          >
            {value.toLocaleString()}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">{label}</p>
        </div>
      </div>
      <p
        className={`mt-2 text-[10px] font-semibold ${
          tone === "pending" ? WARNING_TEXT : "text-muted-foreground/70 font-medium"
        }`}
      >
        {footnote}
      </p>
    </div>
  );
}

export function DeviceStatusCard({ deviceId, refreshKey = 0 }: DeviceStatusCardProps) {
  const [cache, setCache] = useState<Record<number, CheckResponse>>({});
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which device the in-flight request is for, so a late reply cannot land. */
  const inFlightRef = useRef<number | null>(null);

  const result = typeof deviceId === "number" ? cache[deviceId] : undefined;

  const runCheck = useCallback(async (id: number) => {
    inFlightRef.current = id;
    setChecking(true);
    setError(null);
    try {
      const cr = (await checkDevice(id)) as CheckResponse;
      if (inFlightRef.current !== id) return;
      if (cr?.error) setError(cr.error);
      else setCache((prev) => ({ ...prev, [id]: cr }));
    } catch (e) {
      if (inFlightRef.current !== id) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (inFlightRef.current === id) setChecking(false);
    }
  }, []);

  // Auto-check on selection, but only when this device has no cached result.
  useEffect(() => {
    if (typeof deviceId !== "number") return;
    setError(null);
    if (cache[deviceId]) return;
    void runCheck(deviceId);
    // `cache` is deliberately absent: writing the result must not re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, runCheck]);

  // A sync changed what is on the device, so the cached check is stale.
  useEffect(() => {
    if (refreshKey === 0 || typeof deviceId !== "number") return;
    setCache((prev) => {
      const next = { ...prev };
      delete next[deviceId];
      return next;
    });
    void runCheck(deviceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const handleRefresh = useCallback(() => {
    if (typeof deviceId !== "number") return;
    void runCheck(deviceId);
  }, [deviceId, runCheck]);

  const orphanCounts: [string, number][] = [
    ["music", result?.musicOrphans ?? 0],
    ["podcast", result?.podcastOrphans ?? 0],
    ["audiobook", result?.audiobookOrphans ?? 0],
    ["playlist", result?.playlistOrphans ?? 0],
  ];
  const totalOrphans = orphanCounts.reduce((sum, [, n]) => sum + n, 0);
  const orphanDetail = orphanCounts
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(" · ");

  const disk = result?.disk;
  const totalGb = disk?.totalGb ?? 0;
  const freeGb = disk?.freeGb ?? 0;
  const usedGb = totalGb - freeGb;
  const usedPct = totalGb > 0 ? (usedGb / totalGb) * 100 : 0;
  // A nearly-full device is the one thing here that can make a sync fail
  // halfway, so it escalates all the way to red rather than stopping at amber.
  const diskTone: "ok" | "warn" | "crit" =
    freeGb < 1 || usedPct >= 95 ? "crit" : usedPct >= 80 ? "warn" : "ok";
  const diskBarColor = {
    ok: "var(--success)",
    warn: "var(--warning)",
    crit: "var(--destructive)",
  }[diskTone];
  const diskTextClass = { ok: "text-success", warn: WARNING_TEXT, crit: "text-destructive" }[
    diskTone
  ];

  const playlistCount = result?.playlists?.fileCount ?? 0;

  return (
    <div data-testid="device-status-card">
      <Card
        title="Device Status"
        action={
          <Button
            size="sm"
            onClick={handleRefresh}
            disabled={checking || typeof deviceId !== "number"}
          >
            {checking ? "Checking…" : "Refresh"}
          </Button>
        }
      >
        {typeof deviceId !== "number" ? (
          <p className="text-xs text-muted-foreground">Select a device to see its status</p>
        ) : checking && !result ? (
          <div className="flex items-center justify-center py-6">
            <Spinner size="md" />
          </div>
        ) : error ? (
          <ErrorBox>{error}</ErrorBox>
        ) : !result ? (
          <p className="text-xs text-muted-foreground">No status yet — press Refresh.</p>
        ) : result.offline ? (
          <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30">
            <p className="text-xs text-destructive font-medium">Device not connected</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Mount path is unavailable. Reconnect the device and press Refresh.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatTile
                icon="♫"
                label="Songs"
                testId="device-status-songs"
                value={result.musicSyncedWithLibrary ?? 0}
                tone={toneFor(result.musicSyncedWithLibrary ?? 0, result.musicToSync ?? 0)}
                footnote={
                  (result.musicToSync ?? 0) > 0
                    ? `+${result.musicToSync} to sync`
                    : (result.musicSyncedWithLibrary ?? 0) > 0
                      ? "up to date"
                      : "nothing on device"
                }
              />
              <StatTile
                icon="◉"
                label="Podcasts"
                testId="device-status-podcasts"
                value={result.podcastSyncedWithLibrary ?? 0}
                tone={toneFor(result.podcastSyncedWithLibrary ?? 0, result.podcastToSync ?? 0)}
                footnote={
                  (result.podcastToSync ?? 0) > 0
                    ? `+${result.podcastToSync} to sync`
                    : (result.podcastSyncedWithLibrary ?? 0) > 0
                      ? "up to date"
                      : "nothing on device"
                }
              />
              <StatTile
                icon="▤"
                label="Audiobooks"
                testId="device-status-audiobooks"
                value={result.audiobookSyncedWithLibrary ?? 0}
                tone={toneFor(
                  result.audiobookSyncedWithLibrary ?? 0,
                  result.audiobookToSync ?? 0
                )}
                footnote={
                  (result.audiobookToSync ?? 0) > 0
                    ? `+${result.audiobookToSync} to sync`
                    : (result.audiobookSyncedWithLibrary ?? 0) > 0
                      ? "up to date"
                      : "nothing on device"
                }
              />
              <StatTile
                icon="≡"
                label="Playlists"
                testId="device-status-playlists"
                value={playlistCount}
                tone={playlistCount > 0 ? "ok" : "empty"}
                footnote={playlistCount > 0 ? "on device" : "nothing on device"}
              />
            </div>

            {/* Orphans — the one row that is good news when it says zero. */}
            <div
              data-testid="device-status-orphans"
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                totalOrphans > 0
                  ? "border-warning/40 bg-warning/10"
                  : "border-success/30 bg-success/10"
              }`}
            >
              <span className={totalOrphans > 0 ? WARNING_TEXT : "text-success"}>
                {totalOrphans > 0 ? "⚠" : "✓"}
              </span>
              <span
                className={`font-semibold ${totalOrphans > 0 ? WARNING_TEXT : "text-success"}`}
              >
                {totalOrphans > 0
                  ? `${totalOrphans} orphan${totalOrphans === 1 ? "" : "s"}`
                  : "No orphans"}
              </span>
              <span className="text-muted-foreground truncate">
                {totalOrphans > 0
                  ? `— ${orphanDetail}`
                  : "— everything on the device is in your library"}
              </span>
            </div>

            {disk != null && (
              <div
                data-testid="device-status-space"
                className="rounded-lg border border-border bg-muted/30 px-3 py-2.5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Device space</span>
                  <span className={`text-sm font-semibold tabular-nums ${diskTextClass}`}>
                    {formatGb(usedGb)}
                    <span className="text-muted-foreground font-normal">
                      {" / "}
                      {formatGb(totalGb)}
                    </span>
                  </span>
                </div>
                <ProgressBar className="mt-2" value={usedPct} color={diskBarColor} />
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  {formatGb(freeGb)} free · {Math.round(usedPct)}% used
                </p>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
