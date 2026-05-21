import fs from "fs";
import path from "path";
import express from "express";

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const DATA_FILE = path.join(process.cwd(), "data", "bm011_latest.csv");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// key = `${tid}|${ejkat}` -> [{from,to,val,label}]
let intervalsByKey = new Map();
let tidsDesc = []; // nyeste -> ældste
let latestTidGlobal = null;
let meta = { rows: 0, loadedAt: null, file: DATA_FILE };

// --- helpers ---
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

// CSV-standard: hvis linjen er "...." og indeholder "" -> " [1](https://stackoverflow.com/questions/17808511/how-to-properly-escape-a-double-quote-in-csv)
function unquoteWholeLine(line) {
  let s = String(line).trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
    s = s.replace(/""/g, '"');
  }
  return s;
}

// fx 2025K4 -> 20254
function tidToNum(tid) {
  const m = String(tid).match(/^(\d{4})[KQ]([1-4])$/i);
  if (!m) return -1;
  return Number(m[1]) * 10 + Number(m[2]);
}

function resolveTidParam(tid) {
  if (!tid || tid === "latest" || tid === "seneste") return "latest";
  return tid;
}

function fallbackOrder(requestedEjkat) {
  // kun brugt hvis vi slet ikke kan finde nok data i ønsket kategori
  if (requestedEjkat === "1") return ["1", "2", "3"];
  if (requestedEjkat === "2") return ["2", "1", "3"];
  if (requestedEjkat === "3") return ["3", "1", "2"];
  return ["2", "1", "3"];
}

// Parse linje fra din eksport:
// Realiseret handelspris "2025K4" "1500-1799 Kbh.V." .. 78290 0
function parseBm011Line(line) {
  let s = unquoteWholeLine(line).trim();
  if (!s) return null;

  // TAB variant (hvis den dukker op)
  if (s.includes("\t")) {
    const cols = s.split("\t").map(x => x.trim()).filter(Boolean);
    if (cols.length < 6) return null;
    if (!cols[0].toLowerCase().includes("realiseret")) return null;

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

// "1500-1799 Kbh.V." -> {from:1500,to:1799,label:"1500-1799"}
// "2100 København Ø" -> {from:2100,to:2100,label:"2100"}
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

// Binær søgning: find interval der indeholder postnr (exact)
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
  return (postnrNum >= it.from && postnrNum <= it.to) ? it : null;
}

// nearest (bruges kun hvis vi mangler *alt* i kategorien)
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

// Find “window” på 4 kvartaler (nyeste->ældre)
function getWindowTids(anchorTid) {
  if (!tidsDesc.length) return [];
  if (!anchorTid || anchorTid === "latest") return tidsDesc.slice(0, 4);

  const idx = tidsDesc.indexOf(anchorTid);
  if (idx === -1) {
    // hvis brugeren sender en tid der ikke findes, fald tilbage til latest window
    return tidsDesc.slice(0, 4);
  }
  return tidsDesc.slice(idx, idx + 4);
}

function avg(nums) {
  const valid = nums.filter(n => Number.isFinite(n));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// --- load data ---
function loadLocalCsv() {
  if (!fs.existsSync(DATA_FILE)) throw new Error(`Mangler datafil: ${DATA_FILE}`);

  const raw = readTextSmart(DATA_FILE);
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);

  const temp = new Map();
  const tidSet = new Set();
  let rows = 0;

  for (const line of lines) {
    const row = parseBm011Line(line);
    if (!row) continue;

    const range = parseRange(row.område);
    if (!range) continue;

    const { from, to, label } = range;
    const tid = row.tid;
    if (!tid) continue;

    tidSet.add(tid);

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
    throw new Error("Kunne ikke parse nogen rækker fra datafilen.\nFørste linjer:\n" + sample);
  }

  const finalMap = new Map();
  for (const [key, arr] of temp.entries()) {
    arr.sort((a, b) => a.from - b.from);
    finalMap.set(key, arr);
  }

  intervalsByKey = finalMap;
  tidsDesc = [...tidSet].sort((a, b) => tidToNum(b) - tidToNum(a));
  latestTidGlobal = tidsDesc[0] || null;

  meta = { rows, loadedAt: new Date().toISOString(), file: DATA_FILE };
  console.log("Loaded BM011:", { ...meta, latestTid: latestTidGlobal, tidCount: tidsDesc.length });
}

loadLocalCsv();

// --- routes ---
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "dkbv-node-avg4q",
    ...meta,
    latestTid: latestTidGlobal,
    tids: tidsDesc.slice(0, 6)
  });
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

// Main: 4 kvartalers gennemsnit før fallback
app.post("/bm011", (req, res) => {
  try {
    const postnrStr = String(req.body?.postnr || "").replace(/\D/g, "").slice(0, 4);
    const requestedEjkat = String(req.body?.ejkat || "2").trim();
    const tidParam = resolveTidParam(String(req.body?.tid || "latest").trim());
    const debug = req.body?.debug === true;

    if (postnrStr.length !== 4) return res.status(400).json({ ok: false, error: "postnr skal være 4 cifre" });
    if (!["1", "2", "3"].includes(requestedEjkat)) return res.status(400).json({ ok: false, error: "ejkat skal være 1, 2 eller 3" });

    const postnrNum = Number(postnrStr);
    const windowTids = getWindowTids(tidParam);

    if (!windowTids.length) {
      return res.status(500).json({ ok: false, error: "Ingen tidsdata i filen." });
    }

    // 1) Prøv requested kategori på alle 4 kvartaler (exact) og beregn gennemsnit
    const exactVals = [];
    const exactUsed = [];

    for (const tid of windowTids) {
      const list = intervalsByKey.get(`${tid}|${requestedEjkat}`);
      const hit = findExact(list, postnrNum);
      if (hit && Number.isFinite(hit.val)) {
        exactVals.push(hit.val);
        exactUsed.push({ tid, range: hit.label, val: hit.val });
      }
    }

    // hvis vi har mindst 2 observationer -> gennemsnit (stabilt)
    if (exactVals.length >= 2) {
      const mean = avg(exactVals);
      return res.json({
        ok: true,
        m2_price: Math.round(mean),
        method: "avg_4q_exact",
        sample_count: exactVals.length,
        tids_window: windowTids,
        requested_ejkat: requestedEjkat,
        used_ejkat: requestedEjkat,
        category_fallback: false,
        match_type: "exact",
        source: "local_avg4q",
        ...(debug ? { samples: exactUsed } : {})
      });
    }

    // hvis vi kun har 1 observation -> brug den (men markér at det er svagere)
    if (exactVals.length === 1) {
      return res.json({
        ok: true,
        m2_price: exactVals[0],
        method: "single_exact_in_window",
        sample_count: 1,
        tids_window: windowTids,
        requested_ejkat: requestedEjkat,
        used_ejkat: requestedEjkat,
        category_fallback: false,
        match_type: "exact",
        source: "local_avg4q",
        ...(debug ? { samples: exactUsed } : {})
      });
    }

    // 2) Hvis der intet findes i requested kategori: prøv NEAREST inden vi skifter kategori
    const nearVals = [];
    const nearUsed = [];
    for (const tid of windowTids) {
      const list = intervalsByKey.get(`${tid}|${requestedEjkat}`);
      const near = findNearest(list, postnrNum);
      if (near && Number.isFinite(near.val)) {
        nearVals.push(near.val);
        nearUsed.push({ tid, range: near.label, val: near.val });
      }
    }
    if (nearVals.length >= 2) {
      const mean = avg(nearVals);
      return res.json({
        ok: true,
        m2_price: Math.round(mean),
        method: "avg_4q_nearest",
        sample_count: nearVals.length,
        tids_window: windowTids,
        requested_ejkat: requestedEjkat,
        used_ejkat: requestedEjkat,
        category_fallback: false,
        match_type: "nearest",
        source: "local_avg4q",
        ...(debug ? { samples: nearUsed } : {})
      });
    }
    if (nearVals.length === 1) {
      return res.json({
        ok: true,
        m2_price: nearVals[0],
        method: "single_nearest_in_window",
        sample_count: 1,
        tids_window: windowTids,
        requested_ejkat: requestedEjkat,
        used_ejkat: requestedEjkat,
        category_fallback: false,
        match_type: "nearest",
        source: "local_avg4q",
        ...(debug ? { samples: nearUsed } : {})
      });
    }

    // 3) Først NU: kategori-fallback (prøv andre ejkat med samme 4 kvartaler)
    const cats = fallbackOrder(requestedEjkat).filter(c => c !== requestedEjkat);

    for (const cat of cats) {
      const vals = [];
      const used = [];
      for (const tid of windowTids) {
        const list = intervalsByKey.get(`${tid}|${cat}`);
        const hit = findExact(list, postnrNum);
        if (hit && Number.isFinite(hit.val)) {
          vals.push(hit.val);
          used.push({ tid, range: hit.label, val: hit.val });
        }
      }
      if (vals.length >= 2) {
        const mean = avg(vals);
        return res.json({
          ok: true,
          m2_price: Math.round(mean),
          method: "avg_4q_category_fallback_exact",
          sample_count: vals.length,
          tids_window: windowTids,
          requested_ejkat: requestedEjkat,
          used_ejkat: cat,
          category_fallback: true,
          match_type: "exact",
          source: "local_avg4q",
          ...(debug ? { samples: used } : {})
        });
      }
      if (vals.length === 1) {
        return res.json({
          ok: true,
          m2_price: vals[0],
          method: "single_category_fallback_exact",
          sample_count: 1,
          tids_window: windowTids,
          requested_ejkat: requestedEjkat,
          used_ejkat: cat,
          category_fallback: true,
          match_type: "exact",
          source: "local_avg4q",
          ...(debug ? { samples: used } : {})
        });
      }
    }

    return res.status(404).json({
      ok: false,
      error: "Ingen m²-pris fundet i de seneste 4 kvartaler (heller ikke med kategori-fallback).",
      tids_window: windowTids
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));