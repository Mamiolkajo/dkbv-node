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

// Valgfrit: beskyt reload-endpoint
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// In-memory: intervaller pr (tid, ejkat) => sorteret array til binær søgning
// key = `${tid}|${ejkat}` -> [{from,to,val}]
let intervalsByKey = new Map();
let latestTidGlobal = null;
let meta = { rows: 0, loadedAt: null, file: DATA_FILE };

function parseNum(val) {
  const s = String(val ?? "").trim();
  if (!s || s === "..") return null;
  // håndter 45.123 / 45,123 / 45123
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

// CSV-standard: hvis en hel linje er quoted og indeholder "" -> "  (escaped quotes)
function unquoteWholeLine(line) {
  let s = String(line).trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
    s = s.replace(/""/g, '"');
  }
  return s;
}

// Konverter tid til tal så "latest" er robust (2025K4 > 2025K3)
function tidToNum(tid) {
  const m = String(tid).match(/^(\d{4})[KQ]([1-4])$/i);
  if (!m) return -1;
  return Number(m[1]) * 10 + Number(m[2]);
}

// Parse én datalinje fra din eksport.
// Understøtter både tab-separeret og space-separeret med quoted felter.
function parseBm011Line(line) {
  let s = unquoteWholeLine(line).trim();
  if (!s) return null;

  // 1) TAB-separeret variant
  if (s.includes("\t")) {
    const cols = s.split("\t").map(x => x.trim()).filter(x => x.length > 0);
    // forvent: Realiseret handelspris | "2025K4" | "1500-1799 Kbh.V." | .. | 78290 | 0
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

  // 2) Space-separeret variant (som du viste):
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
  if (r) return { from: Number(r[1]), to: Number(r[2]) };

  const one = s.match(/^(\d{4})/);
  if (one) {
    const p = Number(one[1]);
    return { from: p, to: p };
  }
  return null;
}

// Binær søgning i sorteret interval-liste
function findInIntervals(list, postnrNum) {
  if (!list || list.length === 0) return null;

  let lo = 0, hi = list.length - 1;
  let best = -1;

  // find sidste interval med from <= postnr
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].from <= postnrNum) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best === -1) return null;
  const it = list[best];
  return (postnrNum >= it.from && postnrNum <= it.to) ? it.val : null;
}

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

    const { from, to } = range;
    const tid = row.tid;
    if (!tid) continue;

    // seneste tid
    if (!latestTid || tidToNum(tid) > tidToNum(latestTid)) latestTid = tid;

    // ejkat mapping:
    // 1 = parcel, 2 = ejerlejlighed, 3 = fritid
    const candidates = [
      { ejkat: "1", val: row.parcel },
      { ejkat: "2", val: row.ejer },
      { ejkat: "3", val: row.fritid },
    ];

    for (const c of candidates) {
      if (!c.val || c.val <= 0) continue;
      const key = `${tid}|${c.ejkat}`;
      if (!temp.has(key)) temp.set(key, []);
      temp.get(key).push({ from, to, val: c.val });
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

  // sortér intervaller pr key så binær søgning virker
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

function resolveTid(tid) {
  if (!tid || tid === "latest" || tid === "seneste") return latestTidGlobal;
  return tid;
}

// health
app.get("/", (req, res) => {
  res.json({ ok: true, service: "dkbv-node-local", ...meta, latestTid: latestTidGlobal });
});

// reload (valgfrit)
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

// main endpoint (hurtig lookup)
app.post("/bm011", (req, res) => {
  try {
    const postnrStr = String(req.body?.postnr || "").replace(/\D/g, "").slice(0, 4);
    const ejkat = String(req.body?.ejkat || "2").trim(); // "1","2","3"
    const tidIn = String(req.body?.tid || "latest").trim();

    if (postnrStr.length !== 4) return res.status(400).json({ ok: false, error: "postnr skal være 4 cifre" });
    if (!["1", "2", "3"].includes(ejkat)) return res.status(400).json({ ok: false, error: "ejkat skal være 1, 2 eller 3" });

    const tid = resolveTid(tidIn);
    if (!tid) return res.status(500).json({ ok: false, error: "Ingen Tid i datafilen (latestTid mangler)" });

    const key = `${tid}|${ejkat}`;
    const list = intervalsByKey.get(key);
    const postnrNum = Number(postnrStr);

    const m2 = findInIntervals(list, postnrNum);

    if (!Number.isFinite(m2)) {
      return res.status(404).json({
        ok: false,
        error: "Ingen m²-pris fundet i filen for postnr/ejkat/tid",
        kvartal: tid
      });
    }

    return res.json({
      ok: true,
      m2_price: m2,
      kvartal: tid,
      pris_code: "REAL",
      source: "local_interval",
      file_rows: meta.rows
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));