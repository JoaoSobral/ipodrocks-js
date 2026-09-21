# Deploying the server

iPodRocks can run as a headless daemon with no Electron at all: the same
handlers, the same database, the same sync engine, served over HTTP instead of
to a desktop window. The library and the encoders stay on the server; the
**device** lives in whatever browser you open it from, through the File System
Access API.

That is the shape worth keeping in mind while reading the rest of this page:

```
  NAS / home server                 your laptop                  your player
  ─────────────────                 ───────────                  ─────────
  library + SQLite                  Chrome tab                   USB mount
  ffmpeg + mpcenc      ──HTTPS──▶   showDirectoryPicker()  ──▶   /Music/…
  sync engine          ◀──WS────    device RPC
```

Every byte copied to the player travels server → browser → device. A sync of a
large library over a slow link is slow for that reason and no other — see
[Devices](/app-reference/devices) for what to do about it (a shadow library and
a partial selection).

If you only want the desktop app to serve a browser on the same LAN, you do not
need any of this: turn on **Settings → Web Server**. This page is about the
standalone daemon.

**Looking for the whole path from nothing to a syncing player** — including
setting up Google, GitHub or Facebook sign-in? That is
[Setting up the server, end to end](/guide/server-setup). This page is the
reference for the deployment itself.

## Requirements

Node 22 or newer, and a checkout built with `npm run build`. That is all — the
daemon imports no Electron and needs none installed.

`better-sqlite3`, the only native dependency, ships prebuilt binaries in its npm
package that work unchanged under both Node and Electron, so a tree you also use
for the desktop app will run the daemon as-is and nothing has to be rebuilt
either way.

## Docker

The `Dockerfile` in the repository root builds the daemon and nothing else. It
installs with `--ignore-scripts`, which skips Electron's ~100 MB binary
download; the image never runs Electron and has no other use for it.

```sh
docker build -t ipodrocks-server .
docker run -d --name ipodrocks \
  -p 127.0.0.1:8780:8780 \
  -v ipodrocks-data:/data \
  -v /srv/music:/music:ro \
  -e IPODROCKS_SESSION_SECRET="$(openssl rand -base64 48)" \
  ipodrocks-server
```

Then read the claim token out of the log (see [First run](#first-run)):

```sh
docker logs ipodrocks
```

### Volumes

| Path | What it holds |
|---|---|
| `/data` | `ipodrock.db`, `ipodrocks-server.db`, `ipodrocks-prefs.json`. Losing it loses the library index, every device profile and every login. Back it up. |
| `/music` | Your library. Mount it **read-only** unless you want a shadow library, which writes transcodes next to nothing else. |

`/data` is `IPODROCKS_DATA_DIR`, which is the one variable with no sensible
default in a container — the Node host resolves *everything* it writes from it.

### Encoders

`ffmpeg` comes from `@ffmpeg-installer/ffmpeg` in `node_modules`;
`getFfmpegPath()` falls back to it whenever the app is not a packaged Electron
build, which a daemon never is. Nothing further is needed.

`mpcenc` is bundled by nothing. The image installs Debian's `musepack-tools`.
Without it, **Musepack shadow-library profiles are unavailable** — the daemon
says so at startup:

```
[server] mpcenc: not found — Musepack shadow-library profiles are unavailable.
```

and the codec picker in the app greys those profiles out, the same way it does
on a desktop install with no `mpcenc` on `PATH`.

### docker-compose

`docker-compose.yml` in the repository root is a starting point. Copy the
variables it references into a `.env` beside it:

```sh
IPODROCKS_SESSION_SECRET=…        # openssl rand -base64 48
IPODROCKS_PUBLIC_URL=https://ipod.example.com
IPODROCKS_MUSIC_DIR=/srv/music
CLOUDFLARE_TUNNEL_TOKEN=…         # only for --profile tunnel
```

```sh
docker compose up -d                       # server only, loopback
docker compose --profile tunnel up -d      # server + cloudflared
```

Two defaults in that file are deliberately conservative and may be wrong for
you: `/music` is read-only, and the port is published to `127.0.0.1` only.

## systemd

`deploy/ipodrocks-server.service` runs the daemon from a checkout at
`/opt/ipodrocks` as a dedicated `ipodrocks` user. `--ignore-scripts` on the
install is only there to skip Electron's binary download — nothing in the daemon
needs it.

```sh
sudo useradd --system --home /opt/ipodrocks ipodrocks
sudo -u ipodrocks git clone https://github.com/JoaoSobral/ipodrocks-js /opt/ipodrocks
cd /opt/ipodrocks/ipodrocks-js
sudo -u ipodrocks npm ci --ignore-scripts
sudo -u ipodrocks npm run build

sudo install -d -m 0750 -o root -g ipodrocks /etc/ipodrocks
printf 'IPODROCKS_SESSION_SECRET=%s\n' "$(openssl rand -base64 48)" \
  | sudo tee /etc/ipodrocks/server.env >/dev/null
sudo chmod 0640 /etc/ipodrocks/server.env
sudo chgrp ipodrocks /etc/ipodrocks/server.env

sudo cp deploy/ipodrocks-server.service /etc/systemd/system/
sudo systemctl enable --now ipodrocks-server
journalctl -u ipodrocks-server -f
```

Secrets go in `/etc/ipodrocks/server.env`, not in the unit file: `systemctl
show` prints `Environment=` lines to any user, while `EnvironmentFile=` contents
it does not.

The unit binds loopback. Put cloudflared or a TLS-terminating reverse proxy in
front rather than changing that, unless you also set `IPODROCKS_TLS_CERT` and
`IPODROCKS_TLS_KEY`.

## Cloudflare Tunnel

A tunnel is the easiest way to get a real HTTPS hostname without opening a port,
and a real hostname is what social sign-in requires — Google will not accept a
callback URI for a LAN address.

1. Create a **named tunnel** in the Cloudflare Zero Trust dashboard, with a
   public hostname (`ipod.example.com`) routed to `http://127.0.0.1:8780`, or
   `http://ipodrocks:8780` for the compose sidecar.
2. Set `IPODROCKS_PUBLIC_URL=https://ipod.example.com`. The server builds OAuth
   callback URLs from it and uses it as the allowed WebSocket origin; without it
   social sign-in is refused and the browser's device socket will not connect.
3. Set `IPODROCKS_TRUSTED_PROXIES` to the tunnel's address — and to nothing
   else. See below.
4. Keep the origin on loopback. The tunnel dials out; nothing needs to dial in.

### Cloudflare Access (optional, and recommended)

Putting the hostname behind Access adds a second, independent gate in front of
the app's own login. Set:

```sh
IPODROCKS_CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
IPODROCKS_CF_ACCESS_AUD=<the application audience tag>
```

With those set the server **verifies the `Cf-Access-Jwt-Assertion` on every
request** rather than trusting that the tunnel is the only way in. A request
that reached the origin some other way is rejected even with a valid session
cookie — which is the entire point of verifying it.

### `IPODROCKS_TRUSTED_PROXIES` is a security setting

The login rate limiter keys on `req.ip`. Express's `trust proxy` left wide open
means any client can forge `X-Forwarded-For` and get a fresh bucket per request,
so the limiter stops existing. The server therefore trusts **only the addresses
you list**, and lists nothing by default.

Set it to the proxy in front of you and nothing wider. If nothing is in front,
leave it unset.

## First run

The first person to sign in cannot be checked against an allowlist, because the
allowlist is empty. So the server prints a **one-time claim token** to its log:

```
  ┌─ First run ────────────────────────────────────────────────┐
  │ This server has no owner yet. Open it in a browser and     │
  │ sign in with this one-time claim token:                    │
  │   xXk3…                                                    │
```

Whoever can read that log owns the machine, so binding the first identity to it
grants nothing an attacker did not already have. The token is consumed by the
first successful claim and never printed again.

Open the server in a browser, create a username and password, and paste the
token. That account becomes the **owner**, and it is the only one that can
manage the allowlist afterwards.

**A successful Google login is not authorization.** Anyone on earth can complete
an OAuth flow against your client id and arrive at the callback with a valid
profile. The allowlist is what admits them, and the owner has to add them to it
— over HTTP (`/api/auth/identities`), from Settings → Web Server, or by asking
Rocksy ("who can sign in to my server?").

## Environment reference

There is no flag parsing and deliberately no config file for these: a second
configuration surface would immediately disagree with the precedence rules in
`loadServerConfig()`. Deployment shape can *also* be set from Settings → Web
Server when the desktop app is hosting; the environment always wins.

| Variable | Default | Meaning |
|---|---|---|
| `IPODROCKS_DATA_DIR` | platform user-data dir | Database, prefs, session store. **Set this in a container.** |
| `IPODROCKS_SERVER_HOST` | `127.0.0.1` | Bind address. |
| `IPODROCKS_SERVER_PORT` | `8780` | Port. |
| `IPODROCKS_PUBLIC_URL` | — | Externally visible origin. Required for any social sign-in. |
| `IPODROCKS_SESSION_SECRET` | random per boot | Set it, or every restart logs everyone out. |
| `IPODROCKS_TLS_CERT` / `IPODROCKS_TLS_KEY` | — | Terminate TLS in the daemon itself. Both or neither. |
| `IPODROCKS_TRUSTED_PROXIES` | none | Comma-separated. Whose `X-Forwarded-*` to believe. |
| `IPODROCKS_ALLOWED_ORIGINS` | `IPODROCKS_PUBLIC_URL` | Extra origins accepted on the WebSocket upgrade, and on any API request that changes something. |
| `IPODROCKS_GOOGLE_CLIENT_ID` / `_SECRET` | — | Google sign-in. Both or neither. |
| `IPODROCKS_GITHUB_CLIENT_ID` / `_SECRET` | — | GitHub sign-in. |
| `IPODROCKS_FACEBOOK_CLIENT_ID` / `_SECRET` | — | Facebook sign-in. |
| `IPODROCKS_CF_ACCESS_TEAM_DOMAIN` / `_AUD` | — | Verify Cloudflare Access assertions. |

OAuth client secrets are environment-only on purpose. They belong to someone
else's console and have no business in a file the app rewrites on every settings
save — and the encrypted-prefs route is precisely the one that does not survive
the move from Electron to a daemon.

## Troubleshooting

**`Cannot find module` or a missing `.node` at startup.** The install skipped
`better-sqlite3`'s prebuilt binary, which happens if the package was installed
for a platform or architecture other than the one it is running on. Reinstall on
the target machine rather than copying `node_modules` across.

**Everyone is logged out after a restart.** `IPODROCKS_SESSION_SECRET` is unset,
so a random one was generated at boot.

**Social sign-in buttons are missing.** No provider credentials, or no
`IPODROCKS_PUBLIC_URL`. A local password account works without either and is the
right answer for a LAN install.

**"This account is not authorized to use this server."** The login worked and
the allowlist refused it. The owner has to add that identity.

**The device never connects, or the app loads but nothing updates.** The
WebSocket upgrade is refused when the request's `Origin` is not `publicUrl` or
one of `IPODROCKS_ALLOWED_ORIGINS` — and an *absent* `Origin` is refused too,
rather than read as same-origin. Check that `IPODROCKS_PUBLIC_URL` matches the
hostname you are actually typing, scheme and port included.

**Everything reads fine but nothing can be saved ("Cross-origin request
refused").** Same list, same cause, one step further in: an API request that
changes something is refused from an origin this server does not serve. Reading
still works, which is what makes it look like a permissions problem rather than
a hostname one. Set `IPODROCKS_PUBLIC_URL` to the address you actually type, or
add it to `IPODROCKS_ALLOWED_ORIGINS`.

**Musepack profiles are greyed out.** No `mpcenc`. The startup log says so.

**A sync is unbearably slow.** Every byte goes server → browser → device.
Transcode once into a shadow library on the server and sync a selection rather
than the whole library.
