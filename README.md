# Hellave Playground

A React playground for testing the Hellave real-time communication SDK.

## Prerequisites

- Node.js 18+
- A Hellave API key

## Setup

```bash
# Install dependencies
npm install

# Set your Hellave API key
cp .env .env.local
# Edit .env.local with your HELLAVE_API_KEY
```

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
HELLAVE_API_KEY=your-key HELLAVE_BASE_URL=https://hellave-api.maiaddy.com node server/index.js
```

## Usage

1. Click "Create a Room" — enter your name and peer ID
2. Share the Room Instance ID from the conference view with others
3. Others click "Join a Room" and paste the Room Instance ID
4. Once admitted, click "Publish Mic" to share audio
