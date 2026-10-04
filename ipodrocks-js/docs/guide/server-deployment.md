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

Node 24 or newer, and a checkout built with `npm run build`. That is all — the
daemon imports no Electron and needs none installed.

`better-sqlite3`, the only native dependency, ships prebuilt binaries in its npm
package that work unchanged under both Node and Electron, so a tree you also use
for the desktop app will run the daemon as-is and nothing has to be rebuilt
either way.

## Docker

Every GitHub release publishes the daemon to Docker Hub as
[`jpsobral/ipodrocks-server`](https://hub.docker.com/r/jpsobral/ipodrocks-server),
for `linux/amd64` and `linux/arm64` (a Raspberry Pi 4/5, most ARM NAS boxes,
Apple-silicon Docker). Nothing to clone, nothing to build:

```sh
docker pull jpsobral/ipodrocks-server:latest
docker run -d --name ipodrocks \
  -p 127.0.0.1:8780:8780 \
  -v ipodrocks-data:/data \
  -v /srv/music:/music:ro \
  -e IPODROCKS_SESSION_SECRET="$(openssl rand -base64 48)" \
  jpsobral/ipodrocks-server:latest
```

### Two flavours

The same server comes in two images, and you only need one. Both run the same
code, include ffmpeg and the Musepack encoder, run as a non-root user and come
in amd64 and arm64.

| Flavour | Tags | Pick it if… |
|---|---|---|
| **Distroless** (default) | `latest`, `3.1.0`, `3.1` | You just want it to run. Built on Google's distroless image: Node.js and nothing else — no shell, no package manager. |
| **Alpine** | `alpine`, `3.1.0-alpine`, `3.1-alpine` | You want a shell inside the container (`docker exec -it ipodrocks sh`) or simply prefer Alpine. |

Both keep the operating system to the minimum the server needs, which is also
what keeps security scanners quiet.

| Tag | Meaning |
|---|---|
| `latest` / `alpine` | The newest full release. |
| `3.1.0` / `3.1.0-alpine` | That exact release. Pin this if you want upgrades to be a decision. |
| `3.1` / `3.1-alpine` | The newest patch release of 3.1. |
| `3.2.0-beta` / `3.2.0-beta-alpine` | A pre-release. Published only under its own tag; it **never moves `latest` or `alpine`**. |

The image contains the daemon and nothing else — it never runs Electron. The
distroless flavour has no shell, so `docker exec -it ipodrocks sh` does not
work there; `docker exec -it ipodrocks node …` (the [password recovery
command](#troubleshooting), for one) works in both.

### Upgrading

Everything that matters lives in the `/data` volume, so an upgrade is a new
container on the same volume:

```sh
docker pull jpsobral/ipodrocks-server:latest
docker rm -f ipodrocks
docker run -d --name ipodrocks …same flags as before…
```

With compose, `docker compose pull && docker compose up -d`. Database
migrations run on the first start of the new version; take a copy of `/data`
first if you are jumping several releases.

### Building the image yourself

The `Dockerfile` beside `package.json` is what the release builds, both
flavours (`--target distroless`, the default, and `--target alpine`). From a
checkout, in `ipodrocks-js/`:

```sh
npm run docker:distroless    # build + run the default image on http://127.0.0.1:8780
npm run docker:alpine        # build + run the Alpine image on http://127.0.0.1:8781
npm run docker:test          # build both and run the release's smoke test
npm run docker:test -- alpine
```

The two `docker:<flavour>` commands stay in the foreground with the server's
log on screen — the claim token is in it — and Ctrl-C stops and removes the
container. Each keeps its data in its own volume (`ipodrocks-local-<flavour>-data`),
so they can run side by side. Set `IPODROCKS_MUSIC_DIR=/path/to/music` to mount
a library read-only, and `IPODROCKS_SESSION_SECRET` to stay signed in across
restarts.

`docker:test` is the check every release runs before it is tagged: the server
answers, finds `mpcenc`, encodes a real Musepack file inside the container, and
runs as a non-root user.

Plain Docker works too: `docker build --target alpine -t ipodrocks-server .`,
then use `ipodrocks-server` in place of `jpsobral/ipodrocks-server:latest`
above (or `docker compose up -d --build`). The build installs with
`--ignore-scripts`, which skips Electron's ~100 MB binary download.

### Volumes

| Path | What it holds |
|---|---|
| `/data` | `ipodrock.db`, `ipodrocks-server.db`, `ipodrocks-prefs.json`. Losing it loses the library index, every device profile and every login. Back it up. |
| `/music` | Your library. Mount it **read-only** unless you want a shadow library, which writes transcodes next to nothing else. |

`/data` is `IPODROCKS_DATA_DIR`, which is the one variable with no sensible
default in a container — the Node host resolves *everything* it writes from it.

#### Using a host folder instead of a named volume

A named volume (`-v ipodrocks-data:/data`) just works. If you bind-mount a
folder from the host instead — to keep the database somewhere you back up, or to
share it with the desktop app — the container's user must be able to write it.
The images run as a non-root user (uid 65532 in distroless, 1000 in Alpine), so
run the container as the folder's owner:

```sh
docker run … --user "$(id -u):$(id -g)" -v /srv/ipodrocks:/data …
```

or `user: "1000:1000"` in compose. Without it the server stops at startup with
`unable to open database file`.

::: warning Sharing the desktop app's data folder
Pointing `/data` at the desktop app's own folder (`~/.config/ipodrocks` on
Linux) makes the server and the app one install: same library, devices and
logins. **Never run both at once** — it is one SQLite database, and it wants one
writer. Stop the container before opening the app.
:::

### Encoders

`ffmpeg` comes from `@ffmpeg-installer/ffmpeg` in `node_modules`;
`getFfmpegPath()` falls back to it whenever the app is not a packaged Electron
build, which a daemon never is. Nothing further is needed.

`mpcenc` is bundled by nothing, so both images bring their own: the
distroless one copies Debian's build in, and the Alpine one — Alpine does not
package it — compiles it from the official Musepack source while the image is
built. Every published image has passed a real Musepack encode before it is
tagged. Outside the images (a bare-metal install), without it **Musepack shadow-library profiles are unavailable** — the daemon
says so at startup:

```
[server] mpcenc: not found — Musepack shadow-library profiles are unavailable.
```

and the codec picker in the app greys those profiles out, the same way it does
on a desktop install with no `mpcenc` on `PATH`.

### docker-compose

`docker-compose.yml` beside the `Dockerfile` is a starting point. It runs the
published image; you need only that file and a `.env` beside it holding the
variables it references:

```sh
IPODROCKS_VERSION=latest          # or alpine, or pin: 3.1.0 / 3.1.0-alpine
IPODROCKS_SESSION_SECRET=…        # openssl rand -base64 48
IPODROCKS_PUBLIC_URL=https://ipod.example.com
IPODROCKS_MUSIC_DIR=/srv/music
CLOUDFLARE_TUNNEL_TOKEN=…         # only for --profile tunnel
```

```sh
docker compose up -d                       # server only, loopback
docker compose --profile tunnel up -d      # server + cloudflared
```

`IPODROCKS_VERSION` is the image tag, so it also picks the flavour: `latest`
or `3.1.0` for distroless, `alpine` or `3.1.0-alpine` for Alpine. To build your
checkout instead of pulling, run `docker compose up -d --build`; add
`target: alpine` under `build:` for the Alpine flavour.

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
| `IPODROCKS_RESET_OWNER` | — | `1` prints a one-time owner password-reset token at boot. Remove it once used — see [Forgot your password](/guide/server-setup#forgot-your-password). |

OAuth client secrets are environment-only on purpose. They belong to someone
else's console and have no business in a file the app rewrites on every settings
save — and the encrypted-prefs route is precisely the one that does not survive
the move from Electron to a daemon.

## Troubleshooting

**`Cannot find module` or a missing `.node` at startup.** The install skipped
`better-sqlite3`'s prebuilt binary, which happens if the package was installed
for a platform or architecture other than the one it is running on. Reinstall on
the target machine rather than copying `node_modules` across.

**Locked out of the owner account.** Run
`node dist/main/server/cli.js password <username>` on the server
(`docker exec -it` in a container), or boot once with
`IPODROCKS_RESET_OWNER=1`. See [Forgot your password](/guide/server-setup#forgot-your-password).

**Everyone is logged out after a restart.** `IPODROCKS_SESSION_SECRET` is unset,
so a random one was generated at boot.

**Social sign-in buttons are missing.** No provider credentials, or no
`IPODROCKS_PUBLIC_URL`. A local password account works without either and is the
right answer for a LAN install.

**"This account is not authorized to use this server."** The login worked and
the allowlist refused it. The owner approves it under Settings → Web Server →
Waiting for approval.

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
