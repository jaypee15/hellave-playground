FROM node:22-alpine AS build
WORKDIR /app
# Lockfile included so npm ci can run: it installs exactly what is pinned and fails
# loudly if package.json and the lockfile disagree.
# vendor/ holds the packed @hellave/js-sdk tarball referenced by package.json, so it
# must be present before install resolves dependencies.
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
# server/ must sit next to dist/: server/index.ts resolves static assets via
# resolve(__dirname, "../dist").
COPY --from=build /app/server ./server
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/vendor ./vendor
RUN npm ci --omit=dev
ENV NODE_ENV=production
# The host (Render/Fly) injects PORT; server/index.ts falls back to 3001.
EXPOSE 3001
CMD ["npm", "start"]
