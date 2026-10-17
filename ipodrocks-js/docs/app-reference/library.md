# Library

The Library panel manages your music catalog: folders, scans, shadow libraries, and the track list.

## What it does

- **Add Folder** — Add a root folder for music, podcasts, or audiobooks. iPodRocks scans it recursively.
- **Scan Library** — Re-scan all folders to pick up new or changed files. Uses content hashes to skip unchanged files.
- **Clear scan cache** — Reset content hashes so the next scan re-processes all files (use when tags or files changed externally).
- **Check lossless…** — Find lossless files (FLAC, ALAC, WAV, AIFF) whose audio came from a lossy source such as an MP3 or AAC, or hi-res files that only hold CD-quality audio. See [Lossless Check](#lossless-check) below.
- **Harmonic data banner** — Shows how many tracks have key/BPM data. Links to Settings to enable extraction and Essentia analysis.
- **Library Folders** — Compact list of added folders with remove option.
- **Shadow Libraries** — Pre-transcoded mirrors (e.g. FLAC → MPC). Create, rebuild, or delete them.
- **Track list** — Search, sort, and filter by device, type, sync status, **playlist** and **lossless check verdict**. The **Lossless** column shows each checked file's verdict. Selecting a playlist from the filter dropdown narrows the list to that playlist's tracks. (The separate Playlists tab was removed in 2.0.0; full playlist management lives in the [Playlists](./playlists.md) panel.)
- **Broken-playlist banner** — If a re-scan removes tracks that playlists still reference, a warning banner appears here with a link to repair or delete the affected playlists.
- **Preview tracks** — double-click a track to play it in the persistent player bar at the bottom of the window.

## How it works

- **Scan** reads file tags (artist, album, title, genre, etc.) and optionally key/BPM via metadata or Essentia. It stores content hashes to skip unchanged files on the next scan.
- **Album artwork lives beside the audio, not inside it.** A shadow library gets one `cover.jpg` per album folder, resized to 300px — the file Rockbox reads. Artwork is deliberately **not** embedded into the transcoded files themselves; doing so put a full-resolution copy of the cover inside every single track.
- **Shadow libraries** are built once; devices can use them as the source instead of the primary library for faster sync (no on-the-fly transcoding). A shadow library is a **file-only mirror** — it contains the transcoded audio files and copied album artwork, nothing else. Play counts, ratings, and listening history are **not** stored in or synced through shadow libraries; they live in the primary library database and are updated by importing Rockbox's runtime data from the device. When the primary library changes, shadow libraries are kept in sync automatically (adds, updates, and removes propagate) — a shadow library is meant to mirror your library exactly, differing only in codec.

- **Rebuild** — The **⟳** button on a shadow library row. It does not re-encode what is already there: files that match the library's codec configuration are adopted as they stand, and only missing or mismatched tracks are converted. **It never opens a file that already exists**, so it cannot change anything about one — not its tags, not its ReplayGain. Use it when a shadow library has lost track of its files but the transcoded folder is intact.

  To actually rewrite existing files — for instance because a version before 2.3.3 wrote their Musepack ReplayGain into the tag instead of the stream header where Rockbox reads it, or embedded a full-size cover in every one — **delete the shadow library with the "delete the files too" option and create it again**. That re-encodes everything from the source, correctly. The new files differ in size and timestamp, so your next sync copies them to the device as well.

  Note that a shadow library mirrors your library's **folder layout**, not its tags. Renaming an album in a tag editor that also renames the folder on disk moves the shadow file with it (the old transcode is deleted on the next scan); editing only the album tag leaves the file where it is, and the shadow copy keeps the tag it was transcoded with — a shadow file is only rewritten when it is missing, when its folder path changes, or when it does not match the library's codec configuration. To pick up a tag-only edit, delete the shadow library keeping its files and create it again at the same folder: the mismatched tracks are re-transcoded and the rest are adopted.
- **Prune orphan files** — The **⚙** button on a shadow library row offers a one-shot cleanup that deletes files the main library no longer accounts for. Versions before 2.3.0 did not remove a transcode when its album was renamed or deleted, so shadow libraries built with those versions can hold several copies of the same album under different names. Album artwork is kept for albums that still exist, folders emptied by the cleanup are removed, and nothing outside the shadow library's own folder is ever touched. If the shadow folder is not reachable (an unplugged drive) the prune refuses to run rather than treating every file as an orphan. Renames and deletions from 2.3.0 onward are cleaned up automatically during the scan — the prune is only for the backlog.
- **Variable bitrate (VBR)** — When creating a shadow library with a lossy codec (MP3, AAC, OGG, Opus), tick **Variable bitrate (VBR)** to encode at a quality level derived from the chosen bitrate instead of a fixed bitrate — usually better quality per file size. The option only shows for these codecs; lossless codecs (FLAC/ALAC) are always variable and Musepack is already quality-based, so it is hidden for them.
- The track list is virtualized for large libraries. Filters (device, type, on device, playlist) apply in memory.

## How to work with it

1. **Before scanning:** Enable "Extract harmonic data" and "Analyze with Essentia" in Settings if you want key/BPM for Savant and harmonic mixing. Then add folders and scan.
2. **After adding a folder:** A scan runs automatically. Wait for it to finish before syncing.
3. **Shadow libraries:** Create one if you sync to a device that needs a different codec (e.g. MPC). Point the device to the shadow in Devices.
4. **Shadow library larger than it should be?** If it holds albums you renamed or deleted long ago, open its **⚙** menu and run **Prune orphan files**. Run it once; after that the app keeps itself tidy.
5. **Clear cache:** Only when you know files or tags changed outside iPodRocks and you want a full re-scan.

## Lossless Check

A file can be a perfectly valid FLAC or ALAC and still hold audio that went through a lossy encoder first — an MP3 converted to FLAC, for example. Converting cannot bring back what the encoder threw away: above a certain frequency (about 16 kHz for a 128 kbps MP3, 19–20 kHz for 320 kbps or AAC) the file holds nothing at all, behind a sharp "wall". Real CD audio carries content up to about 22 kHz, or fades out gradually. The Lossless Check looks for that wall, using Essentia to measure each file's spectrum.

### Running it

1. In the Library toolbar, click **Check lossless…**.
2. Choose **Only unchecked** (the default, which skips files already checked) or **Re-check all**, and leave **Deep check** on.
3. Click **Start check**. A **quick pass** looks at 20 seconds from every lossless file. Files that look suspicious then get a **deep pass**: six 20-second windows spread across the whole track, checked frame by frame.

**It runs in the background.** Press **Run in background** (or the **−** in the window's corner) and keep using iPodRocks, or minimise the window. A progress chip in the Library toolbar shows how far it has got; click it to bring the window back. Decoding runs in ffmpeg and the analysis on its own thread, so the app stays responsive. Only one check runs at a time, and it does not run alongside the harmonic (key/BPM) analysis, because both use the same analyser.

### Verdicts

A verdict describes **what the audio shows, not where the file came from.** A legitimately bought edit (a sped-up or remixed version, say) can be made from a compressed source and will show the same signature.

| Verdict | Meaning |
|---|---|
| **Lossy-sourced (strong)** | Unmistakable. The band above the cutoff is empty in practically every moment of the track, and the cutoff is either a sheer wall (40 dB or more) or far below the format's range (≤ 16.5 kHz). An MP3 at 128–320 kbps converted to FLAC lands here. |
| **Lossy-sourced** | The same pattern, closer to the edge: a softer wall, or one nearer the top of the range. |
| **Upsampled (not true hi-res)** | A 88.2/96/192 kHz file whose content stops at CD bandwidth (about 22–24 kHz). It is lossless, but it is not hi-res. |
| **Possibly lossy-sourced** | A wall that some moments of the track cross. This can be a natural roll-off. |
| **Genuine** | No lossy cutoff found. |
| **Inconclusive** | Too quiet to judge (mostly silence). |

For a flagged file the report also shows the **cutoff** frequency and a **likely source**, such as "MP3 ~128 kbps". The likely source is an estimate from where the cutoff sits; on an edited track (sped up, slowed down) the cutoff has moved and the estimate is unreliable. Hover a cutoff to see the measurements behind it: how far the level drops at the wall, how far below the music the band above it sits, and the share of the track where it is empty.

**What it cannot catch:** an MP3 encoded with no low-pass at all (some very-high-quality VBR settings keep the full band) passes as genuine, because nothing is missing from its spectrum. A genuine recording mastered with a steep digital low-pass reads as lossy-sourced; that is what **Mark as OK** is for.

### Results, exports and deleting

- **Filters**: Flagged (the default), each verdict on its own, or All checked.
- **Export CSV / Export Markdown** saves the rows currently shown, with title, artist, album, verdict, confidence, cutoff, likely source and the file's path on disk.
- **Mark as OK** overrules the verdict for the selected files. They drop out of the flagged list, show **OK (you)** in the Library, and later checks skip them. **Unmark** undoes it.
- **Delete selected…** removes the selected flagged files from disk and from the library. Nothing is pre-selected, and genuine, inconclusive or marked-OK files are never deleted even if selected. The desktop app moves the files to the **Trash**; a headless server has no Trash, so there they are **deleted permanently**, and the confirmation says which will happen. Playlists drop the deleted tracks, and their shadow-library copies are removed too.

A file that changes on disk (you replace a fake with a real rip, for instance) loses its verdict and any "OK" mark on the next library scan, so it is checked afresh.

Over the web server, running the check, marking files OK and deleting are **owner-only**; any signed-in user can read the results.

## Music Preview Player

Double-click any track in the library list to start playback in the player bar that appears at the bottom of the window.

**Queue** — The panel's currently filtered track list becomes the playback queue. Next/Previous navigate within it; playback stops automatically after the last track.

**Controls** — Play/pause, previous (restarts the current track if more than 3 seconds in, otherwise jumps to the previous track), stop, next, seek slider (0.5 s granularity), volume slider, mute toggle, and close (✕) to dismiss the player.

**Persistence** — Volume and mute state are remembered across sessions via `localStorage`.

**Format support** — Native playback for MP3, AAC, FLAC, OGG, Opus, PCM, and ALAC. Musepack, APE, WAV, and AIFF are transcoded to Ogg Vorbis on demand via FFmpeg the first time you press play; the transcoded copy is stored in a temp directory and reused on subsequent plays.

**Caveats** — Missing or unreadable files fail silently in the player bar. Transcoding errors are logged to the console. There is no pre-cache; each transcode happens on demand at playback time.

## Rocksy

[Rocksy](./assistant.md) can browse and manage your library from the chat:

- "What artists do I have in Rock?" → `library_list_artists` (also `library_list_albums`, `library_list_genres`)
- "Search my library for Bowie" → `library_search_tracks`
- "Add `/Users/me/Music` as a library folder" → `library_add_folder` *(asks you to confirm first)*
- "Remove that folder" → `library_remove_folder` *(asks you to confirm first)*
- "Rescan my library" → `library_scan` *(asks you to confirm first)*
- "Are my FLACs really lossless?" / "find fake FLACs" → `lossless_check` *(asks you to confirm first; then runs in the background)*
- "Which files are lossy-sourced?" → `lossless_report`
- "That one is fine, ignore it" → `lossless_mark_ok`
- "Delete the strong ones" → `lossless_report`, then `lossless_delete_flagged` *(asks you to confirm first)*

Read tools run immediately; anything that adds/removes folders or scans pauses for a **Confirm / Cancel** prompt.
