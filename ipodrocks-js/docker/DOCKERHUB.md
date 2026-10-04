# iPodRocks server

The headless [iPodRocks](https://github.com/JoaoSobral/ipodrocks-js) daemon: your
music library, its database and the encoders live on this server, and you sync
a Rockbox player from a browser on whatever machine it is plugged into.

Images are published for `linux/amd64` and `linux/arm64` on every GitHub release.

## Quick start

```sh
docker run -d --name ipodrocks \
  -p 127.0.0.1:8780:8780 \
  -v ipodrocks-data:/data \
  -v /srv/music:/music:ro \
  -e IPODROCKS_SESSION_SECRET="$(openssl rand -base64 48)" \
  jpsobral/ipodrocks-server:latest

docker logs ipodrocks   # the one-time claim token that makes you the owner
```

Open `http://127.0.0.1:8780` and sign in with the token. Do not publish the port
to a network over plain HTTP — put it behind TLS, a reverse proxy or a
Cloudflare Tunnel.

## Flavours

| Flavour | Tags | |
|---|---|---|
| **Distroless** (default) | `latest`, `3.1.0`, `3.1` | Node.js and nothing else — no shell, no package manager |
| **Alpine** | `alpine`, `3.1.0-alpine`, `3.1-alpine` | Alpine Linux, with a shell |

Both are the same server, include ffmpeg and the Musepack encoder (`mpcenc`),
run as a non-root user, and are built for amd64 and arm64.
Pre-releases (e.g. `3.2.0-beta`, `3.2.0-beta-alpine`) never move `latest` or
`alpine`.

## Volumes

| Path | Holds |
|---|---|
| `/data` | Database, prefs, sessions. Back it up. |
| `/music` | Your library. Read-only unless you use a shadow library. |

## Documentation

- [Setting up the server, end to end](https://joaosobral.github.io/ipodrocks-js/guide/server-setup)
- [Deploying the server](https://joaosobral.github.io/ipodrocks-js/guide/server-deployment) — compose, Cloudflare Tunnel, systemd, every environment variable

License: GPL-3.0.
