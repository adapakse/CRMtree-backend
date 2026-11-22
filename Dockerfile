FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src ./src
# Image tag + commit, shown to the mobile app in GET /api/public/app-config.
ARG BUILD_VERSION=local
ENV BUILD_VERSION=$BUILD_VERSION
EXPOSE 3000
CMD ["node", "src/server.js"]
