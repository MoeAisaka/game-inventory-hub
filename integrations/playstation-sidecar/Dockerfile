FROM node:22-alpine AS dependencies
WORKDIR /sidecar
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /sidecar
RUN addgroup -S sidecar && adduser -S -G sidecar sidecar
COPY --from=dependencies --chown=sidecar:sidecar /sidecar/node_modules ./node_modules
COPY --chown=sidecar:sidecar package.json ./
COPY --chown=sidecar:sidecar src ./src
USER sidecar
ENTRYPOINT ["node", "src/main.mjs"]
CMD ["--preview"]
