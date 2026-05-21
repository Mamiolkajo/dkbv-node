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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// In-memory index: `${postnr}|${ejkat}|REAL|${tid}` -> value
let index = new Map();
let latestTidGlobal = null;
let meta = { rows: 0, loadedAt: null, file: DATA_FILE };

function parseNum(val) {
  const s = String(val ?? "").trim();
  if (!s || s === "..") return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Læs som tekst (prøv utf8, fallback latin1 hvis mange  )
function readTextSmart(filePath) {
  const buf = fs.readFileSync(filePath);
  const utf8 = buf.toString("utf8");
  const bad = (utf8.match(/ /g) || []).length;
  if (bad >= 2) return buf.toString("latin1");
  return utf8;
}

// Fjern yderste quotes og af-escape "" -> "  (CSV-standard) [1](https://stackoverflow.com/questions/17808511/how-to-properly-escape-a-double-quote-in-csv)
function unquoteWholeLine(line) {
  let s = String(line).trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
    s = s.replace(/""/g, '"');
  }
  return s;
}

// Parser én datalinje i din eksport
function parseBm011Line(line) {
  let s = unquoteWholeLine(line).trim();
  if (!s) return null;

  // Hvis den er tab-separeret (nogle eksport gør det), håndter det:
  if (s.includes("\t")) {
    const cols = s.split("\t").map(x => x.trim()).filter(Boolean);
    // forvent: Realiseret handelspris | "2025K4" | "2100 København Ø" | .. | 76703 | 0
    if (cols.length < 6) return null;

    const tid = cols[1].replace(/^"+|"+$/g, "");
    const område = cols[2].replace(/^"+|"+$/g, "");
    const postMatch = område.match(/^(\d{4})/);
    if (!postMatch) return null;

    return {
      tid,
      postnr: postMatch[1],
      parcel: parseNum(cols[3]),
      ejer: parseNum(cols[4]),
      fritid: parseNum(cols[5])
    };
  }

  // Ellers: din nuværende fil er space-separated med quoted felter:
  // Realiseret handelspris "2025K4" "1000-1499 Kbh.K." .. 79322 0
  // Vi matcher den struktur direkte
  const m = s.match(/^Realiseret handelspris\s+"([^"]+)"\s+"([^"]+)"\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i);
  if (!m) return null;

  const tid = m[1].trim();
  const område = m[2].trim();
  const postMatch = område.match(/^(\d{4})/);
  if (!postMatch) return null;

  return {
    tid,
    postnr: postMatch[1],
    parcel: parseNum(m[3]),
    ejer: parseNum(m[4]),
    fritid: parseNum(m[5])
  };
}

function loadLocalCsv() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`Mangler datafil: ${DATA_FILE}`);
  }

  const raw = readTextSmart(DATA_FILE);
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);

  const newIndex = new Map();
  let latestTid = null;

  for (const line of lines) {
    const row = parseBm011Line(line);
    if (!row) continue;

    const { tid, postnr, parcel, ejer, fritid } = row;
    const pris = "REAL";

    // ejkat: 1=parcel, 2=ejerlejlighed, 3=fritid
    if (parcel && parcel > 0) newIndex.set(`${postnr}|1|${pris}|${tid}`, parcel);
    if (ejer && ejer > 0)     newIndex.set(`${postnr}|2|${pris}|${tid}`, ejer);
    if (fritid && fritid > 0) newIndex.set(`${postnr}|3|${pris}|${tid}`, fritid);

    if (!latestTid || tid > latestTid) latestTid = tid;
  }

  if (newIndex.size === 0) {
    const sample = lines.slice(0, 8).join("\n");
    throw new Error(
      "Kunne ikke parse nogen rækker fra datafilen.\n" +
      "Første linjer:\n" + sample + "\n\n" +
      "TIP: Filen skal indeholde rækker der ligner:\n" +
      'Realiseret handelspris "2025K4" "2100 København Ø" .. 76703 0'
    );
  }

  index = newIndex;
  latestTidGlobal = latestTid;
  meta = { rows: newIndex.size, loadedAt: new Date().toISOString(), file: DATA_FILE };

  console.log("Loaded local BM011:", { ...meta, latestTid: latestTidGlobal });
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

// main endpoint
app.post("/bm011", (req, res) => {
  try {
    const postnr = String(req.body?.postnr || "").replace(/\D/g, "").slice(0, 4);
    const ejkat  = String(req.body?.ejkat || "2").trim();
    const tidIn  = String(req.body?.tid || "latest").trim();

    if (postnr.length !== 4) return res.status(400).json({ ok: false, error: "postnr skal være 4 cifre" });
    if (!["1", "2", "3"].includes(ejkat)) return res.status(400).json({ ok: false, error: "ejkat skal være 1, 2 eller 3" });

    const tid = resolveTid(tidIn);
    if (!tid) return res.status(500).json({ ok: false, error: "Ingen Tid i datafilen (latestTid mangler)" });

    const pris = "REAL";
    const key = `${postnr}|${ejkat}|${pris}|${tid}`;
    const m2 = index.get(key);

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
      pris_code: pris,
      source: "local_file",
      file_rows: meta.rows
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));