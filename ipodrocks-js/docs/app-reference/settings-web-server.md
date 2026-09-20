# Settings — Web Server

The Web Server card turns iPodRocks into a web app. With it on, the same
interface you use on the desktop is served to a browser: the same library, the
same database, the same devices, sync, playlists, ratings and Rocksy. Nothing
is a cut-down companion view — it is the app, reached over HTTP.

The point is to separate three things that have always had to be on one
machine: the **library** (files, database, encoders), the **browser** you drive
it from, and the **player** you plug in. The server keeps the first; the second
can be any computer on your network, or anywhere at all through a tunnel.

## What it does

- **Run the web server** — Starts and stops the listener. The desktop app is
  unaffected either way, and both talk to the same library; you can have the
  window open and a browser connected at the same time.
- **Bind address** — `127.0.0.1` (the default) keeps the server on the machine
  it runs on, which is what you want behind a tunnel. `0.0.0.0` makes it
  reachable from your local network.
- **Port** — Defaults to `8780`.
- **Public URL** — The address people actually reach it on, e.g.
  `https://ipod.example.com`. Sign-in callback URLs are built from it and it is
  the origin the app's WebSocket accepts, so set it before configuring Google,
  GitHub or Facebook sign-in.
- **Apply** — Saves the three fields. A running server keeps its current
  settings until you stop and start it.

## Signing in

**Signing in is not the same as being let in.** Anyone in the world can
complete a Google login; what decides whether they reach your library is an
allowlist of accounts you have approved.

The first person to arrive claims the server. On first start it prints a
one-time claim token to its log, and shows it in this card. Sign in once with
that token and you become the owner; from then on the token is gone and every
other login is checked against the allowlist.

Two ways to sign in:

- **A local password account** works everywhere, including on a home network.
  It is the only option that does, because Google and the others refuse a
  sign-in callback that is not a stable public HTTPS address.
- **Google, GitHub or Facebook** need that public address and a set of
  credentials from the provider's own console, supplied to the server as
  environment variables (`IPODROCKS_GOOGLE_CLIENT_ID` and
  `IPODROCKS_GOOGLE_CLIENT_SECRET`, and the same pattern for
  `GITHUB`/`FACEBOOK`). They are read from the environment rather than saved in
  settings deliberately: someone else's client secret does not belong in a file
  the app rewrites, and a secret saved by the desktop app cannot be read by the
  headless server anyway.

Repeated wrong passwords are throttled — per account first, and much more
loosely per address, so one person mistyping their password cannot lock out the
household.

## Running it without the app

iPodRocks also ships as a headless server, so the machine holding your library
needs no screen, no login session and no Electron:

```
IPODROCKS_DATA_DIR=/srv/ipodrocks \
IPODROCKS_SERVER_HOST=127.0.0.1 \
IPODROCKS_SERVER_PORT=8780 \
npm run server
```

It uses the same data folder, so a daemon and the desktop app on one machine
share a library rather than quietly starting two.

There is a container image, a `docker-compose.yml`, a systemd unit and a
Cloudflare Tunnel walkthrough for this — see
[Deploying the Server](/guide/server-deployment).

## Putting it on the internet

The recommended shape opens **no inbound port at all**: leave the server bound
to `127.0.0.1` and point `cloudflared` at it. Cloudflare terminates TLS, which
gives you the HTTPS address that social sign-in requires and that a browser
needs before it will let a page touch a folder on your disk at all.

If you also enable Cloudflare Access, set `IPODROCKS_CF_ACCESS_TEAM_DOMAIN` and
`IPODROCKS_CF_ACCESS_AUD`. The server then verifies Access's own signed
assertion on every request, so anything that reaches the origin *without* going
through Access is refused — otherwise Access is only a front door with the back
one open.

Any other reverse proxy works too. List its address in
`IPODROCKS_TRUSTED_PROXIES` so the server believes its `X-Forwarded-*` headers;
without that it deliberately ignores them, because a client that can forge one
walks straight past the rate limiter. You can also hand the server your own
certificate with `IPODROCKS_TLS_CERT` and `IPODROCKS_TLS_KEY`.

## How to work with it

1. **Turn it on and note the claim token.** The card shows it while the server
   is unclaimed.
2. **Open the URL in a browser and claim it**, choosing a username and a
   password of at least 12 characters.
3. **Add your library folders.** The folder picker browses the *server's*
   filesystem, because that is where a library lives — it is not the same thing
   as picking a player, which is a folder on the machine you are sitting at.
4. **Set a public URL and a tunnel** if you want to reach it from outside.

## Managing who may sign in

The Web Server card itself shows the claim token and the status; the allowlist is
managed by **asking Rocksy** (see below), or over the HTTP API at
`/api/auth/identities` if you prefer `curl`. A panel for it in Settings is not
built yet.

Either way the rules are the same. The allowlist is the gate, so editing it is
**owner-only** — the account that claimed the server. Everyone else is a full
user of the app and can do everything else; they simply cannot change who else
gets in.

- **See the list** — provider, username or subject, and which one is the owner.
- **Add an account.** A local account needs a username and a password of at
  least 12 characters. A Google, GitHub or Facebook account needs that
  provider's own **stable user id**, not the email address — emails change, and
  matching on one would hand an account to whoever claimed the address next. If
  you do not have it, have the person try signing in once; the refusal is logged
  with the subject the provider sent.
- **Revoke an account** — removes it and signs its browsers out. The owner
  account cannot be removed: a server whose owner is gone has an allowlist
  nobody can edit, including to put an owner back.
- **Sign browsers out without removing the account** — for a lost laptop, or
  after a scare. "Sign everyone out" includes you.

## Ask Rocksy

- "Is the web server running?"
- "Serve iPodRocks on port 9000 and let me reach it from the LAN."
- "Turn on web access."
- "Why can't my partner sign in to the server?"
- "Who can sign in to my server?" / "Is anyone connected right now?"
- "Give my partner an account" *(asks you to confirm first)*
- "Cut off access for that old account" *(asks you to confirm first)*
- "Sign every browser out" *(asks you to confirm first — including yours)*

The last four are owner-only. Asked by anyone else, Rocksy says so and does
nothing; it also never reads a claim token or a password back into the chat.
