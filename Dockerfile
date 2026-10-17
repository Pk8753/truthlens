FROM node:22-slim AS web
WORKDIR /w
COPY frontend/package.json .
RUN npm install
COPY frontend .
RUN npm run build
FROM node:22-slim
WORKDIR /app
COPY backend/package.json .
RUN npm install --omit=dev
COPY backend/server.js .
COPY --from=web /w/dist ./public
CMD ["node","server.js"]
