FROM node:26-slim

WORKDIR /app

# Install dependencies first (better layer caching). tsx runs the TS directly,
# so no separate build step is needed for this scaffold.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
# Non-secret runtime config; secrets are injected via env at run time.
COPY config ./config
# Gold dataset — served as the /demo page presets.
COPY eval/datasets ./eval/datasets

EXPOSE 8000

# Run unprivileged (the node:20 image ships a `node` user).
RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
