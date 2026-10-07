/* ============================================================================
 *  GEAR ENGINEERING & MANUFACTURING PLATFORM — server.js
 * ==========================================================================*/
"use strict";

require("dotenv").config();

const fs      = require("fs");
const path    = require("path");
const express = require("express");
const cors    = require("cors");
const morgan  = require("morgan");
const { createClient } = require("@supabase/supabase-js");

/* ---------------------------------------------------------------------------
 *  Environment
 * ------------------------------------------------------------------------ */
const {
  PORT = 3000,
  NODE_ENV = "development",
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  API_KEY = ""
} = process.env;

const missing = [];
if (!SUPABASE_URL)              missing.push("SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
if (missing.length){
  console.error("\n[FATAL] Missing env vars: " + missing.join(", "));
  console.error("Add them in Render → Environment.\n");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  db:   { schema: "public" }
});

/* ---------------------------------------------------------------------------
 *  Locate the index.html — try several common locations
 * ------------------------------------------------------------------------ */
const CANDIDATES = [
  path.join(__dirname, "public", "index.html"),
  path.join(__dirname, "index.html"),
  path.join(process.cwd(), "public", "index.html"),
  path.join(process.cwd(), "index.html"),
  process.env.INDEX_HTML_PATH || ""
].filter(Boolean);

let INDEX_HTML_PATH = null;
for (const p of CANDIDATES){
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()){ INDEX_HTML_PATH = p; break; }
  } catch (_){}
}

const PUBLIC_DIR = INDEX_HTML_PATH
  ? path.dirname(INDEX_HTML_PATH)
  : path.join(__dirname, "public");

console.log("[paths] __dirname       =", __dirname);
console.log("[paths] cwd             =", process.cwd());
console.log("[paths] PUBLIC_DIR      =", PUBLIC_DIR);
console.log("[paths] INDEX_HTML_PATH =", INDEX_HTML_PATH || "(NOT FOUND — using fallback)");

/* ---------------------------------------------------------------------------
 *  Fallback page when index.html is missing
 * ------------------------------------------------------------------------ */
const FALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Gear Platform — setup needed</title>
<style>body{font-family:system-ui;background:#0e1116;color:#d6dee8;padding:40px;line-height:1.6;max-width:760px;margin:auto}
h1{color:#4da3ff}code{background:#1a212b;padding:2px 6px;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace}
pre{background:#0a0e13;border:1px solid #2a3441;padding:12px;border-radius:6px;overflow:auto}</style></head>
<body>
<h1>⚠ index.html not found on the server</h1>
<p>The Node server started correctly, but it could not locate <code>public/index.html</code>
in the deployed project. This usually means the file was not committed to Git, or it is in
<code>.gitignore</code>.</p>
<p>Resolved paths on this server:</p>
<pre>__dirname       = ${__dirname}
cwd             = ${process.cwd()}
expected file   = ${CANDIDATES[0]}</pre>
<p><b>Fix:</b> commit the file at <code>public/index.html</code>, push, and re-deploy.</p>
</body></html>`;

/* ---------------------------------------------------------------------------
 *  Express
 * ------------------------------------------------------------------------ */
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));

/* favicon — silence the 404 */
app.get("/favicon.ico", (_req, res) => res.status(204).end());

/* static assets */
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: NODE_ENV === "production" ? "1h" : 0
}));

/* ---------------------------------------------------------------------------
 *  Supabase API routes (unchanged behaviour)
 * ------------------------------------------------------------------------ */
function ok(res, data, status = 200){ res.status(status).json({ ok: true, data }); }
function fail(res, message, status = 400, extra = {}){
  res.status(status).json({ ok: false, error: message, ...extra });
}
function requireApiKey(req, res, next){
  if (!API_KEY) return next();
  const sent = req.headers["x-api-key"] || req.query.api_key;
  if (sent !== API_KEY) return fail(res, "Unauthorized.", 401);
  next();
}
function cleanRow(row){
  if (!row) return null;
  return {
    id: row.id, name: row.name, gearType: row.gear_type,
    description: row.description, ownerEmail: row.owner_email,
    parameters: row.parameters || {}, results: row.results || null,
    tags: row.tags || [], version: row.version, isPublic: row.is_public,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

app.get("/api/health", async (_req, res) => {
  try {
    const { error } = await supabase.from("gear_projects").select("id").limit(1);
    if (error) throw error;
    ok(res, { status:"healthy", supabase:"connected", time:new Date().toISOString(),
              indexHtml: INDEX_HTML_PATH || "missing" });
  } catch (e){ fail(res, "Supabase unreachable: " + e.message, 500); }
});

app.get("/api/projects", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const gearType = (req.query.gear_type || "").toString().trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    let query = supabase.from("gear_projects")
      .select("id,name,gear_type,description,owner_email,parameters,results,tags,version,is_public,created_at,updated_at", { count:"exact" })
      .order("updated_at", { ascending:false })
      .range(offset, offset + limit - 1);
    if (gearType) query = query.eq("gear_type", gearType);
    if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
    const { data, error, count } = await query;
    if (error) throw error;
    ok(res, { items:(data||[]).map(cleanRow), total:count||0, limit, offset });
  } catch (e){ fail(res, e.message, 500); }
});

app.get("/api/projects/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("gear_projects").select("*").eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, "Not found.", 404);
    ok(res, cleanRow(data));
  } catch (e){ fail(res, e.message, 500); }
});

app.post("/api/projects", requireApiKey, async (req, res) => {
  try {
    const row = {
      name: String(req.body.name||"Untitled").trim(),
      gear_type: req.body.gear_type || "spur",
      description: req.body.description || null,
      owner_email: req.body.owner_email || null,
      parameters: req.body.parameters || {},
      results: req.body.results || null,
      tags: Array.isArray(req.body.tags) ? req.body.tags : [],
      is_public: req.body.is_public !== false,
      version: 1
    };
    const { data, error } = await supabase.from("gear_projects").insert(row).select("*").single();
    if (error) throw error;
    ok(res, cleanRow(data), 201);
  } catch (e){ fail(res, e.message, 500); }
});

app.put("/api/projects/:id", requireApiKey, async (req, res) => {
  try {
    const { data: cur, error: rErr } = await supabase.from("gear_projects")
      .select("version").eq("id", req.params.id).maybeSingle();
    if (rErr) throw rErr;
    if (!cur) return fail(res, "Not found.", 404);
    const patch = { version: (cur.version || 1) + 1 };
    for (const k of ["name","gear_type","description","owner_email","parameters","results","is_public"]){
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }
    if (Array.isArray(req.body.tags)) patch.tags = req.body.tags;
    const { data, error } = await supabase.from("gear_projects").update(patch).eq("id", req.params.id).select("*").single();
    if (error) throw error;
    ok(res, cleanRow(data));
  } catch (e){ fail(res, e.message, 500); }
});

app.delete("/api/projects/:id", requireApiKey, async (req, res) => {
  try {
    const { error } = await supabase.from("gear_projects").delete().eq("id", req.params.id);
    if (error) throw error;
    ok(res, { deleted: req.params.id });
  } catch (e){ fail(res, e.message, 500); }
});

/* ---------------------------------------------------------------------------
 *  SPA fallback — serve the located index.html, or the fallback page
 * ------------------------------------------------------------------------ */
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  if (INDEX_HTML_PATH){
    return res.sendFile(INDEX_HTML_PATH, err => {
      if (err) {
        console.error("[sendFile] failed:", err.message, "path:", INDEX_HTML_PATH);
        res.status(500).type("html").send(FALLBACK_HTML);
      }
    });
  }
  res.status(200).type("html").send(FALLBACK_HTML);
});

/* 404 + error handler */
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return fail(res, "Endpoint not found.", 404);
  res.status(404).send("Not found");
});
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  fail(res, err.message || "Internal server error.", err.status || 500);
});

/* ---------------------------------------------------------------------------
 *  Start
 * ------------------------------------------------------------------------ */
const server = app.listen(PORT, () => {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  ⚙  GEAR ENGINEERING & MANUFACTURING PLATFORM");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Server      : http://localhost:${PORT}`);
  console.log(`  Environment : ${NODE_ENV}`);
  console.log(`  Supabase    : ${SUPABASE_URL}`);
  console.log(`  HTML source : ${INDEX_HTML_PATH || "FALLBACK PAGE"}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
});

process.on("SIGINT", () => { server.close(() => process.exit(0)); });
