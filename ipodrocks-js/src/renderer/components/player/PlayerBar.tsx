import { useEffect, useRef } from "react";
import { usePlayerStore } from "../../stores/player-store";
import { Button } from "../common/Button";
import { formatDuration } from "../../utils/format";

export function PlayerBar() {
  const audioRef = useRef<HTMLAudioElement>(null);

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

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <footer className="relative shrink-0 border-t border-border bg-card px-30 h-16 flex items-center gap-4 overflow-hidden">
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        onPlay={() => _setIsPlaying(true)}
        onPause={() => _setIsPlaying(false)}
        onTimeUpdate={(e) => _setCurrentTime(e.currentTarget.currentTime)}
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
            ⏮
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={togglePlayPause}
            disabled={isPreparing || !sourceUrl}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPreparing ? "…" : isPlaying ? "⏸" : "⏯"}
          </Button>
          <Button variant="ghost" size="sm" onClick={stop} title="Stop">
            ⏹
          </Button>
          <Button variant="ghost" size="sm" onClick={() => next()} title="Next">
            ⏭
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
            className="flex-1 h-1 appearance-none bg-muted rounded-full accent-primary cursor-pointer"
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
          className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-default"
          title={isMuted ? "Unmute" : "Mute"}
        >
          {isMuted || volume === 0 ? "🔇" : volume < 0.4 ? "🔈" : "🔊"}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={isMuted ? 0 : volume}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setVolume(v);
            if (isMuted && v > 0) toggleMute();
          }}
          className="flex-1 h-1 appearance-none bg-muted rounded-full accent-primary cursor-pointer"
          title={`Volume ${Math.round(volume * 100)}%`}
        />
      </div>
    </footer>
  );
}
