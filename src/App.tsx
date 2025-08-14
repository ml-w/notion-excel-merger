import React, { useMemo, useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Upload,
  Database,
  PlayCircle,
  Eye,
  ShieldCheck,
  RefreshCw,
  FileSpreadsheet,
  PlugZap,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

// shadcn/ui components
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// Libraries
import * as XLSX from "xlsx";

/**
 * IMPORTANT CHANGE (Fixes your error):
 * -----------------------------------
 * Previously this component imported and used `@notionhq/client` directly in the browser.
 * Notion's SDK is server-only and its browser usage can cause runtime issues (and CORS).
 * The error you hit — "'fetch' called on an object that does not implement interface Window" —
 * is a symptom of calling server-side fetch implementations in a browser context.
 *
 * This rewrite removes all direct Notion SDK calls from the UI and introduces two modes:
 * 1) MOCK MODE (default): Works entirely in-browser with fake Notion data so you can preview joins.
 * 2) PROXY MODE: Calls your own backend (e.g., /api/notion-merge/*) that uses @notionhq/client safely server-side.
 *
 * How to use PROXY MODE locally (Vite/Next/Express):
 * - Provide an HTTP endpoint for the following routes (examples below):
 *   POST {baseUrl}/databases/retrieve   body: { database_id }
 *   POST {baseUrl}/databases/query      body: { database_id, start_cursor? }
 *   PATCH {baseUrl}/databases/update    body: { database_id, properties }
 *   PATCH {baseUrl}/pages/update        body: { page_id, properties }
 *   POST {baseUrl}/pages/create         body: { parent: { database_id }, properties }
 * - Keep your Notion token on the server only.
 */

// -------------------------------
// Types
// -------------------------------

type ExcelRow = Record<string, any>;

type JoinType = "left" | "right" | "inner" | "outer";

type Mapping = {
  id: string;
  excelColumn: string;
  notionProperty: string; // Notion DB property name
};

type NotionPropertyDef = {
  name: string;
  type: string;
  options?: Array<{ id?: string; name: string; color?: string }>; // for select/multi_select/status
};

type NotionDatabase = {
  id: string;
  properties: Record<string, { type: string; [k: string]: any }>;
};

type NotionPage = {
  id: string;
  properties: Record<string, any>;
};

type Plan =
  | { key: string; action: "update"; excel: ExcelRow; page: NotionPage; changes: Record<string, any> }
  | { key: string; action: "create"; excel: ExcelRow; changes: Record<string, any> }
  | { key: string; action: "skip"; excel?: ExcelRow; page?: NotionPage; reason: string };

// -------------------------------
// Utils
// -------------------------------

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function getNotionPropertyPlainValue(prop: any): string | number | null {
  if (!prop) return null;
  const type = prop.type;
  const v = prop[type];
  if (v == null) return null;
  switch (type) {
    case "title":
      return (v?.[0]?.plain_text ?? "").trim();
    case "rich_text":
      return (v?.[0]?.plain_text ?? "").trim();
    case "number":
      return typeof v === "number" ? v : Number(v ?? NaN);
    case "email":
    case "url":
    case "phone_number":
      return v ?? null;
    case "select":
      return v?.name ?? null;
    case "multi_select":
      return Array.isArray(v) ? v.map((x: any) => x?.name).filter(Boolean).join(", ") : null;
    case "date":
      return v?.start ?? null;
    case "checkbox":
      return v ? "true" : "false";
    case "status":
      return v?.name ?? null;
    default:
      return null;
  }
}

function buildNotionPropertyValue(targetType: string, value: any, { createMultiFromCSV = true }: { createMultiFromCSV?: boolean } = {}) {
  if (value === undefined || value === null) return undefined as any;
  switch (targetType) {
    case "title":
      return { title: [{ type: "text", text: { content: String(value) } }] };
    case "rich_text":
      return { rich_text: [{ type: "text", text: { content: String(value) } }] };
    case "number": {
      const n = Number(value);
      return isFinite(n) ? { number: n } : undefined;
    }
    case "email":
      return { email: String(value) };
    case "url":
      return { url: String(value) };
    case "phone_number":
      return { phone_number: String(value) };
    case "select":
      return { select: value === "" || value == null ? null : { name: String(value) } };
    case "multi_select": {
      if (Array.isArray(value)) return { multi_select: value.map((x) => ({ name: String(x) })) };
      if (typeof value === "string" && createMultiFromCSV) {
        return { multi_select: value.split(/[,;]\s*/).filter(Boolean).map((name) => ({ name })) };
      }
      return { multi_select: [] };
    }
    case "date": {
      const d = new Date(value);
      if (!isNaN(d.getTime())) return { date: { start: d.toISOString().slice(0, 10) } };
      return undefined;
    }
    case "checkbox": {
      const truthy = [true, "true", "1", 1, "yes", "y"]; const falsy = [false, "false", "0", 0, "no", "n", ""];
      if (truthy.includes(value)) return { checkbox: true };
      if (falsy.includes(value)) return { checkbox: false };
      return undefined;
    }
    case "status":
      return { status: { name: String(value) } };
    default:
      return { rich_text: [{ type: "text", text: { content: String(value) } }] };
  }
}

async function pMapSerial<T, R>(items: T[], fn: (item: T, idx: number) => Promise<R>, delayMs = 350) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i++) {
    out.push(await fn(items[i], i));
    if (delayMs > 0 && i < items.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return out;
}

// -------------------------------
// MOCK BACKEND (works in Canvas & Browser without CORS)
// -------------------------------

type MockState = {
  db: NotionDatabase | null;
  pages: NotionPage[];
};

const makeMock = (): MockState => ({
  db: {
    id: "mock-db",
    properties: {
      Key: { type: "title", title: {} },
      Status: { type: "select", select: { options: [{ name: "New" }, { name: "Done" }] } },
      Tags: { type: "multi_select", multi_select: { options: [{ name: "red" }, { name: "blue" }] } },
      Amount: { type: "number", number: {} },
      Note: { type: "rich_text", rich_text: {} },
    },
  },
  pages: [
    {
      id: "p1",
      properties: {
        Key: { type: "title", title: [{ type: "text", text: { content: "A001" }, plain_text: "A001" }] },
        Status: { type: "select", select: { name: "New" } },
        Tags: { type: "multi_select", multi_select: [{ name: "red" }] },
        Amount: { type: "number", number: 10 },
        Note: { type: "rich_text", rich_text: [{ type: "text", text: { content: "hello" }, plain_text: "hello" }] },
      },
    },
    {
      id: "p2",
      properties: {
        Key: { type: "title", title: [{ type: "text", text: { content: "A002" }, plain_text: "A002" }] },
        Status: { type: "select", select: { name: "Done" } },
        Tags: { type: "multi_select", multi_select: [{ name: "blue" }] },
        Amount: { type: "number", number: 5 },
        Note: { type: "rich_text", rich_text: [] },
      },
    },
  ],
});

function createMockApi(state: MockState) {
  return {
    async retrieveDatabase(database_id: string): Promise<NotionDatabase> {
      if (!state.db || state.db.id !== database_id) throw new Error("Database not found (mock)");
      return state.db;
    },
    async queryDatabase(database_id: string): Promise<{ results: NotionPage[]; has_more: boolean; next_cursor?: string }>{
      if (!state.db || state.db.id !== database_id) throw new Error("Database not found (mock)");
      return { results: state.pages, has_more: false };
    },
    async updateDatabase(database_id: string, properties: any): Promise<void> {
      if (!state.db || state.db.id !== database_id) throw new Error("Database not found (mock)");
      state.db.properties = { ...state.db.properties, ...properties };
    },
    async updatePage(page_id: string, properties: any): Promise<void> {
      const p = state.pages.find((x) => x.id === page_id);
      if (!p) throw new Error("Page not found (mock)");
      p.properties = { ...p.properties, ...properties };
    },
    async createPage(database_id: string, properties: any): Promise<void> {
      if (!state.db || state.db.id !== database_id) throw new Error("Database not found (mock)");
      const id = uid();
      state.pages.push({ id, properties });
    },
  };
}

// -------------------------------
// PROXY BACKEND (server route you host)
// -------------------------------

function createProxyApi(baseUrl: string, token: string) {
  // The token should be stored on your server. The UI passes no token by default.
  const headers: HeadersInit = { "Content-Type": "application/json", Authorization: token ? `Bearer ${token}` : "" };
  return {
    async retrieveDatabase(database_id: string): Promise<NotionDatabase> {
      const r = await fetch(`${baseUrl}/databases/retrieve`, { method: "POST", headers, body: JSON.stringify({ database_id }) });
      if (!r.ok) throw new Error(await r.text());
      return (await r.json()) as NotionDatabase;
    },
    async queryDatabase(database_id: string): Promise<{ results: NotionPage[]; has_more: boolean; next_cursor?: string }>{
      const r = await fetch(`${baseUrl}/databases/query`, { method: "POST", headers, body: JSON.stringify({ database_id }) });
      if (!r.ok) throw new Error(await r.text());
      return (await r.json()) as any;
    },
    async updateDatabase(database_id: string, properties: any) {
      const r = await fetch(`${baseUrl}/databases/update`, { method: "PATCH", headers, body: JSON.stringify({ database_id, properties }) });
      if (!r.ok) throw new Error(await r.text());
    },
    async updatePage(page_id: string, properties: any) {
      const r = await fetch(`${baseUrl}/pages/update`, { method: "PATCH", headers, body: JSON.stringify({ page_id, properties }) });
      if (!r.ok) throw new Error(await r.text());
    },
    async createPage(database_id: string, properties: any) {
      const r = await fetch(`${baseUrl}/pages/create`, {
        method: "POST",
        headers,
        body: JSON.stringify({ parent: { database_id }, properties }),
      });
      if (!r.ok) throw new Error(await r.text());
    },
  };
}

// -------------------------------
// Main Component
// -------------------------------

export default function NotionExcelMergeApp() {
  // Backend mode
  const [useMock, setUseMock] = useState<boolean>(true); // default to mock so Canvas works
  const [proxyBaseUrl, setProxyBaseUrl] = useState<string>("/api/notion-merge"); // e.g. /api/notion-merge

  // Credentials (kept only in state; for PROXY mode you typically DON'T send token from the browser)
  const [notionToken, setNotionToken] = useState<string>(""); // optional if your proxy expects a bearer
  const [databaseId, setDatabaseId] = useState<string>("mock-db");

  // Excel state
  const [excelRows, setExcelRows] = useState<ExcelRow[]>([]);
  const [excelColumns, setExcelColumns] = useState<string[]>([]);
  const [excelFileName, setExcelFileName] = useState<string>("");

  // Notion-ish state
  const [dbProps, setDbProps] = useState<NotionPropertyDef[]>([]);
  const [pages, setPages] = useState<NotionPage[]>([]);
  const [loadingDb, setLoadingDb] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadSuccess, setLoadSuccess] = useState<string | null>(null);

  // Merge config
  const [joinType, setJoinType] = useState<JoinType>("left");
  const [excelKey, setExcelKey] = useState<string>("");
  const [notionKey, setNotionKey] = useState<string>("Key");
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [onlyUpdateEmpty, setOnlyUpdateEmpty] = useState(false);
  const [createMissingSelectOptions, setCreateMissingSelectOptions] = useState(true);
  const [allowCreatePages, setAllowCreatePages] = useState(false);

  // Execution state
  const [dryRun, setDryRun] = useState<Plan[] | null>(null);
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);

  // API instance
  const mock = useMemo(() => makeMock(), []);
  const api = useMemo(() => (useMock ? createMockApi(mock) : createProxyApi(proxyBaseUrl, notionToken)), [useMock, mock, proxyBaseUrl, notionToken]);

  // -------------------------------
  // Handlers
  // -------------------------------

  const handleExcelUpload: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setExcelFileName(file.name);
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json: ExcelRow[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
    setExcelRows(json);
    const colsSet = json.reduce<Set<string>>((acc, row) => {
      Object.keys(row).forEach((k) => acc.add(k));
      return acc;
    }, new Set<string>());
    const cols = Array.from(colsSet);
    setExcelColumns(cols);
    if (!excelKey && cols.length > 0) setExcelKey(cols[0]);
  };

  async function loadDatabase() {
    setLoadError(null);
    setLoadSuccess(null);
    if (!databaseId.trim()) {
      setLoadError("Database ID is required");
      return;
    }
    if (!useMock && !proxyBaseUrl) {
      setLoadError("Proxy base URL is required in proxy mode");
      return;
    }
    setLoadingDb(true);
    try {
      const db = await api.retrieveDatabase(databaseId.trim());
      const props: NotionPropertyDef[] = Object.entries(db.properties).map(([name, def]: any) => {
        const item: NotionPropertyDef = { name, type: def.type, options: def[def.type]?.options ?? [] };
        return item;
      });
      setDbProps(props);
      if (!notionKey && props.length > 0) setNotionKey(props[0].name);

      const q = await api.queryDatabase(databaseId.trim());
      setPages(q.results);
      setLoadSuccess("Database loaded successfully");
    } catch (err: any) {
      console.error(err);
      setDbProps([]);
      setPages([]);
      setLoadError(err?.message ?? String(err));
    } finally {
      setLoadingDb(false);
    }
  }

  function addMapping() {
    const firstExcel = excelColumns.find((c) => !mappings.some((m) => m.excelColumn === c));
    const firstNotion = dbProps.find((p) => !mappings.some((m) => m.notionProperty === p.name));
    setMappings((m) => [...m, { id: uid(), excelColumn: firstExcel ?? "", notionProperty: firstNotion?.name ?? "" }]);
  }

  function removeMapping(id: string) { setMappings((m) => m.filter((x) => x.id !== id)); }
  function setMapping(id: string, patch: Partial<Mapping>) { setMappings((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : x))); }

  // Index maps for join
  const excelIndex = useMemo(() => {
    const map = new Map<string, ExcelRow>();
    if (!excelKey) return map; for (const row of excelRows) { const keyVal = String(row[excelKey] ?? "").trim(); if (keyVal !== "") map.set(keyVal, row); }
    return map;
  }, [excelRows, excelKey]);

  const notionIndex = useMemo(() => {
    const map = new Map<string, NotionPage>();
    if (!notionKey) return map; for (const pg of pages) {
      const props = (pg as any).properties ?? {};
      const plain = getNotionPropertyPlainValue(props[notionKey]);
      const keyVal = plain != null ? String(plain).trim() : "";
      if (keyVal !== "") map.set(keyVal, pg);
    }
    return map;
  }, [pages, notionKey]);

  const joinSummary = useMemo(() => {
    const leftKeys = new Set(excelIndex.keys());
    const rightKeys = new Set(notionIndex.keys());
    const both = new Set<string>();
    for (const k of leftKeys) if (rightKeys.has(k)) both.add(k);
    const leftOnly = Array.from(leftKeys).filter((k) => !rightKeys.has(k));
    const rightOnly = Array.from(rightKeys).filter((k) => !leftKeys.has(k));
    return { leftCount: leftKeys.size, rightCount: rightKeys.size, bothCount: both.size, leftOnly, rightOnly };
  }, [excelIndex, notionIndex]);

  function buildPlannedUpdates(): Plan[] {
    const keys = new Set<string>();
    const leftKeys = new Set(excelIndex.keys());
    const rightKeys = new Set(notionIndex.keys());

    if (joinType === "left") leftKeys.forEach((k) => keys.add(k));
    else if (joinType === "right") rightKeys.forEach((k) => keys.add(k));
    else if (joinType === "inner") leftKeys.forEach((k) => { if (rightKeys.has(k)) keys.add(k); });
    else if (joinType === "outer") { leftKeys.forEach((k) => keys.add(k)); rightKeys.forEach((k) => keys.add(k)); }

    const plans: Plan[] = [];

    keys.forEach((key) => {
      const excelRow = excelIndex.get(key);
      const page = notionIndex.get(key);
      if (excelRow && page) {
        const changes: Record<string, any> = {};
        for (const m of mappings) {
          const srcVal = excelRow[m.excelColumn];
          if (m.notionProperty) {
            const targetDef = dbProps.find((p) => p.name === m.notionProperty);
            const existingValue = getNotionPropertyPlainValue((page as any).properties[m.notionProperty]);
            if (onlyUpdateEmpty && (existingValue !== null && existingValue !== "")) continue;
            const built = buildNotionPropertyValue(targetDef?.type ?? "rich_text", srcVal);
            if (built !== undefined) changes[m.notionProperty] = built;
          }
        }
        if (Object.keys(changes).length > 0) plans.push({ key, action: "update", excel: excelRow, page, changes });
        else plans.push({ key, action: "skip", excel: excelRow, page, reason: "No changes computed" });
      } else if (excelRow && !page) {
        if ((joinType === "left" || joinType === "outer") && allowCreatePages) {
          const changes: Record<string, any> = {};
          for (const m of mappings) {
            if (!m.notionProperty) continue;
            const targetDef = dbProps.find((p) => p.name === m.notionProperty);
            const srcVal = excelRow[m.excelColumn];
            const built = buildNotionPropertyValue(targetDef?.type ?? "rich_text", srcVal);
            if (built !== undefined) changes[m.notionProperty] = built;
          }
          plans.push({ key, action: "create", excel: excelRow, changes });
        } else {
          plans.push({ key, action: "skip", excel: excelRow, reason: "No matching Notion page" });
        }
      } else if (!excelRow && page) {
        plans.push({ key, action: "skip", page, reason: "No matching Excel row" });
      }
    });

  return plans;
  }

  function onPreview() { setDryRun(buildPlannedUpdates()); }

  async function ensureSelectOptions(needed: Array<{ prop: NotionPropertyDef; name: string }>) {
    if (!needed.length) return;
    if (useMock) {
      // In mock mode, update the local DB schema
      const byProp = new Map<string, Set<string>>();
      for (const n of needed) {
        const set = byProp.get(n.prop.name) ?? new Set<string>();
        set.add(n.name);
        byProp.set(n.prop.name, set);
      }
      byProp.forEach((names, propName) => {
        const def = dbProps.find((p) => p.name === propName);
        const existing = new Set((def?.options ?? []).map((o) => o.name));
        const toAdd = Array.from(names).filter((nm) => !existing.has(nm));
        const old = def?.options ?? [];
        const next = [...old, ...toAdd.map((x) => ({ name: x }))];
        // reflect in local state
        setDbProps((prev) => prev.map((p) => (p.name === propName ? { ...p, options: next } : p)));
      });
      return;
    }
    // Proxy mode
    const updatePayload: any = {};
    const grouped = new Map<string, { prop: NotionPropertyDef; names: Set<string> }>();
    for (const n of needed) {
      const g = grouped.get(n.prop.name) ?? { prop: n.prop, names: new Set<string>() };
      g.names.add(n.name);
      grouped.set(n.prop.name, g);
    }
    grouped.forEach(({ prop, names }) => {
      const existing = new Set((prop.options ?? []).map((o) => o.name));
      const toAdd = Array.from(names).filter((nm) => !existing.has(nm));
      if (toAdd.length) {
        const current = prop.options ?? [];
        updatePayload[prop.name] = { [prop.type]: { options: [...current, ...toAdd.map((name) => ({ name }))] } };
      }
    });
    if (Object.keys(updatePayload).length) {
      await api.updateDatabase(databaseId.trim(), updatePayload);
    }
  }

  async function onExecute() {
    if (!databaseId) return;
    setRunStatus("running"); setRunError(null); setProgress(0);
    try {
      const plans = dryRun ?? buildPlannedUpdates();
      if (createMissingSelectOptions) {
        const needed: Array<{ prop: NotionPropertyDef; name: string }> = [];
        for (const plan of plans) {
          if (plan.action === "update" || plan.action === "create") {
            for (const [propName, val] of Object.entries(plan.changes ?? {})) {
              const def = dbProps.find((p) => p.name === propName);
              if (!def) continue;
              if (def.type === "select" && (val as any)?.select?.name) needed.push({ prop: def, name: (val as any).select.name });
              if (def.type === "multi_select" && Array.isArray((val as any)?.multi_select)) {
                for (const opt of (val as any).multi_select) needed.push({ prop: def, name: opt.name });
              }
              if (def.type === "status" && (val as any)?.status?.name) needed.push({ prop: def, name: (val as any).status.name });
            }
          }
        }
        await ensureSelectOptions(needed);
      }

      let done = 0;
      await pMapSerial(plans, async (plan) => {
        if (plan.action === "update" && plan.page) {
          await api.updatePage(plan.page.id, plan.changes);
        } else if (plan.action === "create") {
          const properties: any = plan.changes ?? {};
          // ensure a title exists for creation
          const titleProp = dbProps.find((p) => p.type === "title")?.name;
          if (titleProp && !properties[titleProp]) properties[titleProp] = buildNotionPropertyValue("title", plan.key);
          await api.createPage(databaseId.trim(), properties);
        }
        done += 1; setProgress(Math.round((done / plans.length) * 100));
      }, 100);

      // refresh list
      const q = await api.queryDatabase(databaseId.trim());
      setPages(q.results);

      setRunStatus("done");
    } catch (err: any) {
      console.error(err);
      setRunError(err?.message ?? String(err));
      setRunStatus("error");
    }
  }

  const canPreview = databaseId && excelRows.length > 0 && excelKey && notionKey && mappings.length > 0;

  // -------------------------------
  // Self-tests (lightweight runtime tests shown in UI)
  // -------------------------------
  type Test = { name: string; pass: boolean; info?: string };
  const [tests, setTests] = useState<Test[] | null>(null);

  function runSelfTests() {
    const results: Test[] = [];
    // 1) buildNotionPropertyValue: number
    const n1 = buildNotionPropertyValue("number", "42");
    results.push({ name: "number parses", pass: !!n1 && (n1 as any).number === 42 });
    // 2) multi_select from CSV
    const m1 = buildNotionPropertyValue("multi_select", "red, blue");
    results.push({ name: "multi_select csv", pass: Array.isArray((m1 as any)?.multi_select) && (m1 as any).multi_select.length === 2 });
    // 3) date parse
    const d1 = buildNotionPropertyValue("date", "2024-01-02");
    results.push({ name: "date parse", pass: (d1 as any)?.date?.start === "2024-01-02" });
    // 4) checkbox
    const c1 = buildNotionPropertyValue("checkbox", "yes");
    results.push({ name: "checkbox yes", pass: (c1 as any)?.checkbox === true });
    // 5) join planning
    const excel = [{ K: "A001", v: 1 }, { K: "X999", v: 2 }];
    const excelIdx = new Map<string, ExcelRow>(excel.map((r) => [r.K, r]));
    // left join keys count should be 2
    results.push({ name: "left join keys", pass: (function(){
      const keys = new Set<string>();
      excelIdx.forEach((_v, k) => keys.add(k));
      return keys.size === 2;
    })() });
    setTests(results);
  }

  useEffect(() => { if (tests === null) runSelfTests(); /* run once */ }, []);

  // -------------------------------
  // UI
  // -------------------------------

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-white p-6 md:p-10">
      <div className="mx-auto max-w-6xl space-y-6">
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-2xl bg-slate-100"><PlugZap className="h-5 w-5" /></div>
                <div>
                  <CardTitle className="text-2xl">Notion ⇄ Excel Merge</CardTitle>
                  <CardDescription>Upload an Excel, choose join type, map columns, preview a dry-run, then update through a backend proxy or the built-in mock.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Backend</Label>
                  <div className="flex items-center gap-2 text-xs text-slate-600">
                    <Badge variant={useMock ? "default" : "outline"}>Mock</Badge>
                    <Switch checked={!useMock} onCheckedChange={(v) => setUseMock(!v)} />
                    <Badge variant={!useMock ? "default" : "outline"}>Proxy</Badge>
                  </div>
                </div>
                {!useMock && (
                  <>
                    <Label>Proxy API Base URL</Label>
                    <Input placeholder="/api/notion-merge" value={proxyBaseUrl} onChange={(e) => setProxyBaseUrl(e.target.value)} />
                    <Label>Bearer token (only if your proxy expects one)</Label>
                    <Input type="password" placeholder="(optional)" value={notionToken} onChange={(e) => setNotionToken(e.target.value)} />
                  </>
                )}

                <Label>Database ID</Label>
                <Input placeholder="mock-db or your real DB ID" value={databaseId} onChange={(e) => setDatabaseId(e.target.value)} />

                <Button variant="secondary" onClick={loadDatabase} disabled={!databaseId || (!useMock && !proxyBaseUrl) || loadingDb}>
                  <Database className="mr-2 h-4 w-4" /> {loadingDb ? "Loading…" : "Load Database"}
                </Button>
                {loadSuccess && (
                  <Alert className="mt-2">
                    <CheckCircle2 className="h-4 w-4" />
                    <AlertTitle>Database loaded</AlertTitle>
                    <AlertDescription className="text-xs">{loadSuccess}</AlertDescription>
                  </Alert>
                )}
                {loadError && (
                  <Alert variant="destructive" className="mt-2">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Failed to load database</AlertTitle>
                    <AlertDescription className="text-xs">{loadError}</AlertDescription>
                  </Alert>
                )}
                {!!dbProps.length && (
                  <div className="text-xs text-slate-600 space-y-1">
                    <div>
                      <span className="font-semibold">Properties:</span>{" "}
                      {dbProps.map((p) => (
                        <Badge key={p.name} variant="outline" className="mr-1 mb-1">
                          {p.name} <span className="opacity-60">· {p.type}</span>
                        </Badge>
                      ))}
                    </div>
                    <div className="opacity-70">Found {pages.length} page(s) in this database.</div>
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <Label>Excel File</Label>
                <div className="flex gap-3 items-center">
                  <Input type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} />
                  <FileSpreadsheet className="h-5 w-5" />
                </div>
                {excelFileName && <p className="text-xs text-slate-600">Loaded: {excelFileName} ({excelRows.length} rows)</p>}
                {!!excelColumns.length && (
                  <div className="text-xs text-slate-600">
                    <span className="font-semibold">Columns:</span>{" "}
                    {excelColumns.map((c) => (
                      <Badge key={c} variant="outline" className="mr-1 mb-1">{c}</Badge>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="border-slate-200">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><RefreshCw className="h-5 w-5" /> Merge Settings</CardTitle>
              <CardDescription>Pick the key columns to match and how the merge should behave.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="space-y-2">
                <Label>Join Type</Label>
                <RadioGroup defaultValue={joinType} onValueChange={(v) => setJoinType(v as JoinType)} className="grid grid-cols-2 gap-2">
                  {[
                    { key: "left", label: "Left" },
                    { key: "right", label: "Right" },
                    { key: "inner", label: "Inner" },
                    { key: "outer", label: "Outer" },
                  ].map((o) => (
                    <div key={o.key} className="flex items-center space-x-2 rounded-xl border p-2">
                      <RadioGroupItem value={o.key} id={`join-${o.key}`} />
                      <Label htmlFor={`join-${o.key}`}>{o.label}</Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>

              <div className="space-y-2">
                <Label>Excel key column</Label>
                <Select value={excelKey} onValueChange={setExcelKey}>
                  <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                  <SelectContent>
                    {excelColumns.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Notion key property</Label>
                <Select value={notionKey} onValueChange={setNotionKey}>
                  <SelectTrigger><SelectValue placeholder="Select property" /></SelectTrigger>
                  <SelectContent>
                    {dbProps.map((p) => (<SelectItem key={p.name} value={p.name}>{p.name} · {p.type}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>

              <div className="md:col-span-3">
                <Separator className="my-2" />
                <div className="flex items-center justify-between">
                  <Label>Column mappings (Excel → Notion)</Label>
                  <Button variant="secondary" size="sm" onClick={addMapping}><Plus className="h-4 w-4 mr-1" /> Add mapping</Button>
                </div>
                <div className="mt-2 grid gap-3">
                  {mappings.length === 0 && (<div className="text-sm text-slate-500">No mappings yet. Add at least one to copy values into Notion.</div>)}
                  {mappings.map((m) => (
                    <div key={m.id} className="grid grid-cols-1 md:grid-cols-7 gap-2 items-center rounded-2xl border p-3">
                      <div className="md:col-span-3 space-y-1">
                        <Label className="text-xs">Excel column</Label>
                        <Select value={m.excelColumn} onValueChange={(v) => setMapping(m.id, { excelColumn: v })}>
                          <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                          <SelectContent>
                            {excelColumns.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="md:col-span-3 space-y-1">
                        <Label className="text-xs">Notion property</Label>
                        <Select value={m.notionProperty} onValueChange={(v) => setMapping(m.id, { notionProperty: v })}>
                          <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                          <SelectContent>
                            {dbProps.map((p) => (<SelectItem key={p.name} value={p.name}>{p.name} · {p.type}</SelectItem>))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="md:col-span-1 flex justify-end">
                        <Button variant="ghost" size="icon" onClick={() => removeMapping(m.id)}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="flex items-center justify-between rounded-xl border p-3">
                    <div>
                      <div className="font-medium">Only update empty fields</div>
                      <div className="text-xs text-slate-500">Skip Notion properties that already have a value.</div>
                    </div>
                    <Switch checked={onlyUpdateEmpty} onCheckedChange={setOnlyUpdateEmpty} />
                  </div>
                  <div className="flex items-center justify-between rounded-xl border p-3">
                    <div>
                      <div className="font-medium">Auto-add select options</div>
                      <div className="text-xs text-slate-500">Create missing Select/Multi-select/Status options.</div>
                    </div>
                    <Switch checked={createMissingSelectOptions} onCheckedChange={setCreateMissingSelectOptions} />
                  </div>
                  <div className="flex items-center justify-between rounded-xl border p-3">
                    <div>
                      <div className="font-medium">Create pages for unmatched Excel</div>
                      <div className="text-xs text-slate-500">Only applies to Left/Outer joins.</div>
                    </div>
                    <Switch checked={allowCreatePages} onCheckedChange={setAllowCreatePages} />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="border-slate-200">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Eye className="h-5 w-5" /> Preview & Run</CardTitle>
              <CardDescription>See what will change before you update.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="rounded-2xl border p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant="outline">Excel rows</Badge><span className="font-medium">{excelRows.length}</span>
                    <Badge variant="outline" className="ml-3">Pages</Badge><span className="font-medium">{pages.length}</span>
                  </div>
                  <div className="text-xs text-slate-600">
                    <div>Match overlap: <span className="font-semibold">{joinSummary.bothCount}</span></div>
                    <div>Excel-only: <span className="font-semibold">{joinSummary.leftOnly.length}</span></div>
                    <div>Notion-only: <span className="font-semibold">{joinSummary.rightOnly.length}</span></div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button onClick={onPreview} disabled={!canPreview}><PlayCircle className="mr-2 h-4 w-4" /> Dry Run</Button>
                    <Button variant="secondary" onClick={onExecute} disabled={!dryRun || runStatus === "running"}><Upload className="mr-2 h-4 w-4" /> Execute Update</Button>
                  </div>

                  {!canPreview && (
                    <Alert className="mt-3">
                      <AlertTitle className="text-sm">Almost there</AlertTitle>
                      <AlertDescription className="text-xs">Load the database, upload an Excel, set key columns, and add at least one mapping.</AlertDescription>
                    </Alert>
                  )}

                  {runStatus === "running" && (
                    <div className="mt-4">
                      <div className="text-sm font-medium">Updating…</div>
                      <div className="w-full bg-slate-200 rounded-full h-2 mt-2"><div className="bg-slate-900 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} /></div>
                      <div className="text-xs text-slate-600 mt-2">{progress}%</div>
                    </div>
                  )}
                  {runStatus === "done" && (
                    <Alert className="mt-3">
                      <CheckCircle2 className="h-4 w-4" />
                      <AlertTitle>Done</AlertTitle>
                      <AlertDescription className="text-xs">Updates completed.</AlertDescription>
                    </Alert>
                  )}
                  {runStatus === "error" && (
                    <Alert variant="destructive" className="mt-3">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Something went wrong</AlertTitle>
                      <AlertDescription className="text-xs">{runError}</AlertDescription>
                    </Alert>
                  )}
                </div>

                <div className="rounded-2xl border p-4">
                  <div className="text-sm font-semibold mb-2">Dry-run plan</div>
                  <div className="max-h-[340px] overflow-auto text-xs">
                    {!dryRun && <div className="text-slate-500">Run a dry run to see planned changes…</div>}
                    {dryRun && dryRun.length === 0 && <div>No actions planned.</div>}
                    {dryRun && dryRun.length > 0 && (
                      <table className="w-full text-left">
                        <thead className="sticky top-0 bg-white">
                          <tr>
                            <th className="py-1 pr-2">Key</th>
                            <th className="py-1 pr-2">Action</th>
                            <th className="py-1 pr-2">Changes</th>
                            <th className="py-1 pr-2">Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dryRun.slice(0, 500).map((p, idx) => (
                            <tr key={idx} className="border-t">
                              <td className="py-1 pr-2 whitespace-nowrap">{p.key}</td>
                              <td className="py-1 pr-2">
                                <Badge variant={p.action === "update" ? "default" : p.action === "create" ? "secondary" : "outline"}>{p.action}</Badge>
                              </td>
                              <td className="py-1 pr-2 max-w-[260px]">{"changes" in p ? (<pre className="whitespace-pre-wrap">{JSON.stringify((p as any).changes, null, 2)}</pre>) : (<span className="text-slate-500">—</span>)}</td>
                              <td className="py-1 pr-2 text-slate-500">{"reason" in p ? (p as any).reason ?? "" : ""}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="border-slate-200">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5" /> Notes</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-slate-600 space-y-2">
              <ul className="list-disc ml-5 space-y-1">
                <li>Canvas/browser mode uses <span className="font-medium">Mock</span> by default to avoid CORS and SDK issues.</li>
                <li>Switch to <span className="font-medium">Proxy</span> and set <code>Proxy API Base URL</code> to call your server that holds the Notion key.</li>
                <li>Supported property types: title, rich_text, number, email, url, phone_number, select, multi_select, date, checkbox, status.</li>
                <li>Be mindful of rate limits when using a real backend. This UI sends operations serially.</li>
              </ul>

              <div className="mt-4">
                <div className="font-semibold mb-1">Self-tests</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {(tests ?? []).map((t, i) => (
                    <div key={i} className={`rounded-xl border p-2 text-xs ${t.pass ? 'border-emerald-300' : 'border-rose-300'}`}>
                      <div className="flex items-center gap-2">
                        <ShieldCheck className={`h-4 w-4 ${t.pass ? 'text-emerald-600' : 'text-rose-600'}`} />
                        <span className="font-medium">{t.name}</span>
                      </div>
                      {!t.pass && t.info && <div className="mt-1 text-slate-600">{t.info}</div>}
                    </div>
                  ))}
                </div>
                <div className="mt-2"><Button size="sm" variant="outline" onClick={runSelfTests}>Re-run tests</Button></div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
