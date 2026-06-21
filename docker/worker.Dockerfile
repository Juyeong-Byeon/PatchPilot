FROM node:22-alpine
RUN apk add --no-cache docker-cli git openssh-client
# git-sha stamps the image with the checkout it was built from. The stale-image
# guard (scripts/status.mjs) compares this label against the current HEAD so a
# worker running on an out-of-date image is caught instead of silently using old
# code. Populated by scripts/docker-build-runtime.mjs; empty for ad-hoc builds.
ARG GIT_SHA=""
LABEL git-sha="${GIT_SHA}"
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN node scripts/build-workspaces-if-source.mjs @ticket-to-pr/core @ticket-to-pr/db @ticket-to-pr/queue @ticket-to-pr/runner-contract @ticket-to-pr/worker
CMD ["node", "apps/worker/dist/index.js"]
