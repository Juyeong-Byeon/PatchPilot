FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm install
RUN npm run build --workspace @ticket-to-pr/core --workspace @ticket-to-pr/db --workspace @ticket-to-pr/queue --workspace @ticket-to-pr/api
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
