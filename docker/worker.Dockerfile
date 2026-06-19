FROM node:22-alpine
RUN apk add --no-cache docker-cli git openssh-client
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN node scripts/build-workspaces-if-source.mjs @ticket-to-pr/core @ticket-to-pr/db @ticket-to-pr/queue @ticket-to-pr/runner-contract @ticket-to-pr/worker
CMD ["node", "apps/worker/dist/index.js"]
