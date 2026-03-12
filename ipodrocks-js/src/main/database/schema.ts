/**
 * SQLite schema for iPodRock — ported from Python's DatabaseManager and HashManager.
 *
 * Execute with better-sqlite3's `db.exec(SCHEMA_SQL)`.
 */

export const SCHEMA_SQL = `
-- ============================================================
-- Library
-- ============================================================

CREATE TABLE IF NOT EXISTS library_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL CHECK(content_type IN ('music', 'podcast', 'audiobook')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist_id INTEGER NOT NULL,
    year INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (artist_id) REFERENCES artists (id),
    UNIQUE(title, artist_id)
);

CREATE TABLE IF NOT EXISTS genres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS codecs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    title TEXT,
    track_number INTEGER,
    disc_number INTEGER,
    duration REAL,
    bitrate INTEGER,
    bits_per_sample INTEGER,
    file_size INTEGER,
    content_type TEXT NOT NULL CHECK(content_type IN ('music', 'podcast', 'audiobook')),
    library_folder_id INTEGER,
    artist_id INTEGER,
    album_id INTEGER,
    genre_id INTEGER,
    codec_id INTEGER,
    file_hash TEXT,
    play_count INTEGER DEFAULT 0,
    show_title TEXT,
    episode_number INTEGER,
    metadata_hash TEXT,
    key TEXT,
    bpm REAL,
    camelot TEXT,
    features_scanned INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (library_folder_id) REFERENCES library_folders (id),
    FOREIGN KEY (artist_id) REFERENCES artists (id),
    FOREIGN KEY (album_id) REFERENCES albums (id),
    FOREIGN KEY (genre_id) REFERENCES genres (id),
    FOREIGN KEY (codec_id) REFERENCES codecs (id)
);

-- ============================================================
-- Playback
-- ============================================================

CREATE TABLE IF NOT EXISTS playback_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    device_db_id INTEGER,
    device_name TEXT,
    timestamp_tick INTEGER NOT NULL,
    elapsed_ms INTEGER NOT NULL,
    total_ms INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    matched_track_id INTEGER,
    completion_rate REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (matched_track_id) REFERENCES tracks (id)
);

CREATE TABLE IF NOT EXISTS playback_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL,
    total_plays INTEGER DEFAULT 0,
    total_playtime_ms INTEGER DEFAULT 0,
    avg_completion_rate REAL DEFAULT 0,
    last_played_at TIMESTAMP,
    first_played_at TIMESTAMP,
    devices_played_on TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (track_id) REFERENCES tracks (id),
    UNIQUE(track_id)
);

-- ============================================================
-- Devices
-- ============================================================

CREATE TABLE IF NOT EXISTS device_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    internal_value TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS device_transfer_modes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS codec_configurations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codec_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    bitrate_value INTEGER,
    quality_value INTEGER,
    bits_per_sample INTEGER,
    is_default BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (codec_id) REFERENCES codecs (id),
    UNIQUE(codec_id, name)
);

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    mount_path TEXT NOT NULL,
    music_folder TEXT NOT NULL DEFAULT 'Music',
    podcast_folder TEXT NOT NULL DEFAULT 'Podcasts',
    audiobook_folder TEXT NOT NULL DEFAULT 'Audiobooks',
    playlist_folder TEXT NOT NULL DEFAULT 'Playlists',
    default_transfer_mode_id INTEGER NOT NULL,
    default_codec_config_id INTEGER,
    model_id INTEGER,
    override_bitrate INTEGER,
    override_quality INTEGER,
    override_bits INTEGER,
    partial_sync_enabled BOOLEAN NOT NULL DEFAULT 0,
    source_library_type TEXT NOT NULL DEFAULT 'primary' CHECK(source_library_type IN ('primary', 'shadow')),
    shadow_library_id INTEGER,
    description TEXT,
    last_sync_date TIMESTAMP,
    total_synced_items INTEGER DEFAULT 0,
    last_sync_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (default_transfer_mode_id) REFERENCES device_transfer_modes (id),
    FOREIGN KEY (default_codec_config_id) REFERENCES codec_configurations (id),
    FOREIGN KEY (model_id) REFERENCES device_models (id),
    FOREIGN KEY (shadow_library_id) REFERENCES shadow_libraries (id)
);

CREATE TABLE IF NOT EXISTS device_synced_tracks (
    device_id INTEGER NOT NULL,
    library_path TEXT NOT NULL,
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, library_path),
    FOREIGN KEY (device_id) REFERENCES devices (id)
);

-- ============================================================
-- Sync
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_configurations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    config_name TEXT NOT NULL,
    sync_type TEXT NOT NULL CHECK(sync_type IN ('full', 'partial')),
    is_active BOOLEAN NOT NULL DEFAULT 1,
    extra_track_policy TEXT NOT NULL DEFAULT 'prompt',
    include_podcasts INTEGER NOT NULL DEFAULT 1,
    include_audiobooks INTEGER NOT NULL DEFAULT 1,
    include_playlists INTEGER NOT NULL DEFAULT 1,
    created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_date TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices (id),
    UNIQUE(device_id, config_name)
);

CREATE TABLE IF NOT EXISTS sync_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_config_id INTEGER NOT NULL,
    rule_type TEXT NOT NULL CHECK(rule_type IN ('all', 'artist', 'album', 'genre', 'podcast', 'playlist')),
    target_id INTEGER,
    target_label TEXT,
    content_types TEXT NOT NULL DEFAULT '["music"]',
    override_transfer_mode_id INTEGER,
    override_codec_id INTEGER,
    override_bitrate INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sync_config_id) REFERENCES sync_configurations (id),
    FOREIGN KEY (target_id) REFERENCES artists (id),
    FOREIGN KEY (target_id) REFERENCES albums (id),
    FOREIGN KEY (target_id) REFERENCES genres (id),
    FOREIGN KEY (override_transfer_mode_id) REFERENCES device_transfer_modes (id),
    FOREIGN KEY (override_codec_id) REFERENCES codecs (id)
);


-- ============================================================
-- Playlists
-- ============================================================

CREATE TABLE IF NOT EXISTS playlist_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    playlist_type_id INTEGER NOT NULL,
    savant_config TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_type_id) REFERENCES playlist_types (id)
);

CREATE TABLE IF NOT EXISTS playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE CASCADE,
    UNIQUE(playlist_id, position)
);

CREATE TABLE IF NOT EXISTS smart_playlist_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    rule_type TEXT NOT NULL,
    target_id INTEGER,
    target_label TEXT,
    FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS genius_playlist_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    genius_type TEXT NOT NULL,
    device_id INTEGER,
    track_limit INTEGER DEFAULT 50,
    last_generated_at TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices (id)
);

-- ============================================================
-- Shadow Libraries
-- ============================================================

CREATE TABLE IF NOT EXISTS shadow_libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL UNIQUE,
    codec_config_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'building', 'ready', 'error')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (codec_config_id) REFERENCES codec_configurations (id)
);

CREATE TABLE IF NOT EXISTS shadow_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shadow_library_id INTEGER NOT NULL,
    source_track_id INTEGER NOT NULL,
    shadow_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'synced', 'error')),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (shadow_library_id) REFERENCES shadow_libraries (id) ON DELETE CASCADE,
    FOREIGN KEY (source_track_id) REFERENCES tracks (id) ON DELETE CASCADE,
    UNIQUE(shadow_library_id, source_track_id)
);

-- ============================================================
-- Content Hashes (from HashManager)
-- ============================================================

CREATE TABLE IF NOT EXISTS content_hashes (
    id INTEGER PRIMARY KEY,
    file_path TEXT UNIQUE NOT NULL,
    content_hash TEXT NOT NULL,
    metadata_hash TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    last_modified TIMESTAMP NOT NULL,
    hash_type TEXT DEFAULT 'sha256',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Application Settings
-- ============================================================

CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    detail TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Seed Data
-- ============================================================

-- Device models
INSERT OR IGNORE INTO device_models (name, internal_value, description) VALUES ('iPod Classic', 'ipod_classic', 'iPod Classic model');
INSERT OR IGNORE INTO device_models (name, internal_value, description) VALUES ('iPod Video', 'ipod_video', 'iPod Video model');
INSERT OR IGNORE INTO device_models (name, internal_value, description) VALUES ('iPod Nano 1-2 generation', 'ipod_nano', 'iPod Nano 1-2 generation');
INSERT OR IGNORE INTO device_models (name, internal_value, description) VALUES ('iPod Colour', 'ipod_touch_colour', 'iPod Colour model');
INSERT OR IGNORE INTO device_models (name, internal_value, description) VALUES ('iPod Monochrome 2-4 generation', 'ipod_touch_colour', 'iPod Monochrome 2-4 generation');
INSERT OR IGNORE INTO device_models (name, internal_value, description) VALUES ('iPod Original', 'ipod_touch_colour', 'iPod Original model');
INSERT OR IGNORE INTO device_models (name, internal_value, description) VALUES ('iPod Shuffle', 'ipod_shuffle', 'iPod Shuffle model');
INSERT OR IGNORE INTO device_models (name, internal_value, description) VALUES ('iPod Mini', 'ipod_mini', 'iPod Mini model');
INSERT OR IGNORE INTO device_models (name, internal_value, description) VALUES ('Other device', 'other_device', 'Other device type');

-- Transfer modes
INSERT OR IGNORE INTO device_transfer_modes (name, description) VALUES ('copy', 'Copy files without conversion');
INSERT OR IGNORE INTO device_transfer_modes (name, description) VALUES ('convert', 'Convert files to target format');

-- Codecs
INSERT OR IGNORE INTO codecs (name, description) VALUES ('DIRECT COPY', 'Direct 1:1 copy from library without conversion');
INSERT OR IGNORE INTO codecs (name, description) VALUES ('AAC', 'Advanced Audio Coding');
INSERT OR IGNORE INTO codecs (name, description) VALUES ('ALAC', 'Apple Lossless Audio Codec');
INSERT OR IGNORE INTO codecs (name, description) VALUES ('MP3', 'MPEG-1 Audio Layer III');
INSERT OR IGNORE INTO codecs (name, description) VALUES ('FLAC', 'Free Lossless Audio Codec');
INSERT OR IGNORE INTO codecs (name, description) VALUES ('OGG', 'Ogg Vorbis');
INSERT OR IGNORE INTO codecs (name, description) VALUES ('OPUS', 'Opus Audio Codec');
INSERT OR IGNORE INTO codecs (name, description) VALUES ('PCM', 'Pulse-Code Modulation (WAV/AIFF)');
INSERT OR IGNORE INTO codecs (name, description) VALUES ('MPC', 'Musepack');
INSERT OR IGNORE INTO codecs (name, description) VALUES ('Unknown', 'Unknown or unsupported codec');

-- Playlist types
INSERT OR IGNORE INTO playlist_types (name, description) VALUES ('smart', 'Smart playlist with dynamic rules');
INSERT OR IGNORE INTO playlist_types (name, description) VALUES ('custom', 'Custom user-created playlist');
INSERT OR IGNORE INTO playlist_types (name, description) VALUES ('genius', 'Genius playlist based on music analysis');
INSERT OR IGNORE INTO playlist_types (name, description) VALUES ('savant', 'Savant playlist with AI recommendations');

-- Codec configurations
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Direct 1:1 Library Copy', NULL, NULL, NULL, 1 FROM codecs WHERE name = 'DIRECT COPY';

INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Godly Transparent', 510, NULL, NULL, 1 FROM codecs WHERE name = 'OPUS';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Insanely Transparent', 414, NULL, NULL, 0 FROM codecs WHERE name = 'OPUS';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Absolutely Transparent', 320, NULL, NULL, 0 FROM codecs WHERE name = 'OPUS';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Near Transparent', 256, NULL, NULL, 0 FROM codecs WHERE name = 'OPUS';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Almost There', 192, NULL, NULL, 0 FROM codecs WHERE name = 'OPUS';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Good Enough for Casual Listening', 128, NULL, NULL, 0 FROM codecs WHERE name = 'OPUS';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Noticeable Artifacts', 96, NULL, NULL, 0 FROM codecs WHERE name = 'OPUS';

INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Absolutely Transparent', NULL, 10, NULL, 1 FROM codecs WHERE name = 'MPC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Near Transparent', NULL, 9, NULL, 1 FROM codecs WHERE name = 'MPC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Almost There', NULL, 8, NULL, 1 FROM codecs WHERE name = 'MPC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Good Enough', NULL, 7, NULL, 0 FROM codecs WHERE name = 'MPC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Surprisingly Nice', NULL, 6, NULL, 0 FROM codecs WHERE name = 'MPC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Solid Listening Spot', NULL, 5, NULL, 0 FROM codecs WHERE name = 'MPC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Noticeable Artifacts', NULL, 4, NULL, 0 FROM codecs WHERE name = 'MPC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Kind of Crunchy', NULL, 3, NULL, 0 FROM codecs WHERE name = 'MPC';

INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Absolutely Transparent', 320, NULL, NULL, 1 FROM codecs WHERE name = 'AAC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Near Transparent', 256, NULL, NULL, 0 FROM codecs WHERE name = 'AAC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Almost There', 192, NULL, NULL, 0 FROM codecs WHERE name = 'AAC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Good Enough for Casual Listening', 128, NULL, NULL, 0 FROM codecs WHERE name = 'AAC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Noticeable Artifacts', 96, NULL, NULL, 0 FROM codecs WHERE name = 'AAC';

INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Near Transparent', 320, NULL, NULL, 1 FROM codecs WHERE name = 'MP3';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Almost There', 256, NULL, NULL, 0 FROM codecs WHERE name = 'MP3';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Good Enough for Casual Listening', 192, NULL, NULL, 0 FROM codecs WHERE name = 'MP3';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Noticeable Artifacts', 128, NULL, NULL, 0 FROM codecs WHERE name = 'MP3';

INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Near Transparent', 320, NULL, NULL, 1 FROM codecs WHERE name = 'OGG';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Almost There', 256, NULL, NULL, 0 FROM codecs WHERE name = 'OGG';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Good Enough for Casual Listening', 192, NULL, NULL, 0 FROM codecs WHERE name = 'OGG';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Noticeable Artifacts', 128, NULL, NULL, 0 FROM codecs WHERE name = 'OGG';

INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Studio Transparent', NULL, NULL, 24, 1 FROM codecs WHERE name = 'FLAC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Archive Transparent', NULL, NULL, 16, 0 FROM codecs WHERE name = 'FLAC';

INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Studio Transparent', NULL, NULL, 24, 1 FROM codecs WHERE name = 'ALAC';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Archive Transparent', NULL, NULL, 16, 0 FROM codecs WHERE name = 'ALAC';

INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Studio Transparent', NULL, NULL, 24, 1 FROM codecs WHERE name = 'PCM';
INSERT OR IGNORE INTO codec_configurations (codec_id, name, bitrate_value, quality_value, bits_per_sample, is_default)
  SELECT id, 'Archive Transparent', NULL, NULL, 16, 0 FROM codecs WHERE name = 'PCM';

-- ============================================================
-- Indexes
-- ============================================================

-- tracks
CREATE INDEX IF NOT EXISTS idx_tracks_content_type ON tracks(content_type);
CREATE INDEX IF NOT EXISTS idx_tracks_library_folder ON tracks(library_folder_id);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre_id);
CREATE INDEX IF NOT EXISTS idx_tracks_codec ON tracks(codec_id);
CREATE INDEX IF NOT EXISTS idx_tracks_file_hash ON tracks(file_hash);
CREATE INDEX IF NOT EXISTS idx_tracks_metadata_hash ON tracks(metadata_hash);

-- albums
CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);

-- playback_logs
CREATE INDEX IF NOT EXISTS idx_playback_logs_device ON playback_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_playback_logs_track ON playback_logs(matched_track_id);
CREATE INDEX IF NOT EXISTS idx_playback_logs_timestamp ON playback_logs(timestamp_tick);
CREATE UNIQUE INDEX IF NOT EXISTS idx_playback_logs_device_timestamp_path
  ON playback_logs(device_db_id, timestamp_tick, file_path) WHERE device_db_id IS NOT NULL;

-- playback_stats
CREATE INDEX IF NOT EXISTS idx_playback_stats_track ON playback_stats(track_id);
CREATE INDEX IF NOT EXISTS idx_playback_stats_plays ON playback_stats(total_plays);

-- library_folders
CREATE INDEX IF NOT EXISTS idx_library_folders_content_type ON library_folders(content_type);

-- devices
CREATE INDEX IF NOT EXISTS idx_devices_name ON devices(name);

-- device_synced_tracks
CREATE INDEX IF NOT EXISTS idx_device_synced_device ON device_synced_tracks(device_id);

-- sync_configurations
CREATE INDEX IF NOT EXISTS idx_sync_configs_device ON sync_configurations(device_id);
CREATE INDEX IF NOT EXISTS idx_sync_configs_active ON sync_configurations(is_active);

-- sync_rules
CREATE INDEX IF NOT EXISTS idx_sync_rules_config ON sync_rules(sync_config_id);
CREATE INDEX IF NOT EXISTS idx_sync_rules_type_target ON sync_rules(rule_type, target_id);
CREATE INDEX IF NOT EXISTS idx_sync_rules_overrides ON sync_rules(override_transfer_mode_id, override_codec_id);

-- playlists
CREATE INDEX IF NOT EXISTS idx_playlists_type ON playlists(playlist_type_id);
CREATE INDEX IF NOT EXISTS idx_playlists_name ON playlists(name);

-- playlist_items
CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist ON playlist_items(playlist_id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_track ON playlist_items(track_id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_position ON playlist_items(playlist_id, position);

-- codec_configurations
CREATE INDEX IF NOT EXISTS idx_codec_configs_codec ON codec_configurations(codec_id);
CREATE INDEX IF NOT EXISTS idx_codec_configs_default ON codec_configurations(is_default);

-- content_hashes
CREATE INDEX IF NOT EXISTS idx_content_hash ON content_hashes(content_hash);
CREATE INDEX IF NOT EXISTS idx_metadata_hash ON content_hashes(metadata_hash);
CREATE INDEX IF NOT EXISTS idx_file_path ON content_hashes(file_path);
CREATE INDEX IF NOT EXISTS idx_last_modified ON content_hashes(last_modified);

-- app_settings
CREATE INDEX IF NOT EXISTS idx_app_settings_key ON app_settings(key);

-- activity_log
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at DESC);

-- shadow_libraries
CREATE INDEX IF NOT EXISTS idx_shadow_libraries_status ON shadow_libraries(status);
CREATE INDEX IF NOT EXISTS idx_shadow_libraries_codec ON shadow_libraries(codec_config_id);

-- shadow_tracks
CREATE INDEX IF NOT EXISTS idx_shadow_tracks_library ON shadow_tracks(shadow_library_id);
CREATE INDEX IF NOT EXISTS idx_shadow_tracks_source ON shadow_tracks(source_track_id);
CREATE INDEX IF NOT EXISTS idx_shadow_tracks_status ON shadow_tracks(status);
`;
