// 部署版密钥读取：只从环境变量读，仓库里不含任何密钥。
// 平台端在 Environment Variables 里配置：
//   AGNES_API_KEY  （必填）
//   AGNES_API_BASE （可选，默认 https://apihub.agnes-ai.com/v1）
//   AGNES_MODEL    （可选，默认 agnes-3.0-flash）
//   ADMIN_KEY      （可选，保护 /admin/scan）
// 本地测试：复制 .env.example 为 .env 并填好即可（.env 已被 gitignore，永不进仓库）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 本地 .env 支持（部署环境无此文件，自动跳过，不影响平台）
function loadDotEnv() {
  try {
    const f = path.join(__dirname, ".env");
    if (!fs.existsSync(f)) return;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* 忽略 */ }
}
loadDotEnv();

export const AGNES_API_BASE = process.env.AGNES_API_BASE || "https://apihub.agnes-ai.com/v1";
export const AGNES_API_KEY  = process.env.AGNES_API_KEY  || "";
export const AGNES_MODEL    = process.env.AGNES_MODEL    || "agnes-3.0-flash";
export const ADMIN_KEY      = process.env.ADMIN_KEY      || "";
