import express from "express";
import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

const ORIGIN = "https://rkr.statbank.dk";
const PT_DA_URL = `${ORIGIN}/statbank5a/PTda.asp`;
const DEFINE_URL =
  `${ORIGIN}/statbank5a/SelectVarVal/Define.asp?MainTable=BM011&PLanguage=0&PXSId=0&wsid=cflastupd`;
const SAVE_URL = `${ORIGIN}/statbank5a/SelectVarVal/saveselections.asp`;
const SHOWTABLE_URL = `${ORIGIN}/statbank5a/SelectVarVal/ShowTable.asp`;

// Cache (1 time)
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE = new Map();
function cacheGet(key) {
  const v = CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return v.data;
}
function cacheSet(key, data) {
  CACHE.set(key, { t: Date.now(), data });
}

function baseHeaders(referer) {
  const h = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Origin": ORIGIN,
  };
  if (referer) h["Referer"] = referer;
  return h;
}

// rkr bruger ofte iso-8859-1 => brug arrayBuffer + TextDecoder [1](https://oddjar.com/gravity-forms-calculations-pricing-fields-order-forms-guide/)[2](https://vaekster.dk/blog/fa-lavet-en-prisberegnertilbudsberegner-til-wordpress-leadmagnet-der-konverterer/)
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

async function unwrapFrames(fetchCookie, html, referer) {
  let current = decodeEntities(html);
  for (let i = 0; i < 6; i++) {
    if (!looksLikeFrameset(current)) return current;
    const src = extractFrameSrc(current);
    if (!src) return current;

    await sleep(1200);
    const r = await fetchCookie(src, { headers: baseHeaders(referer) });
    current = decodeEntities(await readHtml(r));
    referer = src;
  }
  return current;
}

function isDbDown(html) {
  const h = html.toLowerCase();
  return h.includes("/dbdown/") || h.includes("dbdown") || h.includes("msgid=");
}

function findLatestQuarterCode(html) {
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

function buildSelectionBody({ postnr, ejkat, pris, tid }) {
  const p = new URLSearchParams();

  // VIGTIGT: normal & (URLSearchParams encoder selv)
  p.set("TS", "ShowTable&OldTab=SELECT&SubjectCode=201&AntVar=4&Contents=Indhold&tidrubr=rubrik4");

  p.set("PLanguage", "0");
  p.set("FF", "20");
  p.set("OldTab", "SELECT");
  p.set("SavePXSId", "0");

  p.set("grouping1", "");
  p.set("var1", postnr);

  p.set("grouping2", "");
  p.set("var2", ejkat);

  p.set("grouping3", "");
  p.set("var3", pris);

  p.set("rubrik4", "kvartal");
  p.set("grouping4", "");
  p.set("var4", tid);

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

  p.set("V1", "PNR20");
  p.set("VS1", "VM20PNR11");
  p.set("VP1", "postnumre");

  p.set("V2", "EJKAT20");
  p.set("VS2", "VM20EJKAT011");
  p.set("VP2", "ejendomskategori");

  p.set("V3", "PRIS20");
  p.set("VS3", "VM20PRIS011");
  p.set("VP3", "priser på realiserede handler");

  p.set("V4", "Tid");
  p.set("VS4", "");
  p.set("VP4", "");
  p.set("boksnr", "");
  p.set("tfrequency", "4");

  return p.toString();
}

// Find "INDHOLD" tal i table (når der kun er 1 celle)
function extractIndholdFromHtml(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    const lower = table.toLowerCase();
    if (!lower.includes("indhold")) continue;

    const tds = [...table.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((m) => m[1])
      .map((s) => String(s).replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").trim());

    const nums = tds
      .map((s) => s.replace(/\./g, "").replace(",", "."))
      .filter((s) => /^\d+(\.\d+)?$/.test(s))
      .map(Number)
      .filter((n) => Number.isFinite(n))
      .filter((n) => n >= 2000 && n <= 250000);

    if (nums.length === 1) return nums[0];
    if (nums.length > 1) return nums.sort((a, b) => b - a)[0];
  }
  return null;
}

// Retry wrapper (mod DBDown)
async function withDbDownRetry(fn) {
  for (let i = 0; i < 3; i++) {
    const html = await fn();
    if (!isDbDown(html)) return html;
    await sleep(5000);
  }
  return null;
}

app.get("/", (req, res) => res.json({ ok: true, service: "dkbv-node" }));

app.post("/bm011", async (req, res) => {
  try {
    const postnr = String(req.body?.postnr || "").replace(/\D/g, "").slice(0, 4);
    const ejkat = String(req.body?.ejkat || "2"); // 1/2/3
    const pris = String(req.body?.pris || "REAL");
    let tid = String(req.body?.tid || "latest");
    const debug = req.body?.debug === true;

    if (postnr.length !== 4) return res.status(400).json({ ok: false, error: "postnr skal være 4 cifre" });

    const cacheKey = `${postnr}|${ejkat}|${pris}|${tid}`;
    const cached = cacheGet(cacheKey);
    if (cached && !debug) return res.json({ ok: true, ...cached, cached: true });

    // Cookie jar pr request (ASP session cookies) [3](https://w3schoolofcoding.com/php-parse-syntax-errors-and-how-to-solve-them/)[4](https://www.statistikbanken.dk/statbank5a/selectvarval/define.asp?MainTable=EJ67)
    const jar = new CookieJar();
    const fetchCookie = makeFetchCookie(fetch, jar);

    // 1) Dansk sprog
    await fetchCookie(PT_DA_URL, { headers: baseHeaders() });
    await sleep(1200);

    // 2) Define => latest kvartal
    const defineResp = await fetchCookie(DEFINE_URL, { headers: baseHeaders() });
    const defineHtml = decodeEntities(await readHtml(defineResp));

    if (!tid || tid === "latest" || tid === "seneste") {
      const latest = findLatestQuarterCode(defineHtml);
      if (!latest) return res.status(502).json({ ok: false, error: "Kunne ikke finde seneste kvartal" });
      tid = latest;
    }

    // 3) Save selections
    const body = buildSelectionBody({ postnr, ejkat, pris, tid });

    await sleep(1200);
    const saveResp = await fetchCookie(SAVE_URL, {
      method: "POST",
      headers: { ...baseHeaders(DEFINE_URL), "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    let saveHtml = decodeEntities(await readHtml(saveResp));
    saveHtml = await unwrapFrames(fetchCookie, saveHtml, SAVE_URL);

    // 4) ShowTable (med retry mod DBDown)
    const showHtml = await withDbDownRetry(async () => {
      await sleep(1200);
      const showResp = await fetchCookie(SHOWTABLE_URL, { headers: baseHeaders(SAVE_URL) });
      let h = decodeEntities(await readHtml(showResp));
      h = await unwrapFrames(fetchCookie, h, SHOWTABLE_URL);
      return h;
    });

    if (!showHtml) {
      return res.status(503).json({
        ok: false,
        error: "rkr svarer med DBDown (midlertidigt utilgængelig/blokeret). Prøv igen senere."
      });
    }

    const m2 = extractIndholdFromHtml(showHtml);

    if (debug) {
      return res.json({
        ok: true,
        tid_used: tid,
        parsed_m2: m2,
        htmlSnippet: showHtml.slice(0, 2500)
      });
    }

    if (!m2) {
      return res.status(502).json({
        ok: false,
        error: "Fandt ingen m²-pris (INDHOLD) i ShowTable HTML",
        debug: { tid_used: tid, htmlSnippet: showHtml.slice(0, 2500) }
      });
    }

    const result = { m2_price: m2, kvartal: tid };
    cacheSet(cacheKey, result);

    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

