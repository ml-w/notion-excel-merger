# Notion Excel Merger

A small web application for merging Excel spreadsheets into a Notion database.
It includes a lightweight backend proxy so the browser can talk to the Notion
API without CORS issues.

## Installation

```bash
npm install
```

## Start

Start the app and proxy server:

```bash
npm start
```

This serves the compiled app on <http://localhost:3000>. The proxy will forward
requests under `/api/notion-merge` to the Notion API. Supply a Notion token in
the UI or set the `NOTION_TOKEN` environment variable before starting.

For development with hot reloading you can still use Vite:

```bash
npm run dev
```
