#!/usr/bin/env node
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

app.use(express.json());

// Allow CORS for API routes so the app can call the proxy from the browser
app.use("/api/notion-merge", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function getToken(req) {
  const header = req.headers["authorization"];
  if (header && header.startsWith("Bearer ")) {
    return header.slice(7);
  }
  return process.env.NOTION_TOKEN || "";
}

async function notionRequest(res, notionPath, method, body, token) {
  try {
    const r = await fetch(`${NOTION_BASE}${notionPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (err) {
    res.status(500).send(String(err));
  }
}

app.post("/api/notion-merge/databases/retrieve", async (req, res) => {
  const token = getToken(req);
  const { database_id } = req.body;
  await notionRequest(res, `/databases/${database_id}`, "GET", undefined, token);
});

app.post("/api/notion-merge/databases/query", async (req, res) => {
  const token = getToken(req);
  const { database_id, start_cursor, page_size } = req.body;
  const body = {};
  if (start_cursor) body.start_cursor = start_cursor;
  if (page_size) body.page_size = page_size;
  await notionRequest(
    res,
    `/databases/${database_id}/query`,
    "POST",
    Object.keys(body).length ? body : undefined,
    token
  );
});

app.patch("/api/notion-merge/databases/update", async (req, res) => {
  const token = getToken(req);
  const { database_id, properties } = req.body;
  await notionRequest(res, `/databases/${database_id}`, "PATCH", { properties }, token);
});

app.patch("/api/notion-merge/pages/update", async (req, res) => {
  const token = getToken(req);
  const { page_id, properties } = req.body;
  await notionRequest(res, `/pages/${page_id}`, "PATCH", { properties }, token);
});

app.post("/api/notion-merge/pages/create", async (req, res) => {
  const token = getToken(req);
  await notionRequest(res, `/pages`, "POST", req.body, token);
});

// Serve the built frontend if available
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
