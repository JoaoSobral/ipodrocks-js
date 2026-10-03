/**
 * Account recovery for the headless server, run on the machine that holds the
 * database:
 *
 *   npm run server:accounts -- list
 *   npm run server:accounts -- password <username>
 *   docker exec -it <container> node dist/main/server/cli.js password <username>
 *
 * Same trust rule as the claim token: a shell that can open
 * `ipodrocks-server.db` already owns every account in it, so this grants
 * nothing new. It honours `IPODROCKS_DATA_DIR` exactly like the daemon, and is
 * safe to run beside a running one (the database is in WAL mode). The password
 * is read without echo from a terminal, or as one line from a pipe — never from
 * argv, which lands in shell history and `ps`.
 */
import * as readline from "readline";
import { setHost, createNodeHost } from "../main/host";
import { closeServerDb } from "./db";
import { listIdentities } from "./auth/identities";
import { findLocalAccount, resetLocalPassword } from "./auth/password-reset";

const USAGE =
  "Usage:\n" +
  "  cli.js list                  list the accounts that may sign in\n" +
  "  cli.js password <username>   set a local account's password\n";

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          stdin.off("data", onData);
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    let first: string | null = null;
    rl.once("line", (line) => {
      first = line;
      rl.close();
    });
    rl.once("close", () => resolve(first ?? ""));
  });
}

async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readLine();
  const a = await readHidden("New password: ");
  const b = await readHidden("Repeat it:    ");
  if (a !== b) throw new Error("The two passwords do not match.");
  return a;
}

export async function main(argv: string[]): Promise<number> {
  const [command, username] = argv;

  if (command === "list") {
    for (const i of listIdentities()) {
      const who = i.provider === "local" ? i.subject : `${i.provider}:${i.email ?? i.subject}`;
      console.log(`${who}${i.isOwner ? "  (owner)" : ""}`);
    }
    return 0;
  }

  if (command === "password" && username) {
    const account = findLocalAccount(username);
    if (!account) {
      console.error(
        `No local account named "${username}". Run "list" to see who can sign in.`
      );
      return 1;
    }
    const password = await readNewPassword();
    const result = await resetLocalPassword(account.id, password);
    if ("error" in result) {
      console.error(result.error);
      return 1;
    }
    console.log(
      `Password set for ${account.subject}. ` +
        `${result.signedOut} existing session(s) signed out.`
    );
    return 0;
  }

  process.stderr.write(USAGE);
  return 2;
}

// Guarded so a test can import `main` without running it.
if (typeof require !== "undefined" && require.main === module) {
  setHost(createNodeHost());
  main(process.argv.slice(2))
    .then((code) => {
      closeServerDb();
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      closeServerDb();
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
