# ---------- build stage ----------
FROM node:22-slim AS build
WORKDIR /app

# native module toolchain (only needed if a prebuild is unavailable for the platform)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# prune to production dependencies
RUN npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

RUN groupadd -r slate && useradd -r -g slate -d /app slate \
    && mkdir -p /data && chown slate:slate /data

WORKDIR /app
COPY --from=build --chown=slate:slate /app/build ./build
COPY --from=build --chown=slate:slate /app/node_modules ./node_modules
COPY --from=build --chown=slate:slate /app/package.json ./package.json

USER slate
EXPOSE 3000
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "build/index.js"]
