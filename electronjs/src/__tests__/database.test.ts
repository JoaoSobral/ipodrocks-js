/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { SCHEMA_SQL } from "../main/database/schema";

describe("database schema", () => {
  it("defines library_folders table", () => {
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS library_folders");
  });

  it("defines tracks table with expected columns", () => {
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS tracks");
    expect(SCHEMA_SQL).toContain("path");
    expect(SCHEMA_SQL).toContain("content_type");
    expect(SCHEMA_SQL).toContain("camelot");
  });
});
