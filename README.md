# wechat-news-ai-bot（Node 零依赖 · 按需搜索版）

**规则（铁律）**：
1. 用户发**新闻类问题**才联网搜索（命中关键词）；
2. 用户不发消息 → **绝不搜索**；
3. **无 Cron 定时任务**；4. **无循环轮询**；
5. 搜索源只用免费 API：`GDELT` + `Google News RSS`；
6. 结果送 `Agnes 3.0 Flash` 总结；7. **中文回复**。

触发关键词：黄金 / 白银 / 美元 / 原油 / 美股 / 财经 / 新闻 / 行情 / 市场
未命中 → 直接返回 `triggered:false`，不调任何搜索源。

## 端点

| 端点 | 说明 |
|---|---|
| `GET /health` | 存活探测 |
| `POST /ask` `{ "q": "黄金什么行情" }` | 命中关键词 → 抓 GDELT+GoogleNews → Agnes 中文总结 → 返回 `answer`；未命中 → `triggered:false` |
| `GET /ask?q=…` | 同上（调试用） |

## 部署（任意 7×24 云主机，300M 内存即可）

1. 运行时选 **NodeJS**（≥18，零依赖，无需 npm install）
2. 启动命令：`bash run.sh`（崩溃 5 秒自动拉起）或裸 `node server.js`
3. Environment Variables（密钥只进环境变量，仓库零密钥）：
   - `AGNES_API_KEY` **必填**（AI 服务 key）
   - `AGNES_API_BASE` 可选，默认 `https://apihub.agnes-ai.com/v1`
   - `AGNES_MODEL` 可选，默认 `agnes-3.0-flash`
   - `PORT` 平台对外端口（如 27311）
   - `PROXY` **海外服务器留空**（直连）；国内才填代理
4. 300M 内存建议跑一次 `bash setup_swap.sh`（zram/zswap 兜底，防 OOM 被杀）

## 本地测试

复制 `.env.example` 为 `.env` 填 key → `node server.js` →
`curl -X POST localhost:3000/ask -H 'Content-Type: application/json' -d '{"q":"黄金什么行情"}'`

## 安全

密钥只存在于平台环境变量 / 本地 `.env`（已 gitignore），仓库零密钥、零日志回显。
