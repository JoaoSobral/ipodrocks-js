# Setting up the server, end to end

This page takes you from nothing to "my iPod is plugged into my laptop and
syncing from the library on my NAS." It covers both ways of running the server
and every sign-in option.

If you only want the shape of the thing first:

```
  the machine with your music            the machine you are sitting at
  ───────────────────────────            ──────────────────────────────
  library + SQLite + ffmpeg   ──HTTPS──▶  a browser tab   ──USB──▶  your iPod
  the sync engine             ◀──WS────   holds the player
```

## Step 1 — decide how the server runs

There are two, and they are the *same server* — the same handlers, the same
database, the same sync engine. Pick on how the machine is used, not on
features.

**A. The desktop app hosts it.** You already run iPodRocks on the machine with
your music, and you want to reach it from elsewhere sometimes. Turn on
**Settings → Web Server**. The window and the browser talk to one library at the
same time; nothing is duplicated.

**B. A headless daemon.** The machine has no screen, or you want it up without
anyone logged in — a NAS, a home server, a container. No Electron is involved at
all.

You can switch later. Both read the same data directory, so a machine can run
one and then the other; just do not run both at once against the same folder.

## Step 2 — start it

### A. From the desktop app

Settings → Web Server → **Run the web server**.

- **Bind address** — leave `127.0.0.1` if a tunnel or reverse proxy will be in
  front (recommended). `0.0.0.0` makes it reachable from your local network.
- **Port** — `8780` by default.
- **Public URL** — fill this in once you have a real address (step 4). Sign-in
  callbacks are built from it.

Press **Apply**, then start the server. The card shows the URL and, on first
run, the one-time claim token.

### B. As a daemon

From a checkout:

```sh
cd ipodrocks-js
npm ci --ignore-scripts     # --ignore-scripts skips Electron's binary download
npm run build

IPODROCKS_DATA_DIR=/srv/ipodrocks \
IPODROCKS_SERVER_HOST=127.0.0.1 \
IPODROCKS_SERVER_PORT=8780 \
IPODROCKS_SESSION_SECRET="$(openssl rand -base64 48)" \
npm run server
```

Or with Docker:

```sh
docker build -t ipodrocks-server .
docker run -d --name ipodrocks \
  -p 127.0.0.1:8780:8780 \
  -v ipodrocks-data:/data \
  -v /srv/music:/music:ro \
  -e IPODROCKS_SESSION_SECRET="$(openssl rand -base64 48)" \
  ipodrocks-server
```

For a compose file, a systemd unit and the full environment reference, see
[Deploying the Server](/guide/server-deployment).

::: tip Set `IPODROCKS_SESSION_SECRET`
Without it a new one is generated at every boot, which logs everyone out on
every restart.
:::

## Step 3 — claim it

The first person to sign in cannot be checked against an allowlist, because the
allowlist is empty. So the server prints a **one-time claim token**:

```
  ┌─ First run ────────────────────────────────────────────────┐
  │ This server has no owner yet. Open it in a browser and     │
  │ sign in with this one-time claim token:                    │
  │   xXk3…                                                    │
```

`docker logs ipodrocks`, `journalctl -u ipodrocks-server`, or the Settings card
if the desktop app is hosting. Whoever can read that log owns the machine, so
binding the first identity to it grants nothing an attacker did not already
have.

Open the server in a browser, choose a username and a password of at least 12
characters, and paste the token. That account is the **owner** — the only one
that can manage who else gets in. The token is consumed and never printed again.

A local password account works everywhere, including on a home network with no
public hostname. If that is all you need, skip to [step 6](#step-6-add-your-library).

## Step 4 — get a real HTTPS address

You need one for two independent reasons:

1. **No browser will let a page touch a folder on an insecure origin**, so
   remote devices do not work over plain HTTP.
2. **Google, GitHub and Facebook all refuse a sign-in callback** that is not a
   stable public HTTPS URL. None of them will accept `http://192.168.1.10:8780`.

The recommended route opens no inbound port at all.

### Cloudflare Tunnel

1. In the Cloudflare Zero Trust dashboard, create a **named tunnel**.
2. Add a public hostname — say `ipod.example.com` — routed to
   `http://127.0.0.1:8780` (or `http://ipodrocks:8780` for the compose sidecar).
3. Run `cloudflared` on the server with the tunnel's token, or start the
   `tunnel` profile in `docker-compose.yml`.
4. Set the public URL:
   - daemon: `IPODROCKS_PUBLIC_URL=https://ipod.example.com`
   - desktop: Settings → Web Server → Public URL
5. Set `IPODROCKS_TRUSTED_PROXIES` to the tunnel's address and nothing wider —
   the login rate limiter keys on the client address, and a wide-open
   `trust proxy` lets anyone forge one.

Any other reverse proxy works the same way. You can also hand the server its own
certificate with `IPODROCKS_TLS_CERT` and `IPODROCKS_TLS_KEY`.

Restart the server after changing the public URL. It is read at startup, and a
running server keeps the settings it started with.

## Step 5 — sign-in providers (optional)

**Signing in is not the same as being let in.** Anyone on earth can complete a
Google login against your client id and arrive at your callback with a perfectly
valid profile. What decides whether they reach your library is the
[allowlist](#step-7-let-other-people-in) — always, for every provider. Setting
one up does not open anything.

Credentials are **environment variables, never settings**. They belong to
someone else's console and have no business in a file the app rewrites on every
save; and a secret encrypted by the desktop app cannot be read by the daemon
anyway. That applies to both ways of running the server: set them in the
environment the server starts in.

Everything below assumes your public URL is `https://ipod.example.com` —
substitute yours, scheme and all.

### Google

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and pick
   or create a project.
2. **APIs & Services → OAuth consent screen.** Choose **External** unless you
   have a Workspace org. Fill in the app name and a support email. You do not
   need to submit for verification: add yourself (and anyone else who will sign
   in) under **Test users** and leave it in Testing.
3. Scopes: the defaults are enough. iPodRocks asks only for `profile` and
   `email`.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
5. Under **Authorised redirect URIs** add exactly:

   ```
   https://ipod.example.com/api/auth/google/callback
   ```

   It must match to the character — scheme, host, port, path. A trailing slash
   is a different URI.
6. Copy the client ID and client secret into the environment:

   ```sh
   IPODROCKS_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   IPODROCKS_GOOGLE_CLIENT_SECRET=...
   ```

### GitHub

1. **Settings → Developer settings → OAuth Apps → New OAuth App**
   (or an org's settings, for an org-owned app).
2. **Homepage URL**: `https://ipod.example.com`
3. **Authorization callback URL**:

   ```
   https://ipod.example.com/api/auth/github/callback
   ```
4. Generate a client secret and copy both values:

   ```sh
   IPODROCKS_GITHUB_CLIENT_ID=...
   IPODROCKS_GITHUB_CLIENT_SECRET=...
   ```

GitHub shows a secret once. If you lose it, generate another.

### Facebook

1. [developers.facebook.com](https://developers.facebook.com/) → **My Apps →
   Create App**, type **Consumer**.
2. Add the **Facebook Login** product, **Web**.
3. Under Facebook Login → Settings, **Valid OAuth Redirect URIs**:

   ```
   https://ipod.example.com/api/auth/facebook/callback
   ```
4. From **Settings → Basic**, copy the App ID and App Secret:

   ```sh
   IPODROCKS_FACEBOOK_CLIENT_ID=...
   IPODROCKS_FACEBOOK_CLIENT_SECRET=...
   ```

An app in development mode only admits people listed as testers. Facebook also
requires the app be Live and, for public use, reviewed — which for a personal
server is usually more trouble than a local password account is worth.

### Where to put them

**Docker Compose** — a `.env` beside `docker-compose.yml`:

```sh
IPODROCKS_PUBLIC_URL=https://ipod.example.com
IPODROCKS_SESSION_SECRET=...
IPODROCKS_GOOGLE_CLIENT_ID=...
IPODROCKS_GOOGLE_CLIENT_SECRET=...
```

**systemd** — a root-owned file, not the unit:

```sh
sudo install -d -m 0750 -o root -g ipodrocks /etc/ipodrocks
sudoedit /etc/ipodrocks/server.env     # EnvironmentFile= reads this
sudo chmod 0640 /etc/ipodrocks/server.env
sudo chgrp ipodrocks /etc/ipodrocks/server.env
```

`systemctl show` prints `Environment=` lines to any user; `EnvironmentFile=`
contents it does not.

**The desktop app hosting the server** — the variables have to be in the
environment the *app* was launched in. On Linux that is a `.desktop` file or a
wrapper script; on macOS, `launchctl setenv` or launching from a shell that has
them. If that sounds like more trouble than it is worth, it usually is: use a
local password account, which needs no provider at all.

Restart the server after setting any of these. A provider with only half its
pair set is treated as not configured — deliberately, because registering a
strategy with a missing secret makes the server throw at startup with a message
that names neither variable.

### Checking it worked

The login page shows a button per configured provider. If a provider you set up
is missing, the server did not see both variables, or it has no public URL. The
startup log says so:

```
[server] No OAuth provider is configured. Sign in with a local password account…
```

You can also ask Rocksy: *"is the web server running, and which sign-in
providers are set up?"*

## Step 6 — add your library

Sign in and add your library folders as usual. The folder picker browses the
**server's** filesystem, because that is where a library lives.

That is a different question from picking a player, which is a folder on the
machine you are sitting at — see below.

Scan, and optionally build a [shadow library](/app-reference/library). For a
remote device over anything slower than a LAN, a shadow library is the
difference between a comfortable sync and an impossible one.

## Step 7 — let other people in

Only the owner can. A successful Google login by someone not on the allowlist is
refused, which is the entire point.

Ask Rocksy — *"who can sign in to my server?"*, *"give my partner an account"* —
or use the HTTP API:

```sh
curl -b cookies.txt https://ipod.example.com/api/auth/identities
```

For a provider account the **subject** is that provider's own stable user id,
not the email address. If you do not have it, have the person try to sign in
once: the attempt is refused, and the subject the provider sent is in the server
log.

## Step 8 — connect a player

On the machine with the iPod plugged in, open the server in **Chrome, Edge or
another Chromium browser**, go to Devices, and press **+ Add Device**. In a
browser this always adds a *remote device*: there is no mount path to type,
because the folder is on your machine and you pick it with your own browser's
picker.

Save, then press **Connect this player** on its card and choose the player's
root folder — the one holding `Music` and `.rockbox`.

Firefox and Safari cannot do this; neither can iOS. That is not a policy choice,
it is the File System Access API not existing there, and the Add Device form
says so up front.

See [Devices → Remote devices](/app-reference/devices#remote-devices)
for what differs from a local player.

## Troubleshooting

**"This server has no owner yet."** You are signing in without the claim token,
or somebody already claimed it. Check the log.

**"This account is not authorized to use this server."** The login worked and
the allowlist refused it. Working as intended — the owner has to add that
identity.

**A provider's button is missing.** Both its variables must be set, and
`IPODROCKS_PUBLIC_URL` must be set. Restart after changing them.

**`redirect_uri_mismatch`.** The URI registered with the provider does not match
`<public URL>/api/auth/<provider>/callback` exactly. Check the scheme, any port
and the trailing slash.

**Everyone is logged out after a restart.** `IPODROCKS_SESSION_SECRET` is unset.

**Social login bounces straight back to the login page.** Usually the public URL
does not match the address you are actually typing; the session cookie is
`SameSite=Lax` and the origin check is built from `IPODROCKS_PUBLIC_URL`.

**Add Device offers no folder picker / "This browser cannot hold a player."**
Not a Chromium browser, or not on HTTPS.

**A device is listed but everything is greyed out.** It belongs to the other
side: a server-attached player seen from a browser, or a remote device seen from
the desktop app. See
[Devices → Remote devices](/app-reference/devices#remote-devices).
