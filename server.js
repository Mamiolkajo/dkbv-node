import express from "express";

const app = express();
app.use(express.json());

// CORS så WordPress/browser kan kalde API’et
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ====== StatBank API (officiel) ======
const SB_API = "https://api.statbank.dk/v1"; // endpoints: /tableinfo, /data [1](https://wpforms.com/docs/calculations-formula-examples/)
const TABLE = "BM011";
const LANG = "da";

// ====== Cache (production) ======
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 timer
const CACHE = new Map(); // key -> {t, data}
function cacheGet(key) {
  const v = CACHE.get(key);
  if (!v) return null;
  const age = Date.now() - v.t;
  return { ...v.data, _ageMs: age, _fresh: age <= CACHE_TTL_MS };
}
function cacheSet(key, data) {
  CACHE.set(key, { t: Date.now(), data });
}

// ====== Simpel rate limit (per IP) ======
const RL = new Map(); // ip -> {t, n}
const RL_WINDOW_MS = 10_000; // 10 sek
const RL_MAX = 5; // max 5 requests pr 10 sek pr ip
function rateLimit(req, res) {
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const cur = RL.get(ip) || { t: now, n: 0 };
  if (now - cur.t > RL_WINDOW_MS) { cur.t = now; cur.n = 0; }
  cur.n += 1;
  RL.set(ip, cur);
  if (cur.n > RL_MAX) {
    res.status(429).json({ ok: false, error: "Rate limit: prøv igen om lidt." });
    return false;
  }
  return true;
}

function jsonPost(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(async (res) => {
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${txt.slice(0, 200)}`);
    return txt;
  });
}

async function getTableInfo() {
  const body = { lang: LANG, table: TABLE, format: "JSON" };
  const txt = await jsonPost(`${SB_API}/tableinfo`, body); // [1](https://wpforms.com/docs/calculations-formula-examples/)
  return JSON.parse(txt);
}

function findLatestTid(tableInfo) {
  const vars = tableInfo.variables || [];
  const tidVar = vars.find(v => v.id === "Tid");
  if (!tidVar || !tidVar.values) return null;
  const ids = tidVar.values.map(x => x.id).filter(Boolean).sort();
  return ids.length ? ids[ids.length - 1] : null;
}

function findPris20Realiseret(tableInfo) {
  const vars = tableInfo.variables || [];
  const prisVar = vars.find(v => v.id === "PRIS20");
  if (!prisVar || !prisVar.values) return null;

  // vælg den value der indeholder “realiseret/realized”
  for (const val of prisVar.values) {
    const t = (val.text || "").toLowerCase();
    if (t.includes("realiseret") || t.includes("realized")) return val.id;
  }
  // fallback: første hvis teksten ændrer sig
  return prisVar.values[0]?.id || null;
}

function parseBulkSemicolon(txt) {
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const header = lines[0].split(";");
  const idxV = header.indexOf("INDHOLD");
  if (idxV === -1) return null;

  // 1 række forventes når vi sender 1 postnr + 1 ejkat + 1 pris + 1 tid
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(";");
    const val = Number(String(cols[idxV] || "").replace(",", "."));
    if (Number.isFinite(val) && val > 0) return val;
  }
  return null;
}

async function fetchM2FromStatbank(postnr, ejkat, tid = "latest") {
  const ti = await getTableInfo();
  const latestTid = (tid === "latest" || tid === "seneste") ? findLatestTid(ti) : tid;
  const pris20 = findPris20Realiseret(ti);

  if (!latestTid) throw new Error("Kunne ikke finde seneste Tid i tableinfo.");
  if (!pris20) throw new Error("Kunne ikke finde PRIS20 (realiseret) i tableinfo.");

  const req = {
    table: TABLE,
    lang: LANG,
    format: "BULK",
    variables: [
      { code: "PNR20", values: [postnr] },
      { code: "EJKAT20", values: [ejkat] },
      { code: "PRIS20", values: [pris20] },
      { code: "Tid", values: [latestTid] }
    ]
  };

  const bulk = await jsonPost(`${SB_API}/data`, req); // [1](https://wpforms.com/docs/calculations-formula-examples/)
  const m2 = parseBulkSemicolon(bulk);

  if (!m2) throw new Error("Kunne ikke parse INDHOLD fra BULK.");
  return { m2_price: m2, kvartal: latestTid, source: "api.statbank.dk" };
}

// Health
app.get("/", (req, res) => res.json({ ok: true, service: "dkbv-node", source: "api.statbank.dk" }));

// Main endpoint
app.post("/bm011", async (req, res) => {
  if (!rateLimit(req, res)) return;

  try {
    const postnr = String(req.body?.postnr || "").replace(/\D/g, "").slice(0, 4);
    const ejkat  = String(req.body?.ejkat || "2"); // "1" parcel, "2" lejlighed, "3" fritid
    const tid    = String(req.body?.tid || "latest");

    if (postnr.length !== 4) return res.status(400).json({ ok: false, error: "postnr skal være 4 cifre" });
    if (!["1","2","3"].includes(ejkat)) return res.status(400).json({ ok: false, error: "ejkat skal være 1, 2 eller 3" });

    const key = `${postnr}|${ejkat}|${tid}`;
    const cached = cacheGet(key);

    // hvis vi har frisk cache → returner straks
    if (cached && cached._fresh) {
      const { _ageMs, _fresh, ...rest } = cached;
      return res.json({ ok: true, ...rest, cached: true });
    }

    // ellers prøv at hente live
    const live = await fetchM2FromStatbank(postnr, ejkat, tid);
    cacheSet(key, live);
    return res.json({ ok: true, ...live, cached: false });

  } catch (err) {
    // Hvis StatBank fejler → returnér stale cache hvis vi har den
    const postnr = String(req.body?.postnr || "").replace(/\D/g, "").slice(0, 4);
    const ejkat  = String(req.body?.ejkat || "2");
    const tid    = String(req.body?.tid || "latest");
    const key = `${postnr}|${ejkat}|${tid}`;
    const cached = cacheGet(key);

    if (cached) {
      const { _ageMs, _fresh, ...rest } = cached;
      return res.status(200).json({
        ok: true,
        ...rest,
        cached: true,
        stale: true,
        warning: "Live-kald fejlede, viser cache."
      });
    }

    return res.status(502).json({
      ok: false,
      error: "Kunne ikke hente BM011 fra api.statbank.dk",
      details: err?.message || String(err)
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));
