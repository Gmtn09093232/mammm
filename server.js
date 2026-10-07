/* ============================================================================
 *  GEAR ENGINEERING & MANUFACTURING PLATFORM
 *  Node.js + Express + Supabase backend
 *
 *  Run:   npm install    then    npm start
 *  Open:  http://localhost:3000
 *
 *  Endpoints (all JSON):
 *    GET    /api/health
 *    GET    /api/projects                 ?q=&gear_type=&limit=&offset=
 *    GET    /api/projects/:id
 *    GET    /api/projects/:id/revisions
 *    POST   /api/projects                 { name, gear_type, parameters, ... }
 *    PUT    /api/projects/:id             { name?, parameters?, ... }
 *    PATCH  /api/projects/:id/rename      { name }
 *    DELETE /api/projects/:id
 *    POST   /api/projects/:id/duplicate
 *    GET    /api/stats
 * ==========================================================================*/
"use strict";

require("dotenv").config();

const path    = require("path");
const express = require("express");
const cors    = require("cors");
const morgan  = require("morgan");
const { createClient } = require("@supabase/supabase-js");

/* ----------------------------------------------------------------------------
 *  Environment validation
 * --------------------------------------------------------------------------*/
const {
  PORT = 3000,
  NODE_ENV = "development",
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  API_KEY = ""
} = process.env;

const missing = [];
if (!SUPABASE_URL)                  missing.push("SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY)     missing.push("SUPABASE_SERVICE_ROLE_KEY");
if (missing.length){
  console.error("\n[FATAL] Missing environment variables: " + missing.join(", "));
  console.error("Create a .env file next to server.js — see .env.example.\n");
  process.exit(1);
}

/* ----------------------------------------------------------------------------
 *  Supabase client (service role — server only)
 * --------------------------------------------------------------------------*/
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  db:   { schema: "public" }
});

/* Read-only anon client (optional, for realtime broadcasting) */
const supabaseAnon = SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  : null;

/* ----------------------------------------------------------------------------
 *  Express app
 * --------------------------------------------------------------------------*/
const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));

/* Serve the static front-end */
app.use(express.static(path.join(__dirname, ""), {
  etag: true,
  maxAge: NODE_ENV === "production" ? "1h" : 0
}));

/* ----------------------------------------------------------------------------
 *  Helpers
 * --------------------------------------------------------------------------*/
function ok(res, data, status = 200){ res.status(status).json({ ok: true, data }); }
function fail(res, message, status = 400, extra = {}){
  res.status(status).json({ ok: false, error: message, ...extra });
}

function requireApiKey(req, res, next){
  /* If API_KEY is empty, the write endpoints are open (dev mode). */
  if (!API_KEY) return next();
  const sent = req.headers["x-api-key"] || req.query.api_key;
  if (sent !== API_KEY) return fail(res, "Unauthorized — invalid or missing API key.", 401);
  next();
}

function validateProjectPayload(body, { partial = false } = {}){
  const errs = [];
  if (!partial || body.name !== undefined){
    if (typeof body.name !== "string" || !body.name.trim()) errs.push("name is required.");
    else if (body.name.length > 200) errs.push("name must be ≤ 200 characters.");
  }
  if (!partial || body.gear_type !== undefined){
    const allowed = ["spur","helical","bevel","spiralbevel","worm","wormwheel","rack","sprocket"];
    if (!allowed.includes(body.gear_type)) errs.push("gear_type must be one of: " + allowed.join(", "));
  }
  if (!partial || body.parameters !== undefined){
    if (typeof body.parameters !== "object" || body.parameters === null || Array.isArray(body.parameters))
      errs.push("parameters must be a JSON object.");
  }
  return errs;
}

function cleanRow(row){
  if (!row) return null;
  return {
    id:          row.id,
    name:        row.name,
    gearType:    row.gear_type,
    description: row.description,
    ownerEmail:  row.owner_email,
    parameters:  row.parameters || {},
    results:     row.results || null,
    tags:        row.tags || [],
    version:     row.version,
    isPublic:    row.is_public,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at
  };
}

/* ----------------------------------------------------------------------------
 *  Health & stats
 * --------------------------------------------------------------------------*/
app.get("/api/health", async (_req, res) => {
  try {
    const { error } = await supabase.from("gear_projects").select("id").limit(1);
    if (error) throw error;
    ok(res, {
      status: "healthy",
      supabase: "connected",
      time: new Date().toISOString(),
      env: NODE_ENV
    });
  } catch (e){
    fail(res, "Supabase unreachable: " + e.message, 500);
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    const { count, error } = await supabase
      .from("gear_projects")
      .select("id", { count: "exact", head: true });
    if (error) throw error;

    const { data: byType } = await supabase
      .from("gear_projects")
      .select("gear_type");

    const tally = {};
    (byType || []).forEach(r => { tally[r.gear_type] = (tally[r.gear_type] || 0) + 1; });

    ok(res, { total: count || 0, byGearType: tally });
  } catch (e){
    fail(res, e.message, 500);
  }
});

/* ----------------------------------------------------------------------------
 *  List projects (with search, filter, pagination)
 * --------------------------------------------------------------------------*/
app.get("/api/projects", async (req, res) => {
  try {
    const q        = (req.query.q || "").toString().trim();
    const gearType = (req.query.gear_type || "").toString().trim();
    const limit    = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset   = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const orderBy  = req.query.order === "name" ? "name" : "updated_at";
    const ascending = req.query.dir === "asc";

    let query = supabase
      .from("gear_projects")
      .select("id,name,gear_type,description,owner_email,parameters,results,tags,version,is_public,created_at,updated_at", { count: "exact" })
      .order(orderBy, { ascending })
      .range(offset, offset + limit - 1);

    if (gearType) query = query.eq("gear_type", gearType);
    if (q)        query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    ok(res, {
      items: (data || []).map(cleanRow),
      total: count || 0,
      limit,
      offset
    });
  } catch (e){
    fail(res, e.message, 500);
  }
});

/* ----------------------------------------------------------------------------
 *  Get one project
 * --------------------------------------------------------------------------*/
app.get("/api/projects/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("gear_projects")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return fail(res, "Project not found.", 404);
    ok(res, cleanRow(data));
  } catch (e){
    fail(res, e.message, 500);
  }
});

/* ----------------------------------------------------------------------------
 *  Revisions
 * --------------------------------------------------------------------------*/
app.get("/api/projects/:id/revisions", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("gear_revisions")
      .select("id,version,parameters,note,created_at")
      .eq("project_id", req.params.id)
      .order("version", { ascending: false })
      .limit(100);

    if (error) throw error;
    ok(res, data || []);
  } catch (e){
    fail(res, e.message, 500);
  }
});

/* ----------------------------------------------------------------------------
 *  Create project
 * --------------------------------------------------------------------------*/
app.post("/api/projects", requireApiKey, async (req, res) => {
  try {
    const errs = validateProjectPayload(req.body, { partial: false });
    if (errs.length) return fail(res, errs.join(" "), 422);

    const row = {
      name:        req.body.name.trim(),
      gear_type:   req.body.gear_type,
      description: req.body.description || null,
      owner_email: req.body.owner_email || null,
      parameters:  req.body.parameters,
      results:     req.body.results || null,
      tags:        Array.isArray(req.body.tags) ? req.body.tags : [],
      is_public:   req.body.is_public !== false,
      version:     1
    };

    const { data, error } = await supabase
      .from("gear_projects")
      .insert(row)
      .select("*")
      .single();

    if (error) throw error;

    /* first revision */
    await supabase.from("gear_revisions").insert({
      project_id: data.id,
      version: 1,
      parameters: row.parameters,
      note: "Initial revision"
    });

    ok(res, cleanRow(data), 201);
  } catch (e){
    fail(res, e.message, 500);
  }
});

/* ----------------------------------------------------------------------------
 *  Update project (creates a revision)
 * --------------------------------------------------------------------------*/
app.put("/api/projects/:id", requireApiKey, async (req, res) => {
  try {
    const errs = validateProjectPayload(req.body, { partial: true });
    if (errs.length) return fail(res, errs.join(" "), 422);

    /* fetch current version */
    const { data: current, error: readErr } = await supabase
      .from("gear_projects")
      .select("version, parameters")
      .eq("id", req.params.id)
      .maybeSingle();

    if (readErr) throw readErr;
    if (!current) return fail(res, "Project not found.", 404);

    const nextVersion = (current.version || 1) + 1;

    const patch = { version: nextVersion };
    if (req.body.name !== undefined)        patch.name = req.body.name.trim();
    if (req.body.gear_type !== undefined)   patch.gear_type = req.body.gear_type;
    if (req.body.description !== undefined) patch.description = req.body.description;
    if (req.body.owner_email !== undefined) patch.owner_email = req.body.owner_email;
    if (req.body.parameters !== undefined)  patch.parameters = req.body.parameters;
    if (req.body.results !== undefined)     patch.results = req.body.results;
    if (req.body.tags !== undefined)        patch.tags = Array.isArray(req.body.tags) ? req.body.tags : [];
    if (req.body.is_public !== undefined)   patch.is_public = req.body.is_public;

    const { data, error } = await supabase
      .from("gear_projects")
      .update(patch)
      .eq("id", req.params.id)
      .select("*")
      .single();

    if (error) throw error;

    await supabase.from("gear_revisions").insert({
      project_id: data.id,
      version: nextVersion,
      parameters: patch.parameters || current.parameters,
      note: req.body.note || `Revision ${nextVersion}`
    });

    ok(res, cleanRow(data));
  } catch (e){
    fail(res, e.message, 500);
  }
});

/* ----------------------------------------------------------------------------
 *  Rename only
 * --------------------------------------------------------------------------*/
app.patch("/api/projects/:id/rename", requireApiKey, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) return fail(res, "name is required.", 422);

    const { data, error } = await supabase
      .from("gear_projects")
      .update({ name })
      .eq("id", req.params.id)
      .select("id,name,updated_at")
      .single();

    if (error) throw error;
    ok(res, data);
  } catch (e){
    fail(res, e.message, 500);
  }
});

/* ----------------------------------------------------------------------------
 *  Duplicate project
 * --------------------------------------------------------------------------*/
app.post("/api/projects/:id/duplicate", requireApiKey, async (req, res) => {
  try {
    const { data: src, error: readErr } = await supabase
      .from("gear_projects")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (readErr) throw readErr;
    if (!src) return fail(res, "Project not found.", 404);

    const newRow = {
      name:        (req.body && req.body.name) || (src.name + " (copy)"),
      gear_type:   src.gear_type,
      description: src.description,
      owner_email: src.owner_email,
      parameters:  src.parameters,
      results:     src.results,
      tags:        src.tags || [],
      is_public:   src.is_public,
      version:     1
    };

    const { data, error } = await supabase
      .from("gear_projects")
      .insert(newRow)
      .select("*")
      .single();

    if (error) throw error;
    ok(res, cleanRow(data), 201);
  } catch (e){
    fail(res, e.message, 500);
  }
});

/* ----------------------------------------------------------------------------
 *  Delete project
 * --------------------------------------------------------------------------*/
app.delete("/api/projects/:id", requireApiKey, async (req, res) => {
  try {
    const { error } = await supabase
      .from("gear_projects")
      .delete()
      .eq("id", req.params.id);

    if (error) throw error;
    ok(res, { deleted: req.params.id });
  } catch (e){
    fail(res, e.message, 500);
  }
});

/* ----------------------------------------------------------------------------
 *  SPA fallback — serve index.html for any other GET
 * --------------------------------------------------------------------------*/
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ----------------------------------------------------------------------------
 *  404 + error handler
 * --------------------------------------------------------------------------*/
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return fail(res, "Endpoint not found.", 404);
  res.status(404).send("Not found");
});

app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  fail(res, err.message || "Internal server error.", err.status || 500);
});

/* ----------------------------------------------------------------------------
 *  Start
 * --------------------------------------------------------------------------*/
const server = app.listen(PORT, () => {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ⚙  GEAR ENGINEERING & MANUFACTURING PLATFORM");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Server      : http://localhost:${PORT}`);
  console.log(`  Environment : ${NODE_ENV}`);
  console.log(`  Supabase    : ${SUPABASE_URL}`);
  console.log(`  API key     : ${API_KEY ? "required for write operations" : "OPEN (dev mode)"}`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
});

/* ----------------------------------------------------------------------------
 *  Real-time broadcast: push DB changes to connected clients via SSE
 * --------------------------------------------------------------------------*/
const sseClients = new Set();

app.get("/api/live", (req, res) => {
  res.set({
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection":    "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders && res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

  const client = { res };
  sseClients.add(client);

  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch (_) {}
  }, 25000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(client);
  });
});

function broadcast(event, payload){
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of sseClients){
    try { c.res.write(msg); } catch (_) { sseClients.delete(c); }
  }
}

/* Subscribe to Supabase Realtime on the gear_projects table */
try {
  const channel = supabase
    .channel("gear_projects_live")
    .on("postgres_changes",
        { event: "*", schema: "public", table: "gear_projects" },
        (payload) => {
          broadcast("project_change", {
            eventType: payload.eventType,
            record:    payload.new ? cleanRow(payload.new) : null,
            oldId:     payload.old ? payload.old.id : null,
            at:        Date.now()
          });
        })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") console.log("[realtime] subscribed to gear_projects");
      if (status === "CHANNEL_ERROR") console.warn("[realtime] channel error");
    });
} catch (e){
  console.warn("[realtime] could not subscribe:", e.message);
}

/* ----------------------------------------------------------------------------
 *  Graceful shutdown
 * --------------------------------------------------------------------------*/
process.on("SIGINT", () => {
  console.log("\n[server] shutting down…");
  server.close(() => process.exit(0));
});
