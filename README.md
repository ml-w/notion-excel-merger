# Notion Excel Merger

A small web application for merging Excel spreadsheets into a Notion database.
It includes a lightweight backend proxy so the browser can talk to the Notion
API without CORS issues.

## Installation

```bash
npm install
```

## Start

### Development

Run the web app and proxy server together:

```bash
npm run dev
```

This starts the Vite dev server and the Express proxy concurrently
(`http://localhost:5173` with API requests forwarded to `localhost:3000`).

### Production

Build and serve the compiled app:

```bash
npm run build
npm start
```

`npm start` serves the built files on <http://localhost:3000> and proxies
`/api/notion-merge` requests to the Notion API. Supply a Notion token in the UI
or set the `NOTION_TOKEN` environment variable before starting.
