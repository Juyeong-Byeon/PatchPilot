FROM node:22-alpine
RUN apk add --no-cache docker-cli git openssh-client
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm install
RUN npm run build --workspace @ticket-to-pr/core --workspace @ticket-to-pr/db --workspace @ticket-to-pr/queue --workspace @ticket-to-pr/runner-contract --workspace @ticket-to-pr/worker
CMD ["node", "apps/worker/dist/index.js"]
