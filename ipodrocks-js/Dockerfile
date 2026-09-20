# iPodRocks — headless server (`src/server/daemon.ts`)
#
# The container runs the daemon, never Electron.
#
# **On the native module.** `better-sqlite3` is the only native dependency, and
# since v13 it is a **Node-API** addon shipping per-platform prebuilds inside the
# npm tarball (`prebuilds/linux-{x64,arm64}.node`). Node-API is ABI-stable across
# both Node versions and Electron, so there is no rebuild to do here and no
# compiler to install — the same `.node` file the desktop app loads is the one
# this image loads. (`electron-builder install-app-deps` in `postinstall` finds
# nothing to build for it either; the module declares `gypfile: false`.)
#
# `--ignore-scripts` is therefore not about the ABI. It skips Electron's own
# ~100 MB binary download, which a headless server has no use for, and the
# `postinstall` that triggers it. The prebuild needs no install script to be
# present, so the module still works — which the build asserts below rather than
# assuming, because a future dependency that *does* need a build step would
# otherwise fail at the first database open in production.

ARG NODE_VERSION=22-bookworm

# ---------------------------------------------------------------------------
# deps — the production tree the runtime stage keeps
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
# Loud here, or silent until someone's first request.
RUN node -e "const D=require('better-sqlite3'); new D(':memory:').close(); console.log('better-sqlite3 loads under plain node')"

# ---------------------------------------------------------------------------
# build — the full tree, only to produce dist/
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime

# ffmpeg comes from `@ffmpeg-installer/ffmpeg` in node_modules — `getFfmpegPath()`
# falls back to it whenever `isPackaged()` is false, which the Node host always
# reports. `mpcenc` is bundled by nothing at all, so without this package the
# Musepack shadow-library profiles are simply unavailable and the daemon says so
# at startup. `musepack-tools` is in Debian main; on a base image that does not
# carry it, drop the package and accept the loss.
RUN apt-get update \
 && apt-get install -y --no-install-recommends musepack-tools ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The library lives here (read-only is fine), the database and prefs here.
# `IPODROCKS_DATA_DIR` is what `node-host.ts` resolves `userData()` from, and it
# is the one variable with no sensible default in a container.
ENV IPODROCKS_DATA_DIR=/data \
    IPODROCKS_SERVER_HOST=0.0.0.0 \
    IPODROCKS_SERVER_PORT=8780
VOLUME ["/data", "/music"]
EXPOSE 8780

# Not root. The daemon writes only to IPODROCKS_DATA_DIR and to the OS temp
# directory, and reads the library; nothing it does needs privilege.
RUN mkdir -p /data /music && chown -R node:node /data
USER node

# `/api/auth/status` is unauthenticated on purpose — it is what the login screen
# renders itself from — so it is the one route a healthcheck can use.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.IPODROCKS_SERVER_PORT||8780)+'/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main/server/daemon.js"]
