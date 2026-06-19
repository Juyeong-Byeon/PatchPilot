FROM node:22-alpine
RUN apk add --no-cache git openssh-client bash
RUN addgroup -S runner && adduser -S runner -G runner
WORKDIR /opt/runner
COPY package*.json /opt/runner/
COPY packages /opt/runner/packages
COPY apps/runner /opt/runner/apps/runner
RUN npm install
RUN npm run build --workspace @ticket-to-pr/core --workspace @ticket-to-pr/runner-contract --workspace @ticket-to-pr/runner
USER runner
CMD ["node", "apps/runner/dist/main.js"]
