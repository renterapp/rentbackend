FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package*.json ./
COPY prisma ./prisma
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run prisma:generate \
    && npm run build \
    && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Swagger reads annotations from the TypeScript sources at runtime.
COPY --from=build /app/src ./src
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
