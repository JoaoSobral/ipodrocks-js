import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  AddDeviceConfig,
  DeviceProfile,
  DeviceValidation,
} from "../../shared/types";
import { Device } from "./device";

interface DeviceRow {
  id: number;
  name: string;
  mount_path: string;
  music_folder: string;
  podcast_folder: string;
  audiobook_folder: string;
  playlist_folder: string;
  description: string | null;
  last_sync_date: string | null;
  total_synced_items: number;
  last_sync_count: number;
  default_transfer_mode_id: number;
  default_codec_config_id: number | null;
  model_id: number | null;
  override_bitrate: number | null;
  override_quality: number | null;
  override_bits: number | null;
  partial_sync_enabled: number;
  source_library_type: string;
  shadow_library_id: number | null;
  transfer_mode_name: string | null;
  codec_config_name: string | null;
  bitrate_value: number | null;
  quality_value: number | null;
  bits_per_sample: number | null;
  codec_name: string | null;
  model_name: string | null;
  model_internal_value: string | null;
}

const DEVICES_QUERY = `
  SELECT d.id, d.name, d.mount_path, d.music_folder, d.podcast_folder,
         d.audiobook_folder, d.playlist_folder, d.description, d.last_sync_date, d.total_synced_items, d.last_sync_count,
         d.default_transfer_mode_id, d.default_codec_config_id, d.model_id,
         d.override_bitrate, d.override_quality, d.override_bits,
         d.partial_sync_enabled,
         d.source_library_type, d.shadow_library_id,
         dtm.name as transfer_mode_name,
         cc.name as codec_config_name, cc.bitrate_value, cc.quality_value,
         cc.bits_per_sample, c.name as codec_name,
         dm.name as model_name, dm.internal_value as model_internal_value
  FROM devices d
  LEFT JOIN device_transfer_modes dtm ON d.default_transfer_mode_id = dtm.id
  LEFT JOIN codec_configurations cc ON d.default_codec_config_id = cc.id
  LEFT JOIN codecs c ON cc.codec_id = c.id
  LEFT JOIN device_models dm ON d.model_id = dm.id
`;

const ALLOWED_UPDATE_FIELDS = new Set([
  "name",
  "mount_path",
  "music_folder",
  "podcast_folder",
  "audiobook_folder",
  "playlist_folder",
  "default_codec_config_id",
  "override_bitrate",
  "override_quality",
  "override_bits",
  "description",
  "partial_sync_enabled",
  "model_id",
  "last_sync_date",
  "total_synced_items",
  "last_sync_count",
  "source_library_type",
  "shadow_library_id",
]);

const FIELD_MAP: Record<string, string> = {
  mountPath: "mount_path",
  musicFolder: "music_folder",
  podcastFolder: "podcast_folder",
  audiobookFolder: "audiobook_folder",
  playlistFolder: "playlist_folder",
  defaultCodecConfigId: "default_codec_config_id",
  overrideBitrate: "override_bitrate",
  overrideQuality: "override_quality",
  overrideBits: "override_bits",
  partialSyncEnabled: "partial_sync_enabled",
  modelId: "model_id",
  lastSyncDate: "last_sync_date",
  totalSyncedItems: "total_synced_items",
  lastSyncCount: "last_sync_count",
  sourceLibraryType: "source_library_type",
  shadowLibraryId: "shadow_library_id",
};

export class DevicesCore {
  private db: Database.Database;
  private stmtGetAll: Database.Statement;
  private stmtGetById: Database.Statement;
  private stmtDelete: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.stmtGetAll = db.prepare(DEVICES_QUERY + " ORDER BY d.name");
    this.stmtGetById = db.prepare(DEVICES_QUERY + " WHERE d.id = ?");
    this.stmtDelete = db.prepare("DELETE FROM devices WHERE id = ?");
  }

  getDevices(): Device[] {
    const rows = this.stmtGetAll.all() as DeviceRow[];
    return rows.map((r) => new Device(this._rowToProfile(r)));
  }

  getDeviceById(id: number): Device | undefined {
    const row = this.stmtGetById.get(id) as DeviceRow | undefined;
    return row ? new Device(this._rowToProfile(row)) : undefined;
  }

  addDevice(config: AddDeviceConfig): Device {
    if (!config.name?.trim()) throw new Error("Device name cannot be empty");
    if (!config.mountPath?.trim()) throw new Error("Mount path cannot be empty");

    const existing = this.db
      .prepare("SELECT id FROM devices WHERE name = ?")
      .get(config.name) as { id: number } | undefined;
    if (existing) {
      throw new Error(`Device with name '${config.name}' already exists`);
    }

    const transferMode = this.db
      .prepare("SELECT id FROM device_transfer_modes WHERE name = 'copy'")
      .get() as { id: number } | undefined;
    if (!transferMode) {
      throw new Error("Default transfer mode 'copy' not found");
    }

    const info = this.db
      .prepare(
        `INSERT INTO devices
         (name, mount_path, music_folder, podcast_folder, audiobook_folder, playlist_folder,
          default_transfer_mode_id, default_codec_config_id, description,
          model_id, source_library_type,
          shadow_library_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        config.name,
        config.mountPath,
        config.musicFolder ?? "Music",
        config.podcastFolder ?? "Podcasts",
        config.audiobookFolder ?? "Audiobooks",
        config.playlistFolder ?? "Playlists",
        transferMode.id,
        config.defaultCodecConfigId ?? null,
        config.description ?? null,
        config.modelId ?? null,
        config.sourceLibraryType ?? "primary",
        config.shadowLibraryId ?? null
      );

    const newId = Number(info.lastInsertRowid);
    return this.getDeviceById(newId)!;
  }

  updateDevice(
    id: number,
    updates: Record<string, unknown>
  ): boolean {
    const device = this.getDeviceById(id);
    if (!device) throw new Error(`Device with ID ${id} not found`);

    if ("name" in updates) {
      const name = updates.name as string;
      if (!name?.trim()) throw new Error("Device name cannot be empty");
      const dup = this.db
        .prepare("SELECT id FROM devices WHERE name = ? AND id != ?")
        .get(name, id) as { id: number } | undefined;
      if (dup) throw new Error(`Device with name '${name}' already exists`);
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      const dbField = FIELD_MAP[key] ?? key;
      if (!ALLOWED_UPDATE_FIELDS.has(dbField)) continue;
      fields.push(`${dbField} = ?`);
      const normalized =
        dbField === "partial_sync_enabled" ? (value ? 1 : 0) : value;
      values.push(normalized);
    }

    if (fields.length === 0) return false;

    values.push(id);
    const info = this.db
      .prepare(`UPDATE devices SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);

    return info.changes > 0;
  }

  deleteDevice(id: number): boolean {
    const device = this.getDeviceById(id);
    if (!device) throw new Error(`Device with ID ${id} not found`);
    const info = this.stmtDelete.run(id);
    return info.changes > 0;
  }

  getDefaultDeviceId(): number | null {
    const row = this.db
      .prepare("SELECT value FROM app_settings WHERE key = 'default_device_id'")
      .get() as { value: string } | undefined;

    if (!row) return null;
    const parsed = parseInt(row.value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  setDefaultDevice(deviceId: number | null): boolean {
    if (deviceId === null) {
      this.db
        .prepare("DELETE FROM app_settings WHERE key = 'default_device_id'")
        .run();
      return true;
    }

    const exists = this.db
      .prepare("SELECT id FROM devices WHERE id = ?")
      .get(deviceId) as { id: number } | undefined;
    if (!exists) return false;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO app_settings (key, value, updated_at)
         VALUES ('default_device_id', ?, CURRENT_TIMESTAMP)`
      )
      .run(String(deviceId));
    return true;
  }

  validateDeviceMount(mountPath: string): DeviceValidation {
    try {
      const resolved = path.resolve(mountPath);

      if (!fs.existsSync(resolved)) {
        return { valid: false, error: `Mount path '${mountPath}' does not exist` };
      }

      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return { valid: false, error: `Mount path '${mountPath}' is not a directory` };
      }

      try {
        fs.accessSync(resolved, fs.constants.W_OK);
      } catch {
        return { valid: false, error: `Mount path '${mountPath}' is not writable` };
      }

      const foldersCreated: string[] = [];
      for (const folder of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
        const folderPath = path.join(resolved, folder);
        if (!fs.existsSync(folderPath)) {
          try {
            fs.mkdirSync(folderPath, { recursive: true });
            foldersCreated.push(folder);
          } catch (e) {
            return {
              valid: false,
              error: `Cannot create folder '${folder}': ${e}`,
            };
          }
        }
      }

      return {
        valid: true,
        error: null,
        normalizedPath: resolved,
        foldersCreated,
      };
    } catch (e) {
      return { valid: false, error: `Invalid mount path: ${e}` };
    }
  }

  private _rowToProfile(row: DeviceRow): DeviceProfile {
    return {
      id: row.id,
      name: row.name,
      mountPath: row.mount_path,
      musicFolder: row.music_folder,
      podcastFolder: row.podcast_folder,
      audiobookFolder: row.audiobook_folder ?? "Audiobooks",
      playlistFolder: row.playlist_folder,
      description: row.description,
      lastSyncDate: row.last_sync_date,
      totalSyncedItems: row.total_synced_items,
      lastSyncCount: row.last_sync_count ?? 0,
      defaultTransferModeId: row.default_transfer_mode_id,
      defaultCodecConfigId: row.default_codec_config_id,
      modelId: row.model_id,
      overrideBitrate: row.override_bitrate,
      overrideQuality: row.override_quality,
      overrideBits: row.override_bits,
      partialSyncEnabled: !!row.partial_sync_enabled,
      sourceLibraryType: (row.source_library_type as "primary" | "shadow") ?? "primary",
      shadowLibraryId: row.shadow_library_id,
      transferModeName: row.transfer_mode_name,
      codecConfigName: row.codec_config_name,
      codecConfigBitrate: row.bitrate_value,
      codecConfigQuality: row.quality_value,
      codecConfigBits: row.bits_per_sample,
      codecName: row.codec_name,
      modelName: row.model_name,
      modelInternalValue: row.model_internal_value,
    };
  }
}
