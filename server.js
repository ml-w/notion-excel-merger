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

app.post("/api/notion-merge/databases/list", async (req, res) => {
  const token = getToken(req);
  
  try {
    // Notion doesn't have a direct "list databases" endpoint, but we can search for databases
    const searchResponse = await fetch(`${NOTION_BASE}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          value: "database",
          property: "object"
        },
        page_size: 100
      })
    });
    
    if (!searchResponse.ok) {
      return res.status(searchResponse.status).json({ 
        error: `Failed to search databases: ${searchResponse.statusText}` 
      });
    }
    
    const searchData = await searchResponse.json();
    
    // Extract database info: id and title
    const databases = searchData.results.map(db => {
      const title = db.title?.[0]?.plain_text || db.title?.map(t => t.plain_text).join('') || 'Untitled Database';
      return {
        id: db.id,
        title: title,
        url: db.url,
        created_time: db.created_time,
        last_edited_time: db.last_edited_time
      };
    });
    
    res.json({ databases });
  } catch (err) {
    console.error("Database listing error:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/notion-merge/databases/schema", async (req, res) => {
  const token = getToken(req);
  const { database_id } = req.body;
  
  try {
    const dbResponse = await fetch(`${NOTION_BASE}/databases/${database_id}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
    });
    
    if (!dbResponse.ok) {
      return res.status(dbResponse.status).json({ 
        error: `Failed to retrieve database: ${dbResponse.statusText}` 
      });
    }
    
    const dbData = await dbResponse.json();
    
    // Convert Notion database properties to JSON Schema
    const jsonSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      title: dbData.title?.[0]?.plain_text || "Notion Database",
      description: `JSON Schema for Notion database: ${database_id}`,
      properties: {},
      required: []
    };
    
    // Convert each property to JSON Schema format
    for (const [propName, propDef] of Object.entries(dbData.properties)) {
      const schemaProperty = convertNotionPropertyToJsonSchema(propName, propDef);
      jsonSchema.properties[propName] = schemaProperty;
      
      // Add required fields (titles are typically required)
      if (propDef.type === "title") {
        jsonSchema.required.push(propName);
      }
    }
    
    res.json(jsonSchema);
  } catch (err) {
    console.error("Schema extraction error:", err);
    res.status(500).json({ error: String(err) });
  }
});

function convertNotionPropertyToJsonSchema(propName, propDef) {
  const baseProperty = {
    title: propName,
    description: `Notion ${propDef.type} property`
  };
  
  switch (propDef.type) {
    case "title":
    case "rich_text":
      return {
        ...baseProperty,
        type: "string"
      };
      
    case "number":
      return {
        ...baseProperty,
        type: "number"
      };
      
    case "email":
      return {
        ...baseProperty,
        type: "string",
        format: "email"
      };
      
    case "url":
      return {
        ...baseProperty,
        type: "string",
        format: "uri"
      };
      
    case "phone_number":
      return {
        ...baseProperty,
        type: "string",
        pattern: "^[+]?[0-9\\s\\-\\(\\)]+$"
      };
      
    case "select":
      const selectOptions = propDef.select?.options || [];
      return {
        ...baseProperty,
        type: "string",
        enum: selectOptions.map(opt => opt.name),
        description: `${baseProperty.description}. Available options: ${selectOptions.map(opt => opt.name).join(", ")}`
      };
      
    case "multi_select":
      const multiSelectOptions = propDef.multi_select?.options || [];
      return {
        ...baseProperty,
        type: "array",
        items: {
          type: "string",
          enum: multiSelectOptions.map(opt => opt.name)
        },
        uniqueItems: true,
        description: `${baseProperty.description}. Available options: ${multiSelectOptions.map(opt => opt.name).join(", ")}`
      };
      
    case "date":
      return {
        ...baseProperty,
        type: "string",
        format: "date"
      };
      
    case "checkbox":
      return {
        ...baseProperty,
        type: "boolean"
      };
      
    case "status":
      const statusOptions = propDef.status?.options || [];
      return {
        ...baseProperty,
        type: "string",
        enum: statusOptions.map(opt => opt.name),
        description: `${baseProperty.description}. Available statuses: ${statusOptions.map(opt => opt.name).join(", ")}`
      };
      
    case "people":
      return {
        ...baseProperty,
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            email: { type: "string", format: "email" }
          }
        }
      };
      
    case "files":
      return {
        ...baseProperty,
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            url: { type: "string", format: "uri" }
          }
        }
      };
      
    case "relation":
      return {
        ...baseProperty,
        type: "array",
        items: {
          type: "string",
          description: "Related page ID"
        },
        description: `${baseProperty.description}. Relation to database: ${propDef.relation?.database_id || "unknown"}`
      };
      
    case "formula":
      return {
        ...baseProperty,
        type: ["string", "number", "boolean", "null"],
        readOnly: true,
        description: `${baseProperty.description}. Computed formula result`
      };
      
    case "rollup":
      return {
        ...baseProperty,
        type: ["string", "number", "boolean", "array", "null"],
        readOnly: true,
        description: `${baseProperty.description}. Rollup value from related database`
      };
      
    case "created_time":
    case "last_edited_time":
      return {
        ...baseProperty,
        type: "string",
        format: "date-time",
        readOnly: true
      };
      
    case "created_by":
    case "last_edited_by":
      return {
        ...baseProperty,
        type: "object",
        readOnly: true,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string", format: "email" }
        }
      };
      
    default:
      return {
        ...baseProperty,
        type: "string",
        description: `${baseProperty.description}. Unknown property type: ${propDef.type}`
      };
  }
}

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
