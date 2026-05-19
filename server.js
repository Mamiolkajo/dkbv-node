import express from "express";
import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";

const app = express();
app.use(express.json());

// CORS så din browser/WordPress kan kalde API'et
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const ORIGIN = "https://rkr.statbank.dk";
const PT_DA_URL = `${ORIGIN}/statbank5a/PTda.asp`;
const DEFINE_URL = `${ORIGIN}/statbank5a/SelectVarVal/Define.asp?MainTable=BM011&PLanguage=0&PXSId=0&wsid=cflastupd`;
const SAVE_URL = `${ORIGIN}/statbank5a/SelectVarVal/saveselections.asp`;
const SHOWTABLE_URL = `${ORIGIN}/statbank5a/SelectVarVal/ShowTable.asp`;

function baseHeaders() {
  return {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Origin": ORIGIN
  };
}

// IMPORTANT: rkr svarer ofte med iso-8859-1. response.text() dekoder typisk som UTF-8,
// så vi bruger arrayBuffer + TextDecoder for at undgå “p ” og forkert parsing. [1](https://www.saleswise.ai/blog/real-estate-property-valuation-methods)[2](https://www.dst.dk/en/Statistik/emner/oekonomi/ejendomme)
async function readHtml(resp) {
  const buf = await resp.arrayBuffer();
  const decoder = new TextDecoder("iso-8859-1");
  return decoder.decode(buf);
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function looksLikeFrameset(html) {
  const h = html.toLowerCase();
  return h.includes("<frameset") && h.includes("<frame");
}

function extractFrameSrc(html) {
  const m = html.match(/<frame[^>]+src="([^"]+)"/i);
  if (!m) return null;
  return m[1].startsWith("/") ? ORIGIN + m[1] : m[1];
}

function isDbDown(html) {
  const h = html.toLowerCase();
  return h.includes("/dbdown/") || h.includes("dbdown") || h.includes("msgid=");
}

// Følg frames op til 5 niveauer (typisk 1)
async function unwrapFrames(fetchCookie, html, referer) {
  let current = decodeEntities(html);

  for (let i = 0; i < 5; i++) {
    if (!looksLikeFrameset(current)) return current;
    const src = extractFrameSrc(current);
    if (!src) return current;

    const r = await fetchCookie(src, {
      headers: { ...baseHeaders(), Referer: referer }
    });

    const nextHtml = await readHtml(r);
    current = decodeEntities(nextHtml);
  }
  return current;
}

// Find seneste kvartal ud fra Define-siden
function findLatestQuarterCode(html) {
  // accepter både 2025K4 og 2025Q4
  const re = /\b(19|20)\d{2}[KQ][1-4]\b/g;
  const hits = html.match(re) || [];
  const uniq = [...new Set(hits)];
  if (!uniq.length) return null;
  uniq.sort((a, b) => quarterToNum(b) - quarterToNum(a));
  return uniq[0];
}
function quarterToNum(code) {
  const year = Number(code.slice(0, 4));
  const q = Number(code.slice(5, 6));
  return year * 10 + q;
}

// Byg fuld POST-body (fra din “Copy as cURL”)
function buildSelectionBody({ postnr, ejkat, pris, tid }) {
  const p = new URLSearchParams();

  p.set("TS", "ShowTable&OldTab=SELECT&SubjectCode=201&AntVar=4&Contents=Indhold&tidrubr=rubrik4");
  p.set("PLanguage", "0");
  p.set("FF", "20");
  p.set("OldTab", "SELECT");
  p.set("SavePXSId", "0");

  p.set("grouping1", ""); p.set("var1", postnr);
  p.set("grouping2", ""); p.set("var2", ejkat);
  p.set("grouping3", ""); p.set("var3", pris);

  p.set("rubrik4", "kvartal");
  p.set("grouping4", ""); p.set("var4", tid);

  p.set("valgteceller", "1");
  p.set("Forward.x", "44");
  p.set("Forward.y", "7");
  p.set("tidrubr", "rubrik4");

  p.set("MainTable", "BM011");
  p.set("SubTable", "S0");
  p.set("SelCont", "Indhold");
  p.set("Contents", "Indhold");
  p.set("SubjectCode", "201");
  p.set("SubjectArea", "Boligmarkedsstatistikken");
  p.set("antvar", "4");
  p.set("action", "urval");
  p.set("guest", "-1");
  p.set("GuestFileSize", "20000");
  p.set("MaxFileSize", "20000");

  p.set("V1", "PNR20");   p.set("VS1", "VM20PNR11");     p.set("VP1", "postnumre");
  p.set("V2", "EJKAT20"); p.set("VS2", "VM20EJKAT011");  p.set("VP2", "ejendomskategori");
  p.set("V3", "PRIS20");  p.set("VS3", "VM20PRIS011");   p.set("VP3", "priser på realiserede handler");
  p.set("V4", "Tid");     p.set("VS4", "");              p.set("VP4", "");

  p.set("boksnr", "");
  p.set("tfrequency", "4");

  return p.toString();
}

// Udtræk m²-prisen fra tabellen
// Vi leder kun inde i <table>...</table> og tager "bedste" plausible tal fra den tabel med flest hits.
function extractM2PriceFromHtml(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  if (!tables.length) return null;

  let best = null;
  let bestCount = 0;

  for (const table of tables) {
    const nums = [...table.matchAll(/>(\d{1,3}(?:\.\d{3})+|\d{4,6})</g)]
      .map(m => Number(m[1].replace(/\./g, "")))
      .filter(n => Number.isFinite(n))
      // m²-priser er normalt i tusinder – filtrér små tal væk
      .filter(n => n >= 2000 && n <= 250000);

    if (nums.length > bestCount) {
      bestCount = nums.length;
      // i selve datatabellen er den relevante typisk høj (og > 2000)
      best = nums.sort((a, b) => b - a)[0] || null;
    }
  }

  return best;
}

// Health check
app.get("/", (req, res) => res.json({ ok: true, service: "dkbv-node" }));

// Main endpoint
app.post("/bm011", async (req, res) => {
  try {
    const postnr = String(req.body?.postnr || "").replace(/\D/g, "").slice(0, 4);
    const ejkat  = String(req.body?.ejkat || "2");
    const pris   = String(req.body?.pris || "REAL");
    let tid      = String(req.body?.tid || "latest");
    const debug  = req.body?.debug === true;

    if (postnr.length !== 4) {
      return res.status(400).json({ ok: false, error: "postnr skal være 4 cifre" });
    }

    // Lav en frisk cookie-jar pr request (stabilt)
    const jar = new CookieJar();
    const fetchCookie = makeFetchCookie(fetch, jar);

    // 1) Sæt dansk sprog (ellers kan du ramme PTda.asp-advarsel)
    await fetchCookie(PT_DA_URL, { headers: baseHeaders() });

    // 2) Hent Define for at finde seneste kvartal hvis "latest"
    const defineResp = await fetchCookie(DEFINE_URL, { headers: baseHeaders() });
    let defineHtml = decodeEntities(await readHtml(defineResp));

    if (!tid || tid === "latest" || tid === "seneste") {
      const latest = findLatestQuarterCode(defineHtml);
      if (!latest) {
        return res.status(502).json({
          ok: false,
          error: "Kunne ikke finde seneste kvartal",
          debug: { htmlSnippet: defineHtml.slice(0, 1500) }
        });
      }
      tid = latest;
    }

    // 3) POST valgene
    const body = buildSelectionBody({ postnr, ejkat, pris, tid });

    const saveResp = await fetchCookie(SAVE_URL, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": DEFINE_URL
      },
      body
    });

    let html = decodeEntities(await readHtml(saveResp));
    html = await unwrapFrames(fetchCookie, html, SAVE_URL);

    // 4) Fallback: hent ShowTable direkte (ofte her tabellen ender)
    if (!html.toLowerCase().includes("<table")) {
      const t = await fetchCookie(SHOWTABLE_URL, {
        headers: { ...baseHeaders(), Referer: SAVE_URL }
      });
      html = decodeEntities(await readHtml(t));
      html = await unwrapFrames(fetchCookie, html, SHOWTABLE_URL);
    }

    // Hvis rkr svarer “DBDown”
    if (isDbDown(html)) {
      return res.status(503).json({
        ok: false,
        error: "rkr svarer med DBDown (midlertidigt utilgængelig/blokeret). Prøv igen senere.",
        debug: { htmlSnippet: html.slice(0, 1200) }
      });
    }

    if (debug) {
      return res.json({
        ok: true,
        tid_used: tid,
        htmlSnippet: html.slice(0, 2500)
      });
    }

    // 5) Parse m²-pris
    let m2 = extractM2PriceFromHtml(html);

// 🔥 FALLBACK: hvis ingen tabel (rigtigt fix)
if (!m2) {
  const csvResp = await fetchCookie(SHOWTABLE_URL + "?format=csv", {
    headers: { ...baseHeaders(), Referer: SAVE_URL }
  });

  const csv = await readHtml(csvResp);

  // find tal i CSV
  const nums = [...csv.matchAll(/\d{4,6}/g)]
    .map(m => Number(m[0]))
    .filter(n => n > 2000 && n < 200000);

  if (nums.length) {
    m2 = nums[0];
  }
}

    if (!m2) {
      return res.status(502).json({
        ok: false,
        error: "Fandt ingen m²-pris i HTML",
        debug: { htmlSnippet: html.slice(0, 3000), tid_used: tid }
      });
    }

    return res.json({ ok: true, m2_price: m2, kvartal: tid });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));