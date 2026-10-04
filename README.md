# wechat-news-ai-bot（Node 零依赖版）

抓黄金/白银/美联储/地缘新闻 → Agnes AI 摘要 → 每 10 分钟自动刷新。
端点与 Cloudflare Worker 版完全一致，可直接替换。

## 部署

1. 平台选 NodeJS 运行时，克隆本仓库
2. Environment Variables 填：
   - `AGNES_API_KEY`  必填，AI 服务 key（只配在平台环境变量，代码零密钥）
   - `AGNES_API_BASE` 可选，默认 `https://apihub.agnes-ai.com/v1`
   - `AGNES_MODEL` 可选，默认 `agnes-3.0-flash`
   - `ADMIN_KEY` 可选，保护 `POST /admin/scan`
   - `PROXY` 可选，国内节点才填（海外直连留空）
3. 启动命令：`npm start`（或 `node server.js`）

## 端点

| 端点 | 说明 |
|---|---|
| `GET /` `/health` | 存活探测 |
| `GET /news` | 最新 AI 摘要 |
| `POST /wechat` | 微信回调（返回摘要） |
| `POST /admin/scan` | 手动触发扫描（需 ADMIN_KEY 时校验 Bearer） |

## 本地测试

`npm i undici`（仅国内代理需要）→ 复制 `.env.example` 为 `.env` 填 key → `npm start`

## 安全

密钥只存在于环境变量 / 本地 .env（已 gitignore），仓库零密钥、零日志回显。
