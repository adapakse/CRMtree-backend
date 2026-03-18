# ---------- Base ----------
FROM node:20-alpine AS base
WORKDIR /app

ENV NODE_ENV=production

# ---------- Dependencies ----------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- App ----------
FROM base AS runner

# create non root user
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# remove useless stuff if devs forgot .dockerignore
RUN rm -rf \
    __tests__ \
    .git \
    .github \
    node_modules/.cache

USER nodejs

EXPOSE 3000

CMD ["node", "src/server.js"]