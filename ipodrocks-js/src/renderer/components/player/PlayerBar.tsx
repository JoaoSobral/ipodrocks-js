import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { usePlayerStore } from "../../stores/player-store";
import { Button } from "../common/Button";
import { formatDuration } from "../../utils/format";

// MDI SVG paths (viewBox 0 0 24 24)
const MDI = {
  skipPrev:
    "M6,18V6H8V18H6M9.5,12L18,6V18L9.5,12Z",
  play:
    "M8,5.14V19.14L19,12.14L8,5.14Z",
  pause:
    "M14,19H18V5H14M6,19H10V5H6V19Z",
  stopCircle:
    "M12,2C6.47,2 2,6.47 2,12C2,17.53 6.47,22 12,22C17.53,22 22,17.53 22,12C22,6.47 17.53,2 12,2M9,9H15V15H9V9Z",
  skipNext:
    "M16,18H18V6H16M6,18L14.5,12L6,6V18Z",
  volumeHigh:
    "M14,3.23V5.29C16.89,6.15 19,8.83 19,12C19,15.17 16.89,17.84 14,18.7V20.77C18,19.86 21,16.28 21,12C21,7.72 18,4.14 14,3.23M16.5,12C16.5,10.23 15.5,8.71 14,7.97V16C15.5,15.29 16.5,13.76 16.5,12M3,9V15H7L12,20V4L7,9H3Z",
  volumeLow:
    "M18.75,7.43L17.34,8.84C17.75,9.8 18,10.87 18,12C18,13.13 17.75,14.2 17.34,15.16L18.75,16.57C19.54,15.24 20,13.67 20,12C20,10.33 19.54,8.76 18.75,7.43M12,4L9.91,6.09L12,8.18M3,9V15H7L12,20V4L7,9H3Z",
  volumeMute:
    "M12,4L9.91,6.09L12,8.18M4.27,3L3,4.27L7.73,9H3V15H7L12,20V13.27L16.25,17.53C15.58,18.04 14.83,18.43 14,18.7V20.77C15.38,20.45 16.63,19.82 17.68,18.96L19.73,21L21,19.73L12,10.73M19,12C19,12.94 18.8,13.82 18.46,14.64L19.97,16.15C20.62,14.91 21,13.5 21,12C21,7.72 18,4.14 14,3.23V5.29C16.89,6.15 19,8.83 19,12Z",
};

function Icon({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d={path} />
    </svg>
  );
}

function sliderStyle(value: number, max: number): CSSProperties {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return {
    background: `linear-gradient(to right, var(--player-fill) ${pct}%, var(--muted) ${pct}%)`,
  };
}

export function PlayerBar() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastReportedTimeRef = useRef(0);

  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const sourceUrl = usePlayerStore((s) => s.sourceUrl);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const isPreparing = usePlayerStore((s) => s.isPreparing);
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const stop = usePlayerStore((s) => s.stop);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const seek = usePlayerStore((s) => s.seek);
  const retryAsTranscode = usePlayerStore((s) => s.retryAsTranscode);
  const dismiss = usePlayerStore((s) => s.dismiss);
  const _setIsPlaying = usePlayerStore((s) => s._setIsPlaying);
  const _setCurrentTime = usePlayerStore((s) => s._setCurrentTime);
  const _setDuration = usePlayerStore((s) => s._setDuration);
  const _onEnded = usePlayerStore((s) => s._onEnded);

  // Load and auto-play when sourceUrl changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !sourceUrl) return;
    audio.src = sourceUrl;
    audio.load();
    audio.play().catch((e) => {
      if ((e as Error).name !== "AbortError") console.error(e);
    });
  }, [sourceUrl]);

  // Sync play/pause toggles to the audio element.
  // sourceUrl is intentionally excluded from deps: Effect 1 owns autoplay on
  // source change. Including it here would call pause() while Effect 1's
  // play() promise is still pending, causing an AbortError storm.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      if (audio.paused) {
        audio.play().catch((e) => {
          if ((e as Error).name !== "AbortError") console.error(e);
        });
      }
    } else {
      if (!audio.paused) {
        audio.pause();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // Sync seek from store (stop sets currentTime=0)
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Math.abs(audio.currentTime - currentTime) > 0.5) {
      audio.currentTime = currentTime;
    }
  }, [currentTime]);

  // Sync volume and mute
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = isMuted;
  }, [volume, isMuted]);

  if (!currentTrack) return null;

  const effectiveVolume = isMuted ? 0 : volume;
  const volumeIcon =
    isMuted || volume === 0
      ? MDI.volumeMute
      : volume < 0.4
        ? MDI.volumeLow
        : MDI.volumeHigh;

  return (
    <footer className="relative shrink-0 border-t border-border bg-card px-30 h-16 flex items-center gap-4 overflow-hidden">
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        onPlay={() => _setIsPlaying(true)}
        onPause={() => _setIsPlaying(false)}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          if (Math.abs(t - lastReportedTimeRef.current) >= 0.25) {
            lastReportedTimeRef.current = t;
            _setCurrentTime(t);
          }
        }}
        onLoadedMetadata={(e) => _setDuration(e.currentTarget.duration)}
        onEnded={_onEnded}
        onError={(e) => {
          // MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) → retry with ffmpeg
          if (e.currentTarget.error?.code === 4) {
            retryAsTranscode();
          }
        }}
      />

      {/* Track info */}
      <div className="flex flex-col min-w-0 w-44 shrink-0">
        <span className="text-xs font-medium truncate text-foreground">
          {currentTrack.title}
        </span>
        <span className="text-[11px] text-muted-foreground truncate">
          {currentTrack.artist}
        </span>
      </div>

      {/* Controls + scrubber */}
      <div className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => previous()}
            title="Previous"
          >
            <Icon path={MDI.skipPrev} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={togglePlayPause}
            disabled={isPreparing || !sourceUrl}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPreparing ? (
              "…"
            ) : (
              <Icon path={isPlaying ? MDI.pause : MDI.play} size={18} />
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={stop} title="Stop">
            <Icon path={MDI.stopCircle} />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => next()} title="Next">
            <Icon path={MDI.skipNext} />
          </Button>
        </div>

        <div className="flex items-center gap-2 w-full max-w-lg">
          <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right shrink-0">
            {formatDuration(currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.5}
            value={currentTime}
            onChange={(e) => {
              const t = parseFloat(e.target.value);
              seek(t);
              if (audioRef.current) audioRef.current.currentTime = t;
            }}
            className="player-slider flex-1"
            style={sliderStyle(currentTime, duration || 0)}
            title={`${formatDuration(currentTime)} / ${formatDuration(duration)}`}
          />
          <span className="text-[10px] text-muted-foreground tabular-nums w-8 shrink-0">
            {formatDuration(duration)}
          </span>
        </div>
      </div>

      {/* Close */}
      <button
        onClick={dismiss}
        title="Close player"
        className="absolute top-1 right-1 text-muted-foreground hover:text-foreground transition-colors cursor-default text-xs leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-muted"
        aria-label="Close player"
      >
        ✕
      </button>

      {/* Volume */}
      <div className="flex items-center gap-2 w-32 shrink-0">
        <button
          onClick={toggleMute}
          className="text-muted-foreground hover:text-foreground transition-colors cursor-default flex items-center"
          title={isMuted ? "Unmute" : "Mute"}
        >
          <Icon path={volumeIcon} size={18} />
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={effectiveVolume}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setVolume(v);
            if (isMuted && v > 0) toggleMute();
          }}
          className="player-slider flex-1"
          style={sliderStyle(effectiveVolume, 1)}
          title={`Volume ${Math.round(volume * 100)}%`}
        />
      </div>
    </footer>
  );
}
