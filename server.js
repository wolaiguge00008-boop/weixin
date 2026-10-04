/**
 * wechat-news-ai-bot — Node 服务器版（零依赖，Node 18+ 直接跑）
 * 由 Cloudflare Worker 版 (src/index.js) 移植：
 *   - KV 缓存 → 本地 data/ 目录 JSON 文件
 *   - 每10分钟 Cron 扫描 → setInterval 10 分钟
 *   - Secrets   → 同目录 config.js（勿外传）
 * 用法：node server.js   （端口 PORT，默认 3000）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGNES_API_BASE, AGNES_API_KEY, AGNES_MODEL, ADMIN_KEY } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── 本地文件版 KV（等价 Worker 的 NEWS_CACHE）──
const kvPath = (k) => path.join(DATA_DIR, String(k).replace(/[^a-z0-9_-]/gi, "_") + ".json");
async function kvGet(key) {
  try { return JSON.parse(fs.readFileSync(kvPath(key), "utf8")); } catch { return null; }
}
async function kvSet(key, val) {
  const v = typeof val === "string" ? val : val;
  fs.writeFileSync(kvPath(key), JSON.stringify(v ?? null));
}

// ── 代理支持：国内服务器直连不了 Google/GDELT，部署时设 PROXY=http://127.0.0.1:10808 即可。
//    海外服务器留空，Node 原生直连（undici 是 Node 内建，零额外依赖）。──
async function setupProxy() {
  const proxy = process.env.PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) return;
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent({ uri: proxy }));
    console.log("[proxy] using", proxy);
  } catch (e) {
    console.warn("[proxy] undici unavailable, falling back to direct:", e.message);
  }
}

// ── 与原 Worker 完全一致的抓取/去重/AI 逻辑 ──
function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
const GDELT_QUERIES = [
  '("黄金" OR "XAU" OR "gold price")',
  '("白银" OR "XAG" OR "silver price")',
  '("Federal Reserve" OR "美联储" OR "CPI" OR "非农" OR "rate hike" OR "特朗普" OR "Trump" OR "Iran" OR "Israel" OR "Russia Ukraine" OR "crude oil" OR "人民币" OR "中国" OR "A股")',
];
const GNEWS_QUERIES = [
  "黄金 XAU 白银 美联储",
  "Trump 伊朗 以色列 中东",
  "俄乌 原油 人民币 中国 A股",
];
const MAX_PER_SOURCE = 8, AI_ITEM_CAP = 20, PROCESSED_CAP = 400;

const log = (level, msg) => console.log(`[${new Date().toISOString()}] ${level} ${msg}`);

async function fetchJSON(url, ms = 12000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function fetchText(url, ms = 12000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}
async function fetchGdelt(query) {
  const u = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent(query) +
    "&mode=artlist&format=json&maxrecords=" + MAX_PER_SOURCE + "&sort=datedesc&timespan=2d";
  const data = await fetchJSON(u);
  const art = (data.artifacts || data.data || []);
  return art.slice(0, MAX_PER_SOURCE).map((a) => ({
    title: (a.title || "").trim(), url: a.url || "", source: "GDELT",
    time: a.seendate ? new Date(a.seendate, 0).toISOString() : "", domain: a.domain || "",
  })).filter((o) => o.title || o.url);
}
async function fetchGNews(q) {
  const u = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=zh-CN&gl=CN&ce=9";
  const xml = await fetchText(u);
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < MAX_PER_SOURCE) {
    const block = m[1];
    const pick = (tag) => {
      const mm = block.match(new RegExp("<" + tag + ">([\\s\\S]*?)<\\/" + tag + ">"));
      return mm ? mm[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
    };
    const title = pick("title"), url = pick("link"), pub = pick("pubDate");
    if (!title && !url) continue;
    items.push({ title, url, source: "GoogleNews", time: pub ? new Date(pub).toISOString() : "", domain: "" });
  }
  return items;
}
function normTitle(t) { return (t || "").replace(/\s+/g, " ").trim().slice(0, 80); }
async function gatherNews() {
  const results = { gdelt: [], gnews: [] };
  const t0 = Date.now();
  const jobs = [
    ...GDELT_QUERIES.map((q) => fetchGdelt(q).then((x) => results.gdelt.push(...x)).catch((e) => log("WARN", "source=GDELT fail=" + e.message))),
    ...GNEWS_QUERIES.map((q) => fetchGNews(q).then((x) => results.gnews.push(...x)).catch((e) => log("WARN", "source=GoogleNews fail=" + e.message))),
  ];
  await Promise.all(jobs);
  const all = [...results.gdelt, ...results.gnews];
  const seen = new Set();
  const dedup = [];
  for (const it of all) {
    if (!it.title && !it.url) continue;
    const h = hashStr((it.url || it.title).toLowerCase() + "|" + normTitle(it.title));
    if (seen.has(h)) continue;
    seen.add(h); it.hash = h; dedup.push(it);
  }
  dedup.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  log("INFO", `scan found=${all.length} dedup=${dedup.length} ms=${Date.now() - t0}`);
  return dedup;
}
async function summarize(items) {
  if (!AGNES_API_KEY) throw new Error("AGNES_API_KEY 未配置（config.js）");
  const base = AGNES_API_BASE.replace(/\/$/, "");
  const payload = items.slice(0, AI_ITEM_CAP).map((it, i) =>
    `${i + 1}. ${it.title || "(无标题)"}\n   来源:${it.source}${it.domain ? "/" + it.domain : ""}\n   时间:${it.time || "未知"}\n   链接:${it.url || "无"}`).join("\n");
  const r = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + AGNES_API_KEY },
    body: JSON.stringify({
      model: AGNES_MODEL,
      messages: [
        { role: "system", content: "你是贵金属/宏观新闻分析助手。仅基于给定新闻作答，用中文。按时间排序；去重；区分事实与观点；每条标来源与时间；重大新闻标利多/利空/中性；不虚构数据。" },
        { role: "user", content: "以下是最近抓取到的新闻，请按要求分析：\n" + payload },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error("Agnes HTTP " + r.status);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content) || "";
}

// ── 定时扫描（等价 Worker 的 scheduled cron */10）──
let scanning = false;
async function runScan(trigger) {
  if (scanning) return { ok: true, skipped: true, trigger };
  scanning = true;
  const t0 = Date.now();
  try {
    const items = await gatherNews();
    const processed = (await kvGet("processed_urls")) || [];
    const pset = new Set(processed);
    const fresh = items.filter((it) => !pset.has(it.hash)).slice(0, AI_ITEM_CAP);
    let summary = "", aiOk = false;
    if (fresh.length > 0) {
      try { summary = await summarize(fresh); aiOk = !!summary.trim(); }
      catch (e) { log("WARN", "ai=fail " + e.message); summary = fresh.map((it, i) => `${i + 1}. ${it.title || ""} [${it.source}]`).join("\n"); }
      await kvSet("processed_urls", [...fresh.map((f) => f.hash), ...processed].slice(0, PROCESSED_CAP));
      await kvSet("last_items", fresh);
      await kvSet("last_summary", { text: summary, aiOk, at: new Date().toISOString(), count: fresh.length });
    }
    await kvSet("lastfetch:scan", new Date().toISOString());
    log("INFO", `cron scanned fresh=${fresh.length} ai=${aiOk ? "ok" : "fallback"} trigger=${trigger} ms=${Date.now() - t0}`);
    return { ok: true, scanned: items.length, fresh: fresh.length, aiOk };
  } catch (e) {
    log("ERROR", "scan error " + e.message);
    await kvSet("last_error", { at: new Date().toISOString(), msg: e.message }).catch?.(() => {});
    return { ok: false, error: e.message };
  } finally { scanning = false; }
}
const CRON_MS = 10 * 60 * 1000;
setInterval(() => runScan("cron"), CRON_MS);

// ── HTTP 服务（端点与 Worker 版一致）──
const PORT = Number(process.env.PORT) || 3000;
const jsonResp = (res, obj, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};
const textResp = (res, s, code = 200) => {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(s);
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  if (req.method === "GET" && p === "/") return textResp(res, "wechat-news-ai-bot OK");
  if (req.method === "GET" && p === "/health") return jsonResp(res, { ok: true, service: "wechat-news-ai-bot" });
  if (req.method === "GET" && p === "/news") {
    const last = await kvGet("last_summary");
    return jsonResp(res, { ok: !!last, ...(last || {}) });
  }
  if (req.method === "POST" && p === "/wechat") {
    let body = {};
    try { body = JSON.parse(await new Promise((rv) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => rv(d || "{}")); })); } catch {}
    const last = await kvGet("last_summary");
    const items = (await kvGet("last_items")) || [];
    await kvSet("last_webhook", { at: new Date().toISOString(), type: body.msgtype || "unknown" });
    log("INFO", `wechat webhook type=${body.msgtype || "unknown"}`);
    return jsonResp(res, {
      status: "ok", service: "wechat-news-ai-bot", has_summary: !!last,
      summary: last ? last.text : (items.length ? items.map((i) => i.title || "").join(" | ") : "暂无最新新闻，等待下一次扫描"),
      ai_ok: last ? last.aiOk : false, updated_at: last ? last.at : null, items_count: items.length,
    });
  }
  if (req.method === "POST" && p === "/admin/scan") {
    const auth = req.headers.get?.("authorization") || req.headers["authorization"] || "";
    if (ADMIN_KEY && auth !== "Bearer " + ADMIN_KEY) return jsonResp(res, { ok: false, error: "unauthorized" }, 401);
    return jsonResp(res, await runScan("manual"));
  }
  return jsonResp(res, { ok: false, error: "not found" }, 404);
});
server.listen(PORT, () => log("INFO", `wechat-news-ai-bot(node) listening on :${PORT}，首次扫描 10s 后启动，之后每 10 分钟`));
setTimeout(() => runScan("startup"), 10000);
// 代理支持（可选）：设了 PROXY 才启用，海外直连则自动跳过、零影响
setupProxy();
