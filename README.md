# Hellave Playground

A React playground for testing the Hellave real-time communication SDK.

## Prerequisites

- Node.js 18+
- A Hellave API key

## Setup

```bash
# Install dependencies
npm install

# Set your Hellave API key in .env (git-ignored):
#   HELLAVE_API_KEY=<your key>
#   HELLAVE_BASE_URL=https://hellave-api.maiaddy.com
```

`npm run dev:server` loads `.env` via `tsx --env-file-if-exists=.env`, so a missing
`.env` is fine when the variables are already in the environment. Note that an empty
`HELLAVE_API_KEY=` counts as unset and the server exits with
`HELLAVE_API_KEY is required`.

## Development

```bash
# Terminal 1: Start the backend
npm run dev:server

# Terminal 2: Start Vite dev server
npm run dev
```

Open http://localhost:5173

## Production

```bash
npm run build
npm start          # reads .env if present
```

`npm start` runs the same entrypoint as `dev:server` and serves the built
frontend from `dist/`. Environment variables already present in the environment
win, so no `.env` file is needed:

```bash
HELLAVE_API_KEY=your-key HELLAVE_BASE_URL=https://hellave-api.maiaddy.com npm start
```

## Deployment

The image is self-contained: express serves both the `/api` routes and the built
frontend from `dist/`, so there is no separate static host and no CORS to configure.
`PORT` is read from the environment (`server/index.ts`), falling back to 3001.

Set `HELLAVE_API_KEY` as a **secret**, never as a plain env var — it authenticates
every backend call to the Hellave API.

```bash
# Fly
fly secrets set HELLAVE_API_KEY=<key>
fly deploy                      # uses fly.toml + Dockerfile

# Render: create a service with runtime "Docker", then set
#   HELLAVE_API_KEY   (secret)
#   HELLAVE_BASE_URL  https://hellave-api.maiaddy.com
# PORT is injected automatically.
```

Build locally the way the platform does, to catch host-specific breakage early:

```bash
docker build -t hellave-playground .
docker run --rm -p 3001:3001 -e HELLAVE_API_KEY=<key> hellave-playground
```

## Usage

1. Click "Create a Room" — enter your name and peer ID
2. Share the Room Instance ID from the conference view with others
3. Others click "Join a Room" and paste the Room Instance ID
4. Once admitted, click "Publish Mic" to share audio
