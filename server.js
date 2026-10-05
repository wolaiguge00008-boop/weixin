/**
 * wechat-news-ai-bot — 按需新闻搜索版（零依赖，Node 18+）
 *
 * 乐哥铁律（本文件必须遵守）：
 *   1) 用户发新闻类问题时才联网搜索；
 *   2) 用户不发消息 → 绝不搜索；
 *   3) 无 Cron 定时任务；
 *   4) 无循环轮询；
 *   5) 搜索源只用免费 API：GDELT + Google News RSS；
 *   6) 结果送 Agnes 3.0 Flash 总结；
 *   7) 中文回复。
 *
 * 触发关键词：黄金 白银 美元 原油 美股 财经 新闻 行情 市场
 * 普通聊天 → 不调用搜索。
 *
 * 端点：
 *   GET  /health   存活探测
 *   POST /ask      { "q": "黄金现在什么行情" } → 关键词命中才搜索+总结
 *   GET  /ask?q=…  同上（调试用）
 */
import http from "node:http";
import { AGNES_API_BASE, AGNES_API_KEY, AGNES_MODEL } from "./config.js";

const PORT = Number(process.env.PORT) || 3000;
const log = (lvl, m) => console.log(`[${new Date().toISOString()}] ${lvl} ${m}`);

// ── 触发词 → 免费源搜索词（GDELT 英文为主 + Google News 中英）──
const TRIGGERS = ["黄金", "白银", "美元", "原油", "美股", "财经", "新闻", "行情", "市场"];
const TOPIC_QUERIES = {
  黄金: { gdelt: '("gold price" OR "黄金" OR "XAU" OR "COMEX gold")', gnews: ["黄金 金价 XAU 美联储", "gold price Fed"] },
  白银: { gdelt: '("silver price" OR "白银" OR "XAG")', gnews: ["白银 银价 XAG", "silver price"] },
  美元: { gdelt: '("US dollar" OR "dollar index" OR "DXY" OR "美联储")', gnews: ["美元 美联储 加息 CPI", "US dollar Fed CPI DXY"] },
  原油: { gdelt: '("crude oil" OR "OPEC" OR "油价" OR "WTI" OR "Brent")', gnews: ["原油 油价 OPEC WTI", "crude oil OPEC"] },
  美股: { gdelt: '("S&P 500" OR "Nasdaq" OR "Dow Jones" OR "US stocks")', gnews: ["美股 纳斯达克 标普", "US stocks S&P Nasdaq"] },
};
// 宽泛词（财经/新闻/行情/市场）→ 综合搜索
const BROAD_QUERY = {
  gdelt: '("gold" OR "silver" OR "crude oil" OR "Federal Reserve" OR "CPI" OR "A股" OR "China economy")',
  gnews: ["黄金 白银 原油 美联储 财经 行情", "gold silver crude oil Fed markets"],
};

function pickedTopics(text) {
  const hits = TRIGGERS.filter((k) => (text || "").includes(k));
  if (!hits.length) return null; // 未命中 → 不搜索
  const topics = [];
  for (const h of hits) if (TOPIC_QUERIES[h] && !topics.includes(TOPIC_QUERIES[h])) topics.push(TOPIC_QUERIES[h]);
  if (hits.some((k) => ["财经", "新闻", "行情", "市场"].includes(k)) && !topics.includes(BROAD_QUERY)) topics.push(BROAD_QUERY);
  return topics.length ? topics : [BROAD_QUERY];
}

// ── 免费源抓取 ──
function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); }
async function fetchText(url, ms = 12000) { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); }
async function fetchGdelt(query) {
  const u = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent(query) + "&mode=artlist&format=json&maxrecords=6&sort=datedesc&timespan=2d";
  const data = await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json();
  return ((data.artifacts || data.data || [])).slice(0, 6).map((a) => ({
    title: (a.title || "").trim(), url: a.url || "", source: "GDELT",
    time: a.seendate ? new Date(a.seendate, 0).toISOString() : "", domain: a.domain || "",
  })).filter((o) => o.title || o.url);
}
async function fetchGNews(query) {
  const xml = await fetchText("https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=zh-CN&gl=CN&ce=9");
  const items = []; const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) && items.length < 6) {
    const pick = (tag) => { const mm = m[1].match(new RegExp("<" + tag + ">([\\s\\S]*?)<\\/" + tag + ">")); return mm ? mm[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : ""; };
    const title = pick("title"), url = pick("link"), pub = pick("pubDate");
    if (!title && !url) continue;
    items.push({ title, url, source: "GoogleNews", time: pub ? new Date(pub).toISOString() : "", domain: "" });
  }
  return items;
}
async function gather(topics) {
  const jobs = [];
  for (const t of topics) {
    jobs.push(fetchGdelt(t.gdelt).then((x) => x).catch((e) => { log("WARN", "GDELT fail=" + e.message); return []; }));
    for (const q of t.gnews) jobs.push(fetchGNews(q).then((x) => x).catch((e) => { log("WARN", "GNews fail=" + e.message); return []; }));
  }
  const all = (await Promise.all(jobs)).flat();
  const seen = new Set(); const out = [];
  for (const it of all) {
    if (!it.title && !it.url) continue;
    const h = hashStr((it.url || it.title).toLowerCase() + "|" + (it.title || "").replace(/\s+/g, " ").slice(0, 60));
    if (seen.has(h)) continue; seen.add(h); it.hash = h; out.push(it);
  }
  out.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  return out.slice(0, 20);
}

// 只读缓存（10分钟）：防止同一问题连续打免费源被限流。非轮询、非定时——只在 /ask 被调时读写。
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;

// ── Agnes 3.0 Flash 中文总结 ──
async function summarize(items, question) {
  if (!AGNES_API_KEY) throw new Error("AGNES_API_KEY 未配置（环境变量）");
  const base = AGNES_API_BASE.replace(/\/$/, "");
  const payload = items.map((it, i) => `${i + 1}. ${it.title || "(无标题)"}\n   来源:${it.source}${it.domain ? "/" + it.domain : ""}\n   时间:${it.time || "未知"}\n   链接:${it.url || "无"}`).join("\n");
  const r = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + AGNES_API_KEY },
    body: JSON.stringify({
      model: AGNES_MODEL,
      messages: [
        { role: "system", content: "你是贵金属与财经新闻分析助手。仅基于用户给定的新闻作答，必须用中文。要求：按时间倒序；去重；区分事实与观点；每条标注来源与时间；涉及黄金/白银/原油/美股等行情时标注利多/利空/中性；不虚构任何数据。" },
        { role: "user", content: `用户问题：${question}\n\n以下是刚抓取的新闻（免费源 GDELT + Google News）：\n${payload}` },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error("Agnes HTTP " + r.status);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || "").trim();
}

// ── HTTP ──
function json(res, o, code = 200) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(o)); }

async function handleAsk(res, q) {
  const t0 = Date.now();
  const topics = pickedTopics(q);
  if (!topics) {
    return json(res, { triggered: false, q, reason: "未命中触发词（" + TRIGGERS.join("/") + "），不调用搜索", ms: Date.now() - t0 });
  }
  const key = topics.map((t) => t.gdelt + "::" + t.gnews.join()).join("|");
  let items = null;
  const c = CACHE.get(key);
  if (c && Date.now() - c.at < CACHE_TTL) items = c.items;
  else { items = await gather(topics); CACHE.set(key, { at: Date.now(), items }); }
  if (!items.length) {
    return json(res, { triggered: true, q, answer: "新闻源暂时没抓到结果（GDELT/Google News 可能限流），请稍后再问一次。", items_count: 0, ms: Date.now() - t0 });
  }
  let answer;
  try {
    answer = await summarize(items, q);
  } catch (e) {
    log("WARN", "ai=fail " + e.message);
    answer = "AI 总结失败，原始新闻条目：\n" + items.map((it, i) => `${i + 1}. ${it.title || ""} [${it.source}${it.domain ? "/" + it.domain : ""}] ${it.time || ""}`).join("\n");
  }
  log("INFO", `ask q="${(q || "").slice(0, 40)}" topics=${topics.length} items=${items.length} ms=${Date.now() - t0}`);
  json(res, { triggered: true, q, answer, items_count: items.length, items: items.map(({ title, source, url, time }) => ({ title, source, url, time })), ms: Date.now() - t0 });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    if (req.method === "GET" && (p === "/" || p === "/health")) return json(res, { ok: true, service: "wechat-news-ai-bot", mode: "on-demand (no cron, no polling)" });
    if (p === "/ask" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      return await handleAsk(res, q);
    }
    if (p === "/ask" && req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        let q = "";
        try { q = JSON.parse(b || "{}").q || ""; } catch { q = b; }
        handleAsk(res, q);
      });
      return;
    }
    return json(res, { ok: false, error: "not found", hint: "GET /health | POST /ask {q}" }, 404);
  } catch (e) {
    log("ERROR", "request error " + e.message);
    json(res, { ok: false, error: e.message }, 500);
  }
});

// 可选代理（国内才需要；Waifly 巴黎海外直连，不设 PROXY）
if (process.env.PROXY) {
  import("undici").then(({ ProxyAgent, setGlobalDispatcher }) => setGlobalDispatcher(new ProxyAgent({ uri: process.env.PROXY }))).catch(() => {});
}

server.listen(PORT, () => log("INFO", `wechat-news-ai-bot(on-demand) :${PORT} — 无cron、无轮询，仅 /ask 命中关键词时搜索`));
