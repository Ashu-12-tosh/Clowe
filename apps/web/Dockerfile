# Clowe web — production image (build from the REPO ROOT):
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://yourdomain.com \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://yourdomain.com \
#     -t clowe-web .
#
# BOTH build args are REQUIRED. They are baked into the bundle at BUILD time and
# cannot be changed by restarting the container — the only way to change them is
# to rebuild. NEXT_PUBLIC_SITE_URL ends up in sitemap.xml, robots.txt and the OG
# tags; NEXT_PUBLIC_API_URL is the host every browser request goes to.
#
# Omitting them does not leave them blank: Next drops empty env vars and falls
# back to the .env in the build context, so the image would silently ship with
# the builder's localhost URLs. CLOWE_DEPLOY_BUILD below turns that into a build
# failure (see the guard in next.config.mjs).
FROM node:20-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci

COPY packages/shared packages/shared
COPY apps/web apps/web

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
# Marks this as a build that produces a deployable image, so next.config.mjs
# refuses missing or localhost URLs. A plain local `npm run build` has no such
# marker and keeps working off the localhost fallback.
ENV CLOWE_DEPLOY_BUILD=1

RUN npm run build --workspace=@clowe/shared && npm run build --workspace=@clowe/web

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Next standalone output = server.js + minimal node_modules
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
