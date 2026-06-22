FROM node:22-alpine
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN node scripts/build-workspaces-if-source.mjs @ticket-to-pr/core @ticket-to-pr/db @ticket-to-pr/queue @ticket-to-pr/api @ticket-to-pr/admin

# Build stamp — set late so the npm ci + build layers above stay cached across
# commits. GET /api/version reads these back so the admin's bottom-left
# VersionBadge shows exactly which build is serving. Supplied via docker-compose
# build args (see scripts/build-stamp.mjs); both default to empty for a bare build.
ARG APP_VERSION=""
ARG GIT_SHA=""
ENV APP_VERSION=$APP_VERSION
ENV GIT_SHA=$GIT_SHA

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
