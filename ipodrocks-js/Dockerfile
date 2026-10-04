# iPodRocks — headless server (`src/server/daemon.ts`)
#
# The container runs the daemon, never Electron.
#
# **Two flavours, one file.** The final stage is chosen with `--target`:
#
#   distroless (default) — gcr.io/distroless/nodejs on Debian 13. Node, glibc,
#                          CA certificates and nothing else: no shell at all.
#   alpine               — node:alpine (musl). Tiny, and has a shell and `apk`
#                          for anyone who wants to poke around inside it.
#
# Both carry the same dist/, the same node_modules and an `mpcenc`; only the OS
# underneath differs. The release workflow publishes `:<version>` from the
# first and `:<version>-alpine` from the second.
#
# **On the native module.** `better-sqlite3` is the only native dependency, and
# since v13 it is a **Node-API** addon shipping per-platform prebuilds inside the
# npm tarball (`prebuilds/linux{,musl}-{x64,arm64}.node` — glibc *and* musl, which
# is why one node_modules serves both flavours). Node-API is ABI-stable across
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

# 24, not 22: the lockfile is written by a current npm, and Node 22's npm 10
# reads vitepress's `@docsearch/react` peer (react <19) as a lockfile mismatch
# and refuses `npm ci` outright. Node 24's npm 11 accepts it, as CI's does.
#
# This is the *build* image only; nothing from it ships except node_modules and
# dist/. Trixie to match the distroless runtime's Debian 13.
ARG NODE_VERSION=24-trixie
# Keep the major in step with NODE_VERSION and the distroless tag below.
ARG NODE_ALPINE_VERSION=24-alpine

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
# encoders — collects the two things the runtime cannot install itself
# ---------------------------------------------------------------------------
# The runtime is distroless: no shell and no package manager, so anything it
# needs beyond Node is staged here and copied across.
#
# `mpcenc` is bundled by nothing (ffmpeg comes from `@ffmpeg-installer/ffmpeg`
# in node_modules, which `getFfmpegPath()` uses whenever `isPackaged()` is false
# — always, under the Node host). Debian's build links only libc and libm, both
# of which the distroless base already carries, so the one binary is all it
# takes; the `ldd` check fails the build if a future package grows a dependency
# that would otherwise only show up as "mpcenc: not found" at runtime.
#
# The `bin` directory holds a `node` symlink, so `docker exec … node
# dist/main/server/cli.js` keeps working: distroless keeps node at
# /nodejs/bin/node, off PATH. `data` is /data pre-owned by the runtime user
# (65532): a fresh volume is seeded from the image, ownership included.
FROM debian:trixie-slim AS encoders
RUN apt-get update \
 && apt-get install -y --no-install-recommends musepack-tools \
 && ldd /usr/bin/mpcenc | awk '$1 !~ /^(linux-vdso|libm|libc|\/lib64\/ld-linux|ld-linux)/ { bad=1; print "unexpected dependency: " $0 } END { exit bad }' \
 && mkdir -p /out/bin /out/data /out/music \
 && cp /usr/bin/mpcenc /out/bin/mpcenc \
 && ln -s /nodejs/bin/node /out/bin/node \
 && chown 65532:65532 /out/data

# ---------------------------------------------------------------------------
# mpcenc-musl — mpcenc compiled from source, because Alpine does not package it
# ---------------------------------------------------------------------------
# The official r475 source (the release mpcenc 1.30.1 comes from), pinned by
# checksum. Only libmpcenc/libmpcpsy/libmpcdec/libwavformat and mpcenc itself
# are built; the other tools need libcuefile/libreplaygain and nothing here
# runs them. It is 2011 C, so three things a modern musl toolchain refuses get
# a nudge, none of which changes the encoder's output — the result decodes to
# the same audio as Debian's build and differs only in the version-stamp bytes:
#
#   -fcommon -fpermissive   GCC 14 made old implicit-declaration and
#                           pointer-type warnings hard errors.
#   empty fpu_control.h     a glibc header musl lacks; mpcenc only uses it on
#                           32-bit x86, so on x86-64/arm64 nothing reads it.
#   -include sys/select.h   glibc pulls `struct timeval` in transitively; musl
#                           does not.
#
# The final step encodes a real WAV, so a toolchain change that breaks the
# encoder fails the image build instead of every Musepack shadow library.
FROM node:${NODE_ALPINE_VERSION} AS mpcenc-musl
ARG MUSEPACK_SRC=https://files.musepack.net/source/musepack_src_r475.tar.gz
ARG MUSEPACK_SHA256=a4b1742f997f83e1056142d556a8c20845ba764b70365ff9ccf2e3f81c427b2b
RUN apk add --no-cache build-base cmake curl ffmpeg
WORKDIR /src
RUN curl -fsSL "$MUSEPACK_SRC" -o musepack.tar.gz \
 && echo "$MUSEPACK_SHA256  musepack.tar.gz" | sha256sum -c - \
 && tar xzf musepack.tar.gz --strip-components=1 \
 && mkdir -p /src/musl-stub && : > /src/musl-stub/fpu_control.h \
 && sed -i \
      -e 's|-pipe"|-pipe -fcommon -fpermissive -I/src/musl-stub -include sys/select.h"|' \
      -e '/add_subdirectory(\(mpcgain\|mpcchap\|mpcdec\|mpc2sv8\|mpccut\|wavcmp\))/d' \
      CMakeLists.txt \
 && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DSHARED=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
 && cmake --build build -j"$(nproc)" \
 && install -m 0755 build/mpcenc/mpcenc /usr/local/bin/mpcenc \
 && ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=2" -ac 2 -ar 44100 /tmp/t.wav \
 && mpcenc --silent --standard /tmp/t.wav /tmp/t.mpc \
 && [ "$(head -c 4 /tmp/t.mpc)" = "MPCK" ]

# ---------------------------------------------------------------------------
# alpine — `docker build --target alpine`
# ---------------------------------------------------------------------------
# `apk upgrade` picks up security fixes published after the base image was
# built. npm, npx, corepack and yarn go, as in the distroless flavour: the
# daemon never runs them, and every Node CVE a scanner found in the old image
# was in the npm the base image bundles — none in the app's own node_modules.
#
# Runs as the base image's `node` user (1000).
FROM node:${NODE_ALPINE_VERSION} AS alpine
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=mpcenc-musl /usr/local/bin/mpcenc /usr/local/bin/mpcenc
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENV IPODROCKS_DATA_DIR=/data \
    IPODROCKS_SERVER_HOST=0.0.0.0 \
    IPODROCKS_SERVER_PORT=8780
EXPOSE 8780

# Owned before VOLUME, for the reason given in the distroless stage below.
RUN mkdir -p /data /music && chown node:node /data
VOLUME ["/data", "/music"]
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.IPODROCKS_SERVER_PORT||8780)+'/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/main/server/daemon.js"]

# ---------------------------------------------------------------------------
# distroless — the default, so it must stay the last stage
# ---------------------------------------------------------------------------
# gcr.io/distroless/nodejs: Node, glibc, CA certificates, tzdata — and nothing
# else. No shell, apt, perl, util-linux or npm, which is where every CVE a
# scanner reported on the old Debian-slim image lived; none were in the app's
# own node_modules. The trade-off is that `docker exec … sh` does not exist —
# `docker exec -it ipodrocks node …` is the way in.
#
# Runs as `nonroot` (65532). The daemon writes only to IPODROCKS_DATA_DIR and
# the OS temp directory, and reads the library; nothing needs privilege.
FROM gcr.io/distroless/nodejs24-debian13:nonroot AS distroless

WORKDIR /app
# Distroless sets no HOME; `nonroot` gets /home/nonroot from /etc/passwd. But a
# `user: "1000:1000"` override — the usual way to make a bind-mounted data dir
# writable — has no passwd entry, so os.homedir() falls back to `/`, and the
# folder picker's "Home" and the path allowlist's home root become `/`. Pinning
# HOME keeps every uid on the same answer.
ENV NODE_ENV=production \
    HOME=/home/nonroot

COPY --from=encoders /out/bin/ /usr/local/bin/
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The library lives here (read-only is fine), the database and prefs here.
# `IPODROCKS_DATA_DIR` is what `node-host.ts` resolves `userData()` from, and it
# is the one variable with no sensible default in a container.
ENV IPODROCKS_DATA_DIR=/data \
    IPODROCKS_SERVER_HOST=0.0.0.0 \
    IPODROCKS_SERVER_PORT=8780
EXPOSE 8780

# /data must be owned by the runtime user *before* VOLUME: anything a later
# step does to a declared volume path is discarded, and a root-owned /data
# leaves the daemon unable to create its database on a fresh volume.
COPY --from=encoders --chown=65532:65532 /out/data /data
COPY --from=encoders /out/music /music
VOLUME ["/data", "/music"]

# `/api/auth/status` is unauthenticated on purpose — it is what the login screen
# renders itself from — so it is the one route a healthcheck can use. Exec form:
# there is no shell to run the string form.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.IPODROCKS_SERVER_PORT||8780)+'/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The base image's entrypoint is node itself.
CMD ["dist/main/server/daemon.js"]
