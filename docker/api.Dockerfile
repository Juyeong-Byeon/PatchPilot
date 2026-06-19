FROM node:22-alpine
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN node scripts/build-workspaces-if-source.mjs @ticket-to-pr/core @ticket-to-pr/db @ticket-to-pr/queue @ticket-to-pr/api @ticket-to-pr/admin
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
