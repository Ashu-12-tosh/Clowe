# Clowe API — production image (build from the REPO ROOT):
#   docker build -f apps/api/Dockerfile -t clowe-api .
FROM node:20-alpine AS build
WORKDIR /repo

# Prisma chooses its engine binaries by detecting the OpenSSL version, and it
# does that twice: once here when npm ci runs its postinstall, and again in the
# runtime stage when the CLI starts. Alpine 3.23 ships OpenSSL 3 but not the
# `openssl` package, so the detection finds nothing, warns, and falls back to
# the OpenSSL 1.1 engines — which need libssl.so.1.1, a library Alpine dropped
# in 3.17 and publishes no compat package for. The container then dies at boot
# on `prisma migrate deploy` with a schema engine that cannot load.
RUN apk add --no-cache openssl

# Install all workspace deps (cached while package files are unchanged)
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci

# Build shared + api, generate the Prisma client
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build --workspace=@clowe/shared \
  && npx prisma generate --schema apps/api/prisma/schema.prisma \
  && npm run build --workspace=@clowe/api

# Trim dev dependencies for the runtime image
RUN npm prune --omit=dev

FROM node:20-alpine
WORKDIR /repo
ENV NODE_ENV=production

# Same detection runs again here, for the schema engine that migrate deploy uses.
RUN apk add --no-cache openssl

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/shared/package.json ./packages/shared/
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma

WORKDIR /repo/apps/api
EXPOSE 4000
# Apply migrations, then start. Uploads persist via the volume mounted at ./uploads.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
