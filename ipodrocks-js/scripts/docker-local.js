/**
 * Builds and runs the server image locally, in either flavour.
 *
 *   npm run docker:distroless        build + run the default image on :8780
 *   npm run docker:alpine            build + run the Alpine image on :8781
 *   npm run docker:test              build both and run the release smoke test
 *   npm run docker:test -- alpine    …or just one flavour
 *
 * `run` stays in the foreground with the daemon's log on screen (the claim
 * token is in it); Ctrl-C stops and removes the container. Each flavour has its
 * own port and its own data volume, so both can run side by side and neither
 * touches the other's database — or yours: nothing here mounts a host path
 * unless `IPODROCKS_MUSIC_DIR` is set, and then only read-only.
 *
 * `test` is the same check the release workflow runs before it tags anything:
 * the daemon answers, it reports `mpcenc: found`, and a real ffmpeg -> mpcenc
 * encode succeeds inside the container. Keep the two in step.
 *
 * Environment:
 *   IPODROCKS_MUSIC_DIR       a library folder to mount at /music (read-only)
 *   IPODROCKS_LOCAL_PORT      host port for `run` (default 8780 / 8781)
 *   IPODROCKS_SESSION_SECRET  passed through, so logins survive a restart
 */
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const FLAVOURS = { distroless: 8780, alpine: 8781 };

const [command, which = "all"] = process.argv.slice(2);

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node scripts/docker-local.js <run|test> <distroless|alpine|all>");
  process.exit(2);
}

function docker(args, opts = {}) {
  const res = spawnSync("docker", args, { stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8" });
  if (res.error) {
    console.error(res.error.code === "ENOENT" ? "docker is not installed or not on PATH." : res.error.message);
    process.exit(1);
  }
  if (res.status !== 0 && !opts.allowFail) {
    if (opts.capture) process.stderr.write(res.stderr || "");
    console.error(`\n✖ docker ${args[0]} failed (exit ${res.status})`);
    process.exit(res.status || 1);
  }
  return res;
}

const imageTag = (flavour) => `ipodrocks-server:local-${flavour}`;

function build(flavour) {
  console.log(`\n▶ Building ${flavour} image (${imageTag(flavour)})…`);
  docker(["build", "--target", flavour, "-t", imageTag(flavour), root]);
}

function musicMount() {
  const dir = process.env.IPODROCKS_MUSIC_DIR;
  return dir ? ["-v", `${path.resolve(dir)}:/music:ro`] : [];
}

function run(flavour) {
  build(flavour);
  const name = `ipodrocks-local-${flavour}`;
  const port = process.env.IPODROCKS_LOCAL_PORT || String(FLAVOURS[flavour]);
  docker(["rm", "-f", name], { capture: true, allowFail: true });

  const secret = process.env.IPODROCKS_SESSION_SECRET ? ["-e", "IPODROCKS_SESSION_SECRET"] : [];
  console.log(`\n▶ Starting ${flavour} on http://127.0.0.1:${port}  (Ctrl-C to stop)`);
  console.log(`  data volume: ${name}-data   remove it with: docker volume rm ${name}-data`);
  if (!musicMount().length) console.log("  no library mounted — set IPODROCKS_MUSIC_DIR=/path/to/music to add one");
  console.log("");
  docker(
    [
      "run", "--rm", "--name", name,
      "-p", `127.0.0.1:${port}:8780`,
      "-v", `${name}-data:/data`,
      ...musicMount(),
      ...secret,
      imageTag(flavour),
    ],
    { allowFail: true },
  );
}

// Inside the container, as the daemon would: make a WAV with the bundled
// ffmpeg, encode it with mpcenc, check for the SV8 magic.
const ENCODE_CHECK = `
const { spawnSync } = require("child_process");
const ff = require("@ffmpeg-installer/ffmpeg").path;
const wav = spawnSync(ff, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=2", "-ac", "2", "-ar", "44100", "/tmp/t.wav"]);
if (wav.status !== 0) { console.error("ffmpeg failed", String(wav.stderr)); process.exit(1); }
const mpc = spawnSync("mpcenc", ["--silent", "--standard", "/tmp/t.wav", "/tmp/t.mpc"]);
const magic = mpc.status === 0 && require("fs").readFileSync("/tmp/t.mpc").subarray(0, 4).toString();
if (magic !== "MPCK") { console.error("mpcenc failed", mpc.status, String(mpc.stderr)); process.exit(1); }
`;

async function waitForDaemon(port) {
  for (let i = 1; i <= 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
      if (res.ok) return i;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 0;
}

async function test(flavour) {
  build(flavour);
  const name = `ipodrocks-test-${flavour}`;
  const port = String(FLAVOURS[flavour] + 10);
  docker(["rm", "-f", name], { capture: true, allowFail: true });
  // No volume: the anonymous one exercises the same path a first-time user hits.
  docker(["run", "-d", "--name", name, "-p", `127.0.0.1:${port}:8780`, imageTag(flavour)], { capture: true });

  const results = [];
  const check = (label, ok) => {
    results.push(ok);
    console.log(`  ${ok ? "✔" : "✖"} ${label}`);
  };
  try {
    console.log(`\n▶ Testing ${flavour}`);
    const secs = await waitForDaemon(port);
    check(secs ? `daemon answered /api/auth/status after ${secs}s` : "daemon never answered", secs > 0);
    const logs = docker(["logs", name], { capture: true, allowFail: true });
    const log = `${logs.stdout}${logs.stderr}`;
    check("daemon reports mpcenc: found", log.includes("mpcenc: found"));
    check("claim token printed", log.includes("claim token"));
    const enc = docker(["exec", name, "node", "-e", ENCODE_CHECK], { capture: true, allowFail: true });
    check("ffmpeg -> mpcenc encode inside the container", enc.status === 0);
    const user = docker(["exec", name, "node", "-p", "process.getuid()"], { capture: true, allowFail: true });
    check(`runs as non-root (uid ${user.stdout.trim()})`, user.status === 0 && user.stdout.trim() !== "0");
    if (results.includes(false)) process.stdout.write(`\n--- container log ---\n${log}\n`);
  } finally {
    docker(["rm", "-f", name], { capture: true, allowFail: true });
  }
  // What `docker image ls` shows — unpacked, on disk. (`image inspect`'s Size is
  // the compressed content under the containerd store, which reads as a
  // quarter of this and is not what anyone compares against.)
  const size = docker(["image", "ls", imageTag(flavour), "--format", "{{.Size}}"], { capture: true });
  console.log(`  image size: ${size.stdout.trim()} on disk`);
  return !results.includes(false);
}

async function main() {
  const flavours = which === "all" ? Object.keys(FLAVOURS) : [which];
  for (const f of flavours) if (!(f in FLAVOURS)) usage(`unknown flavour: ${f}`);

  if (command === "run") {
    if (flavours.length !== 1) usage("run takes one flavour: distroless or alpine");
    run(flavours[0]);
  } else if (command === "test") {
    const outcome = {};
    for (const f of flavours) outcome[f] = await test(f);
    console.log("");
    for (const [f, ok] of Object.entries(outcome)) console.log(`${ok ? "✔ PASS" : "✖ FAIL"}  ${f}`);
    process.exit(Object.values(outcome).every(Boolean) ? 0 : 1);
  } else {
    usage();
  }
}

main();
