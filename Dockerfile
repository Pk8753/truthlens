FROM node:22-slim AS web
WORKDIR /w
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./
COPY --from=web /w/dist ./public
EXPOSE 8080
CMD ["node", "server.js"]
