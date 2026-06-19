FROM node:22-alpine
RUN apk add --no-cache git openssh-client bash
ARG GSTACK_INSTALL_COMMAND=""
RUN if [ -n "$GSTACK_INSTALL_COMMAND" ]; then sh -lc "$GSTACK_INSTALL_COMMAND"; fi
RUN addgroup -S runner && adduser -S runner -G runner
WORKDIR /opt/runner
COPY package*.json tsconfig.base.json /opt/runner/
COPY scripts /opt/runner/scripts
COPY packages /opt/runner/packages
COPY apps /opt/runner/apps
RUN npm ci
RUN node scripts/build-workspaces-if-source.mjs @ticket-to-pr/core @ticket-to-pr/runner-contract @ticket-to-pr/runner
USER runner
CMD ["node", "apps/runner/dist/main.js"]
