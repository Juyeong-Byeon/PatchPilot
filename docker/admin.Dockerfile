FROM node:22-alpine
WORKDIR /app

COPY package*.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps ./apps
RUN npm ci

EXPOSE 5173
CMD ["npm", "--workspace", "@ticket-to-pr/admin", "run", "dev", "--", "--host", "0.0.0.0"]
