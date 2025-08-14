import React, { useMemo, useState } from "react";
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
import { Client } from "@notionhq/client";

// -------------------------------
// Utility Types
// -------------------------------

type ExcelRow = Record<string, any>;

type JoinType = "left" | "right" | "inner" | "outer";

type Mapping = {
  id: string;
  excelColumn: string;
  notionProperty: string; // name of the property in the Notion DB
};

type NotionPropertyDef = {
  name: string;
  type: string;
  options?: Array<{ id?: string; name: string; color?: string }>; // for select & multi_select
};

type Plan =
  | {
      key: string;
      action: "update";
      excel: ExcelRow;
      page: any;
      changes: Record<string, any>;
      reason?: undefined;
    }
  | {
      key: string;
      action: "create";
      excel: ExcelRow;
      page?: undefined;
      changes: Record<string, any>;
      reason?: undefined;
    }
  | {
      key: string;
      action: "skip";
      excel?: ExcelRow;
      page?: any;
      changes?: undefined;
      reason: string;
    };

// -------------------------------
// Helper functions for Notion values
// -------------------------------

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
      return !!v ? "true" : "false";
    case "status":
      return v?.name ?? null;
    default:
      return null;
  }
}

function buildNotionPropertyValue(
  targetType: string,
  value: any,
  { createMultiFromCSV = true }: { createMultiFromCSV?: boolean } = {}
): any {
  if (value === undefined || value === null) {
    return undefined;
  }
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
      if (Array.isArray(value)) {
        return { multi_select: value.map((x) => ({ name: String(x) })) };
      }
      if (typeof value === "string" && createMultiFromCSV) {
        return {
          multi_select: value
            .split(/[,;]\s*/)
            .filter(Boolean)
            .map((name) => ({ name })),
        };
      }
      return { multi_select: [] };
    }
    case "date": {
      const d = new Date(value);
      if (!isNaN(d.getTime())) return { date: { start: d.toISOString().slice(0, 10) } };
      return undefined;
    }
    case "checkbox": {
      const truthy = [true, "true", "1", 1, "yes", "y"];
      const falsy = [false, "false", "0", 0, "no", "n", ""];
      if (truthy.includes(value)) return { checkbox: true };
      if (falsy.includes(value)) return { checkbox: false };
      return undefined;
    }
    case "status":
      return { status: { name: String(value) } };
    default:
      // fallback to rich_text
      return { rich_text: [{ type: "text", text: { content: String(value) } }] };
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// A tiny concurrency limiter to be kind to Notion's rate limit (~3 rps)
async function pMapSerial<T, R>(items: T[], fn: (item: T, idx: number) => Promise<R>, delayMs = 350) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await fn(items[i], i));
    if (delayMs > 0 && i < items.length - 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return out;
}

// -------------------------------
// Main App
// -------------------------------

export default function NotionExcelMergeApp(): JSX.Element {
  // Credentials (kept only in-memory)
  const [notionToken, setNotionToken] = useState<string>("");
  const [databaseId, setDatabaseId] = useState<string>("");

  // Excel state
  const [excelRows, setExcelRows] = useState<ExcelRow[]>([]);
  const [excelColumns, setExcelColumns] = useState<string[]>([]);
  const [excelFileName, setExcelFileName] = useState<string>("");

  // Notion state
  const [dbProps, setDbProps] = useState<NotionPropertyDef[]>([]);
  const [pages, setPages] = useState<any[]>([]);
  const [loadingDb, setLoadingDb] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Merge config
  const [joinType, setJoinType] = useState<JoinType>("left");
  const [excelKey, setExcelKey] = useState<string>("");
  const [notionKey, setNotionKey] = useState<string>("");
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [onlyUpdateEmpty, setOnlyUpdateEmpty] = useState<boolean>(false);
  const [createMissingSelectOptions, setCreateMissingSelectOptions] = useState<boolean>(true);
  const [allowCreatePages, setAllowCreatePages] = useState<boolean>(false);

  // Execution state
  const [dryRun, setDryRun] = useState<Plan[] | null>(null);
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [progress, setProgress] = useState<number>(0);
  const [runError, setRunError] = useState<string | null>(null);

  // Derived helpers
  const selectedDbPropDefs = useMemo(() => {
    const map = new Map<string, NotionPropertyDef>();
    dbProps.forEach((p) => map.set(p.name, p));
    return map;
  }, [dbProps]);

  const titlePropName = useMemo(() => dbProps.find((p) => p.type === "title")?.name ?? null, [dbProps]);

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
    const cols = Array.from(
      json.reduce((acc, row) => {
        Object.keys(row).forEach((k) => acc.add(k));
        return acc;
      }, new Set<string>())
    );
    setExcelColumns(cols);
    if (!excelKey && cols.length > 0) setExcelKey(cols[0]);
  };

  async function loadDatabase(): Promise<void> {
    setLoadError(null);
    setLoadingDb(true);
    try {
      const notion = new Client({ auth: notionToken.trim() });

      const db = await notion.databases.retrieve({ database_id: databaseId.trim() });
      const props = Object.entries((db as any).properties).map(([name, def]: any) => {
        const type = def.type;
        const item: NotionPropertyDef = { name, type } as NotionPropertyDef;
        if (type === "select" || type === "multi_select" || type === "status") {
          item.options = def[type]?.options ?? [];
        }
        return item;
      });
      setDbProps(props);
      if (!notionKey && props.length > 0) setNotionKey(props[0].name);

      // Fetch all pages (paginated)
      const all: any[] = [];
      let cursor: string | undefined = undefined;
      do {
        const resp = await notion.databases.query({
          database_id: databaseId.trim(),
          page_size: 100,
          start_cursor: cursor,
        });
        all.push(...resp.results);
        cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
      } while (cursor);

      setPages(all);
    } catch (err: any) {
      console.error(err);
      setLoadError(err?.message ?? String(err));
    } finally {
      setLoadingDb(false);
    }
  }

  function addMapping(): void {
    const firstExcel = excelColumns.find((c) => !mappings.some((m) => m.excelColumn === c));
    const firstNotion = dbProps.find((p) => !mappings.some((m) => m.notionProperty === p.name));
    setMappings((m) => [
      ...m,
      {
        id: uid(),
        excelColumn: firstExcel ?? "",
        notionProperty: firstNotion?.name ?? "",
      },
    ]);
  }

  function removeMapping(id: string): void {
    setMappings((m) => m.filter((x) => x.id !== id));
  }

  function setMapping(id: string, patch: Partial<Mapping>): void {
    setMappings((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  // Build index maps for join
  const excelIndex = useMemo(() => {
    const map = new Map<string, ExcelRow>();
    if (!excelKey) return map;
    for (const row of excelRows) {
      const keyVal = String(row[excelKey] ?? "").trim();
      if (keyVal !== "") map.set(keyVal, row);
    }
    return map;
  }, [excelRows, excelKey]);

  const notionIndex = useMemo(() => {
    const map = new Map<string, any>();
    if (!notionKey) return map;
    for (const pg of pages) {
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

    if (joinType === "left") {
      for (const k of leftKeys) keys.add(k);
    } else if (joinType === "right") {
      for (const k of rightKeys) keys.add(k);
    } else if (joinType === "inner") {
      for (const k of leftKeys) if (rightKeys.has(k)) keys.add(k);
    } else if (joinType === "outer") {
      for (const k of leftKeys) keys.add(k);
      for (const k of rightKeys) keys.add(k);
    }

    const plans: Plan[] = [];

    keys.forEach((key) => {
      const excelRow = excelIndex.get(key);
      const page = notionIndex.get(key);
      if (excelRow && page) {
        // Update existing page with mapped fields
        const changes: Record<string, any> = {};
        for (const m of mappings) {
          const srcVal = excelRow[m.excelColumn];
          if (m.notionProperty && selectedDbPropDefs.has(m.notionProperty)) {
            const targetDef = selectedDbPropDefs.get(m.notionProperty)!;
            const existingValue = getNotionPropertyPlainValue((page as any).properties[m.notionProperty]);
            if (onlyUpdateEmpty && (existingValue !== null && existingValue !== "")) continue;
            const built = buildNotionPropertyValue(targetDef.type, srcVal);
            if (built !== undefined) changes[m.notionProperty] = built;
          }
        }
        if (Object.keys(changes).length > 0) {
          plans.push({ key, action: "update", excel: excelRow, page, changes });
        } else {
          plans.push({ key, action: "skip", excel: excelRow, page, reason: "No changes computed" });
        }
      } else if (excelRow && !page) {
        // Candidate for create (left/outer)
        if ((joinType === "left" || joinType === "outer") && allowCreatePages) {
          const changes: Record<string, any> = {};
          for (const m of mappings) {
            if (!m.notionProperty) continue;
            const targetDef = selectedDbPropDefs.get(m.notionProperty);
            const srcVal = excelRow[m.excelColumn];
            const built = buildNotionPropertyValue(targetDef?.type ?? "rich_text", srcVal);
            if (built !== undefined) changes[m.notionProperty] = built;
          }
          plans.push({ key, action: "create", excel: excelRow, changes });
        } else {
          plans.push({ key, action: "skip", excel: excelRow, reason: "No matching Notion page" });
        }
      } else if (!excelRow && page) {
        // Right-only: usually no-op
        plans.push({ key, action: "skip", page, reason: "No matching Excel row" });
      }
    });

    return plans;
  }

  function onPreview(): void {
    const plans = buildPlannedUpdates();
    setDryRun(plans);
  }

  async function ensureSelectOptions(notion: Client, needed: Array<{ prop: NotionPropertyDef; name: string }>) {
    if (!needed.length) return;
    // Group by property
    const grouped = new Map<string, { prop: NotionPropertyDef; names: Set<string> }>();
    for (const n of needed) {
      const g = grouped.get(n.prop.name) ?? { prop: n.prop, names: new Set<string>() };
      g.names.add(n.name);
      grouped.set(n.prop.name, g);
    }

    // Build update payload for database
    const updateProps: any = {};
    grouped.forEach(({ prop, names }) => {
      const existing = new Set((prop.options ?? []).map((o) => o.name));
      const toAdd = Array.from(names).filter((nm) => !existing.has(nm));
      if (toAdd.length) {
        const current = prop.options ?? [];
        updateProps[prop.name] = {
          [prop.type]: {
            options: [...current, ...toAdd.map((name) => ({ name }))],
          },
        };
      }
    });

    if (Object.keys(updateProps).length) {
      await notion.databases.update({ database_id: databaseId.trim(), properties: updateProps });
    }
  }

  async function onExecute(): Promise<void> {
    if (!notionToken || !databaseId) return;
    setRunStatus("running");
    setRunError(null);
    setProgress(0);

    try {
      const notion = new Client({ auth: notionToken.trim() });
      const plans = dryRun ?? buildPlannedUpdates();

      // Optionally add missing select/multi_select options before updates
      if (createMissingSelectOptions) {
        const needed: Array<{ prop: NotionPropertyDef; name: string }> = [];
        for (const plan of plans) {
          if (plan.action === "update" || plan.action === "create") {
            for (const [propName, val] of Object.entries(plan.changes ?? {})) {
              const def = selectedDbPropDefs.get(propName);
              if (!def) continue;
              if (def.type === "select" && (val as any)?.select?.name) {
                needed.push({ prop: def, name: (val as any).select.name });
              }
              if (def.type === "multi_select" && Array.isArray((val as any)?.multi_select)) {
                for (const opt of (val as any).multi_select) needed.push({ prop: def, name: opt.name });
              }
              if (def.type === "status" && (val as any)?.status?.name) {
                needed.push({ prop: def, name: (val as any).status.name });
              }
            }
          }
        }
        await ensureSelectOptions(notion, needed);
      }

      let done = 0;
      await pMapSerial(plans, async (plan) => {
        if (plan.action === "update" && plan.page) {
          await notion.pages.update({ page_id: (plan.page as any).id, properties: plan.changes });
        } else if (plan.action === "create") {
          const properties: any = plan.changes ?? {};
          // Ensure title property exists for creation
          if (titlePropName && !properties[titlePropName]) {
            // try to infer from the matching field value
            const maybe = String(plan.key ?? "");
            properties[titlePropName] = buildNotionPropertyValue("title", maybe);
          }
          await notion.pages.create({ parent: { database_id: databaseId.trim() }, properties });
        }
        done += 1;
        setProgress(Math.round((done / plans.length) * 100));
      });

      setRunStatus("done");
    } catch (err: any) {
      console.error(err);
      setRunError(err?.message ?? String(err));
      setRunStatus("error");
    }
  }

  const canPreview =
    notionToken && databaseId && excelRows.length > 0 && excelKey && notionKey && mappings.length > 0;

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
                <div className="p-2 rounded-2xl bg-slate-100">
                  <PlugZap className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-2xl">Notion ⇄ Excel Merge</CardTitle>
                  <CardDescription>
                    Upload an Excel file, match on a key, choose columns to merge into a Notion database, and run
                    left/right/inner/outer joins with a dry-run preview.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <Label>Notion Integration Token</Label>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    placeholder="secret_XXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                    value={notionToken}
                    onChange={(e) => setNotionToken(e.target.value)}
                  />
                  <ShieldCheck className="h-5 w-5 mt-2 text-emerald-600" title="Stored only in your browser memory" />
                </div>
                <p className="text-xs text-slate-500">
                  Your token stays in-memory and is never sent anywhere except directly to Notion from your browser.
                </p>
                <Label>Notion Database ID</Label>
                <Input placeholder="e.g. a1b2c3d4e5f6..." value={databaseId} onChange={(e) => setDatabaseId(e.target.value)} />
                <Button variant="secondary" onClick={loadDatabase} disabled={!notionToken || !databaseId || loadingDb}>
                  <Database className="mr-2 h-4 w-4" /> {loadingDb ? "Loading…" : "Load Database"}
                </Button>
                {loadError && (
                  <Alert variant="destructive" className="mt-2">
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
                {excelFileName && (
                  <p className="text-xs text-slate-600">
                    Loaded: {excelFileName} ({excelRows.length} rows)
                  </p>
                )}
                {!!excelColumns.length && (
                  <div className="text-xs text-slate-600">
                    <span className="font-semibold">Columns:</span>{" "}
                    {excelColumns.map((c) => (
                      <Badge key={c} variant="outline" className="mr-1 mb-1">
                        {c}
                      </Badge>
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
              <CardTitle className="flex items-center gap-2">
                <RefreshCw className="h-5 w-5" /> Merge Settings
              </CardTitle>
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
                  <SelectTrigger>
                    <SelectValue placeholder="Select column" />
                  </SelectTrigger>
                  <SelectContent>
                    {excelColumns.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Notion key property</Label>
                <Select value={notionKey} onValueChange={setNotionKey}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select property" />
                  </SelectTrigger>
                  <SelectContent>
                    {dbProps.map((p) => (
                      <SelectItem key={p.name} value={p.name}>
                        {p.name} · {p.type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="md:col-span-3">
                <Separator className="my-2" />
                <div className="flex items-center justify-between">
                  <Label>Column mappings (Excel → Notion)</Label>
                  <Button variant="secondary" size="sm" onClick={addMapping}>
                    <Plus className="h-4 w-4 mr-1" /> Add mapping
                  </Button>
                </div>
                <div className="mt-2 grid gap-3">
                  {mappings.length === 0 && (
                    <div className="text-sm text-slate-500">No mappings yet. Add at least one to copy values into Notion.</div>
                  )}
                  {mappings.map((m) => (
                    <div key={m.id} className="grid grid-cols-1 md:grid-cols-7 gap-2 items-center rounded-2xl border p-3">
                      <div className="md:col-span-3 space-y-1">
                        <Label className="text-xs">Excel column</Label>
                        <Select value={m.excelColumn} onValueChange={(v) => setMapping(m.id, { excelColumn: v })}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                          <SelectContent>
                            {excelColumns.map((c) => (
                              <SelectItem key={c} value={c}>
                                {c}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="md:col-span-3 space-y-1">
                        <Label className="text-xs">Notion property</Label>
                        <Select value={m.notionProperty} onValueChange={(v) => setMapping(m.id, { notionProperty: v })}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                          <SelectContent>
                            {dbProps.map((p) => (
                              <SelectItem key={p.name} value={p.name}>
                                {p.name} · {p.type}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="md:col-span-1 flex justify-end">
                        <Button variant="ghost" size="icon" onClick={() => removeMapping(m.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
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
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" /> Preview & Run
              </CardTitle>
              <CardDescription>See what will change before you update Notion.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="rounded-2xl border p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant="outline">Excel rows</Badge>
                    <span className="font-medium">{excelRows.length}</span>
                    <Badge variant="outline" className="ml-3">
                      Notion pages
                    </Badge>
                    <span className="font-medium">{pages.length}</span>
                  </div>
                  <div className="text-xs text-slate-600">
                    <div>
                      Match overlap: <span className="font-semibold">{joinSummary.bothCount}</span>
                    </div>
                    <div>
                      Excel-only: <span className="font-semibold">{joinSummary.leftOnly.length}</span>
                    </div>
                    <div>
                      Notion-only: <span className="font-semibold">{joinSummary.rightOnly.length}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex gap-2">
                    <Button onClick={onPreview} disabled={!canPreview}>
                      <PlayCircle className="mr-2 h-4 w-4" /> Dry Run
                    </Button>
                    <Button variant="secondary" onClick={onExecute} disabled={!dryRun || runStatus === "running"}>
                      <Upload className="mr-2 h-4 w-4" /> Execute Update
                    </Button>
                  </div>

                  {!canPreview && (
                    <Alert className="mt-3">
                      <AlertTitle className="text-sm">Almost there</AlertTitle>
                      <AlertDescription className="text-xs">
                        Load the Notion database, upload an Excel, select key columns, and add at least one mapping.
                      </AlertDescription>
                    </Alert>
                  )}

                  {runStatus === "running" && (
                    <div className="mt-4">
                      <div className="text-sm font-medium">Updating Notion…</div>
                      <div className="w-full bg-slate-200 rounded-full h-2 mt-2">
                        <div className="bg-slate-900 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
                      </div>
                      <div className="text-xs text-slate-600 mt-2">{progress}%</div>
                    </div>
                  )}
                  {runStatus === "done" && (
                    <Alert className="mt-3">
                      <CheckCircle2 className="h-4 w-4" />
                      <AlertTitle>Done</AlertTitle>
                      <AlertDescription className="text-xs">Your updates have been sent to Notion.</AlertDescription>
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
                                <Badge variant={p.action === "update" ? "default" : p.action === "create" ? "secondary" : "outline"}>
                                  {p.action}
                                </Badge>
                              </td>
                              <td className="py-1 pr-2 max-w-[260px]">
                                {"changes" in p && p.changes ? (
                                  <pre className="whitespace-pre-wrap">{JSON.stringify(p.changes, null, 2)}</pre>
                                ) : (
                                  <span className="text-slate-500">—</span>
                                )}
                              </td>
                              <td className="py-1 pr-2 text-slate-500">{"reason" in p ? p.reason ?? "" : ""}</td>
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
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" /> Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-slate-600 space-y-2">
              <ul className="list-disc ml-5 space-y-1">
                <li>Make sure your Notion integration has been invited to the target database (••• → Add connections).</li>
                <li>
                  The <span className="font-medium">key</span> you select should uniquely identify rows/pages. Trim/format
                  inconsistencies can cause mismatches.
                </li>
                <li>
                  Supported property types include title, rich_text, number, email, url, phone_number, select, multi_select, date,
                  checkbox, and status. Others default to rich_text.
                </li>
                <li>
                  If you enable <span className="font-medium">Create pages</span>, a title is required. The app attempts to use the key as
                  title when a title mapping isn’t provided.
                </li>
                <li>Be mindful of Notion rate limits. This app spaces requests to be polite.</li>
              </ul>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
