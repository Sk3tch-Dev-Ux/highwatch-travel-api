# The Travel API in a container. compose.yaml runs it beside MongoDB.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
COPY LICENSE ./
USER node
EXPOSE 6070
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:6070/healthz || exit 1
CMD ["node", "src/server.mjs"]
