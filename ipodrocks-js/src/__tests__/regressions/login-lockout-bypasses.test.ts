/**
 * @vitest-environment node
 *
 * Regression — the two ways the per-account login lockout was skipped.
 *
 * `auth/rate-limit.ts` says it plainly: "Every attempt is counted against *two*
 * buckets... Checking only one leaves the other wide open." The account bucket
 * is the tight one (10) precisely because the address bucket has to be loose
 * (60) — a household shares an address. Both defects below removed the tight
 * one while leaving the loose one in place.
 *
 * 1. **Type confusion.** The bucket was chosen with `typeof username ===
 *    "string"` while the account was resolved with `String(username)`, so a
 *    JSON array named a real account and created no bucket for it.
 * 2. **Check-then-act.** `checkRateLimit()` and `recordFailure()` sat either
 *    side of an `await` on `crypto.scrypt`, so a concurrent burst all passed
 *    the check before any of them wrote.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { setHost, createNodeHost, resetHost } from "../../main/host";

let dataDir: string;
let rl: typeof import("../../server/auth/rate-limit");
let db: typeof import("../../server/db");

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-lockout-"));
  process.env.IPODROCKS_DATA_DIR = dataDir;
  setHost(createNodeHost());
  db = await import("../../server/db");
  db.closeServerDb();
  rl = await import("../../server/auth/rate-limit");
});

afterEach(() => {
  db.closeServerDb();
  resetHost();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("the per-account bucket is keyed on one normalized value", () => {
  it("folds case and whitespace onto a single bucket", () => {
    expect(rl.bucketsFor("1.2.3.4", "  Owner  ")).toEqual(["ip:1.2.3.4", "acct:owner"]);
    expect(rl.bucketsFor("1.2.3.4", "owner")).toEqual(["ip:1.2.3.4", "acct:owner"]);
  });

  it("still produces an account bucket for every name the route now accepts", () => {
    // The route rejects a non-string `username` outright, so the only inputs
    // that reach `bucketsFor` are strings — and each gets its own bucket.
    expect(rl.bucketsFor("1.2.3.4", "owner")).toHaveLength(2);
    expect(rl.bucketsFor("1.2.3.4", null)).toEqual(["ip:1.2.3.4"]);
  });
});

describe("reserveAttempt is atomic, so a concurrent burst cannot outrun it", () => {
  it("admits exactly MAX_ATTEMPTS_PER_ACCOUNT however the attempts interleave", () => {
    const buckets = rl.bucketsFor("203.0.113.9", "victim");

    // Every caller reserves before doing any work, which is the whole point:
    // interleaving cannot help because the read and the write are one
    // synchronous better-sqlite3 transaction.
    const verdicts = Array.from({ length: 30 }, () => rl.reserveAttempt(buckets));
    const admitted = verdicts.filter((v) => v.allowed).length;

    expect(admitted).toBe(10);
    expect(verdicts.slice(10).every((v) => !v.allowed)).toBe(true);
    expect(verdicts[10].retryAfterSeconds).toBeGreaterThan(0);
  });

  it("charges nothing to a caller who then succeeds", () => {
    const buckets = rl.bucketsFor("203.0.113.10", "good-user");
    expect(rl.reserveAttempt(buckets).allowed).toBe(true);
    rl.clearFailures(buckets);
    // The reservation is erased, so the next nine are still available.
    const after = Array.from({ length: 10 }, () => rl.reserveAttempt(buckets));
    expect(after.filter((v) => v.allowed).length).toBe(10);
  });

  it("control: the address bucket alone is far looser, which is why the account bucket matters", () => {
    const ipOnly = rl.bucketsFor("203.0.113.11", null);
    const verdicts = Array.from({ length: 30 }, () => rl.reserveAttempt(ipOnly));
    expect(verdicts.every((v) => v.allowed)).toBe(true); // 30 < 60
  });
});
