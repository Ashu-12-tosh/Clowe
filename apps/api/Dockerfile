# Clowe API — production image (build from the REPO ROOT):
#   docker build -f apps/api/Dockerfile -t clowe-api .
FROM node:20-alpine AS build
WORKDIR /repo

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
