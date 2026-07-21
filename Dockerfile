FROM node:20-slim

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

CMD ["npm", "start"]
