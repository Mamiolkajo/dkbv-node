import fs from "fs";
import path from "path";
import express from "express";

const app = express();
app.use(express.json());

// CORS (WordPress kan kalde)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const DATA_FILE = path.join(process.cwd(), "data", "bm011_latest.csv");

// Valgfrit: beskyt reload-endpoint (sæt env var ADMIN_TOKEN på Render)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// In-memory: intervaller pr (tid, ejkat) => sorteret array til binær søgning
// key = `${tid}|${ejkat}` -> [{from,to,val}]
let intervalsByKey = new Map();
let latestTidGlobal = null;
let meta = { rows: 0, loadedAt: null, file: DATA_FILE };

// ---------- Utils ----------
function parseNum(val) {
  const s = String(val ?? "").trim();
  if (!s || s === "..") return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function readTextSmart(filePath) {
  const buf = fs.readFileSync(filePath);
  const utf8 = buf.toString("utf8");
  const bad = (utf8.match(/ /g) || []).length;
  if (bad >= 2) return buf.toString("latin1");
  return utf8;
}

// Hvis hele linjen er i quotes og indeholder "" -> " (CSV-standard escape) [1](https://wplist.net/wordpress-forms-plugins/calculated-fields-form)
function unquoteWholeLine(line) {
  let s = String(line).trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
    s = s.replace(/""/g, '"');
  }
  return s;
}

function tidToNum(tid) {
  const m = String(tid).match(/^(\d{4})[KQ]([1-4])$/i);
  if (!m) return -1;
  return Number(m[1]) * 10 + Number(m[2]);
}

function resolveTid(tid) {
  if (!tid || tid === "latest" || tid === "seneste") return latestTidGlobal;
  return tid;
}

// Parse én data-linje (understøtter dine nuværende linjer)
function parseBm011Line(line) {
  let s = unquoteWholeLine(line).trim();
  if (!s) return null;

  // TAB variant (hvis du en dag får den)
  if (s.includes("\t")) {
    const cols = s.split("\t").map(x => x.trim()).filter(Boolean);
    if (cols.length < 6) return null;
    const first = cols[0].toLowerCase();
    if (!first.includes("realiseret")) return null;

    const tid = String(cols[1]).replace(/^"+|"+$/g, "").trim();
    const område = String(cols[2]).replace(/^"+|"+$/g, "").trim();

    return {
      tid,
      område,
      parcel: parseNum(cols[3]),
      ejer: parseNum(cols[4]),
      fritid: parseNum(cols[5]),
    };
  }

  // Space + quoted felter:
  // Realiseret handelspris "2025K4" "1500-1799 Kbh.V." .. 78290 0
  const m = s.match(/^Realiseret handelspris\s+"([^"]+)"\s+"([^"]+)"\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i);
  if (!m) return null;

  return {
    tid: m[1].trim(),
    område: m[2].trim(),
    parcel: parseNum(m[3]),
    ejer: parseNum(m[4]),
    fritid: parseNum(m[5]),
  };
}

// Uddrag interval fra område-teksten:
// "1500-1799 Kbh.V." => from=1500, to=1799
// "2100 København Ø" => from=2100, to=2100
function parseRange(område) {
  const s = String(område || "").trim();
  const r = s.match(/^(\d{4})-(\d{4})/);
  if (r) return { from: Number(r[1]), to: Number(r[2]), label: `${r[1]}-${r[2]}` };

  const one = s.match(/^(\d{4})/);
  if (one) {
    const p = Number(one[1]);
    return { from: p, to: p, label: `${p}` };
  }
  return null;
}

// Binær søgning: find sidste interval med from <= postnr
// Returnér enten exact match (inside interval) eller null
function findExact(list, postnrNum) {
  if (!list || list.length === 0) return null;
  let lo = 0, hi = list.length - 1;
  let best = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].from <= postnrNum) { best = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  if (best === -1) return null;

  const it = list[best];
  if (postnrNum >= it.from && postnrNum <= it.to) return it;
  return null;
}

// “Smartere fallback”: hvis der ikke findes exact interval, returnér nærmeste interval
// (tager nabointerval før/efter og vælger korteste afstand)
function findNearest(list, postnrNum) {
  if (!list || list.length === 0) return null;

  let lo = 0, hi = list.length - 1;
  let best = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].from <= postnrNum) { best = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }

  const cand = [];
  if (best >= 0) cand.push(list[best]);
  if (best + 1 < list.length) cand.push(list[best + 1]);

  let chosen = null;
  let bestDist = Infinity;

  for (const it of cand) {
    let dist = 0;
    if (postnrNum < it.from) dist = it.from - postnrNum;
    else if (postnrNum > it.to) dist = postnrNum - it.to;
    else dist = 0;

    if (dist < bestDist) {
      bestDist = dist;
      chosen = it;
    }
  }
  return chosen;
}

// Fallback-rækkefølge per ejkat
function fallbackOrder(requestedEjkat) {
  if (requestedEjkat === "1") return ["1", "2", "3"];
  if (requestedEjkat === "2") return ["2", "1", "3"];
  if (requestedEjkat === "3") return ["3", "1", "2"];
  return ["2", "1", "3"];
}

// ---------- Load data ----------
function loadLocalCsv() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`Mangler datafil: ${DATA_FILE}`);
  }

  const raw = readTextSmart(DATA_FILE);
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);

  const temp = new Map(); // `${tid}|${ejkat}` -> array
  let latestTid = null;
  let rows = 0;

  for (const line of lines) {
    const row = parseBm011Line(line);
    if (!row) continue;

    const range = parseRange(row.område);
    if (!range) continue;

    const { from, to, label } = range;
    const tid = row.tid;
    if (!tid) continue;

    if (!latestTid || tidToNum(tid) > tidToNum(latestTid)) latestTid = tid;

    const candidates = [
      { ejkat: "1", val: row.parcel },
      { ejkat: "2", val: row.ejer },
      { ejkat: "3", val: row.fritid },
    ];

    for (const c of candidates) {
      if (!c.val || c.val <= 0) continue;
      const key = `${tid}|${c.ejkat}`;
      if (!temp.has(key)) temp.set(key, []);
      temp.get(key).push({ from, to, val: c.val, label });
      rows++;
    }
  }

  if (rows === 0) {
    const sample = lines.slice(0, 8).join("\n");
    throw new Error(
      "Kunne ikke parse nogen rækker fra datafilen.\n" +
      "Første linjer:\n" + sample + "\n\n" +
      'TIP: Linjer skal ligne fx: "Realiseret handelspris ""2025K4"" ""1500-1799 Kbh.V."" .. 78290 0"'
    );
  }

  const finalMap = new Map();
  for (const [key, arr] of temp.entries()) {
    arr.sort((a, b) => a.from - b.from);
    finalMap.set(key, arr);
  }

  intervalsByKey = finalMap;
  latestTidGlobal = latestTid;
  meta = { rows, loadedAt: new Date().toISOString(), file: DATA_FILE };

  console.log("Loaded local BM011:", { ...meta, latestTid: latestTidGlobal, keys: intervalsByKey.size });
}

// load on startup
loadLocalCsv();

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "dkbv-node-local", ...meta, latestTid: latestTidGlobal });
});

app.post("/reload", (req, res) => {
  if (ADMIN_TOKEN) {
    const token = String(req.headers["x-admin-token"] || "");
    if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    loadLocalCsv();
    res.json({ ok: true, message: "Reloaded", ...meta, latestTid: latestTidGlobal });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Main: smarter fallback
app.post("/bm011", (req, res) => {
  try {
    const postnrStr = String(req.body?.postnr || "").replace(/\D/g, "").slice(0, 4);
    const requestedEjkat = String(req.body?.ejkat || "2").trim(); // "1","2","3"
    const tidIn = String(req.body?.tid || "latest").trim();

    if (postnrStr.length !== 4) return res.status(400).json({ ok: false, error: "postnr skal være 4 cifre" });
    if (!["1", "2", "3"].includes(requestedEjkat)) return res.status(400).json({ ok: false, error: "ejkat skal være 1, 2 eller 3" });

    const tid = resolveTid(tidIn);
    if (!tid) return res.status(500).json({ ok: false, error: "Ingen Tid i datafilen (latestTid mangler)" });

    const postnrNum = Number(postnrStr);
    const order = fallbackOrder(requestedEjkat);

    // 1) Prøv exact match i ønsket kategori, ellers de andre
    let chosen = null;
    let usedEjkat = null;
    let matchType = "exact";

    for (const ejkat of order) {
      const list = intervalsByKey.get(`${tid}|${ejkat}`);
      const hit = findExact(list, postnrNum);
      if (hit && Number.isFinite(hit.val)) {
        chosen = hit;
        usedEjkat = ejkat;
        matchType = "exact";
        break;
      }
    }

    // 2) Hvis stadig ingen, prøv nearest interval (smart fallback)
    if (!chosen) {
      for (const ejkat of order) {
        const list = intervalsByKey.get(`${tid}|${ejkat}`);
        const near = findNearest(list, postnrNum);
        if (near && Number.isFinite(near.val)) {
          chosen = near;
          usedEjkat = ejkat;
          matchType = "nearest";
          break;
        }
      }
    }

    if (!chosen) {
      return res.status(404).json({
        ok: false,
        error: "Ingen m²-pris fundet for dette postnr i nogen kategori (hverken exact eller nearest).",
        kvartal: tid
      });
    }

    return res.json({
      ok: true,
      m2_price: chosen.val,
      kvartal: tid,
      pris_code: "REAL",
      requested_ejkat: requestedEjkat,
      used_ejkat: usedEjkat,
      fallback: usedEjkat !== requestedEjkat,
      match_type: matchType,
      matched_range: `${chosen.label}`,
      source: "local_interval_smart",
      file_rows: meta.rows
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));