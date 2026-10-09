'use strict';

/**
 * 麦当劳 MCP Streamable HTTP 客户端（零依赖，基于 Node 18+ 内置 fetch）
 *
 * 协议说明：
 *   POST https://mcp.mcd.cn
 *   Headers: Authorization: Bearer <token>, Content-Type: application/json
 *   Body: JSON-RPC 2.0 { jsonrpc, id, method, params }
 *
 * 服务端返回纯 JSON（部分网关下为 SSE，这里做了兼容）。
 */

const ENDPOINT = 'https://mcp.mcd.cn';

function resolveToken() {
  if (process.env.MCD_MCP_TOKEN) return process.env.MCD_MCP_TOKEN;

  // 回退：从 WorkBuddy 的 MCP 配置里读取（避免用户重复配置）
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const cfgPath = path.join(os.homedir(), '.workbuddy', 'mcp.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const entry = cfg.mcpServers && cfg.mcpServers['mcd-mcp'];
      if (entry && entry.headers && entry.headers.Authorization) {
        const m = /^Bearer\s+(.+)$/.exec(entry.headers.Authorization);
        if (m) return m[1];
      }
    }
  } catch (_) {
    /* 忽略，走抛错分支 */
  }

  throw new Error(
    '未找到 MCP Token。请设置环境变量 MCD_MCP_TOKEN，或复制 ENV.example 为 .env 后填入值。\n' +
      '获取方式：登录 https://mcp.mcd.cn → 右上角「控制台」→「激活」→ 复制 Token'
  );
}

let seq = 0;

async function rpc(method, params) {
  const token = resolveToken();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status} ${res.statusText}`);
  }

  const raw = await res.text();
  const payload = parsePayload(raw);

  if (payload.error) {
    throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
  }
  return payload.result;
}

/** 兼容纯 JSON 与 SSE（data: ...）两种响应体 */
function parsePayload(raw) {
  const text = raw.trim();
  if (text.startsWith('{')) return JSON.parse(text);

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) {
      const body = t.slice(5).trim();
      if (body && body !== '[DONE]') return JSON.parse(body);
    }
  }
  throw new Error('无法解析 MCP 响应: ' + text.slice(0, 200));
}

/**
 * MCP 工具返回的是「说明文本 + 原始 JSON」的包装体，这里把原始 JSON 抠出来。
 * 形如： "... ## Original Response\n\n{...}"
 */
function extractJson(content) {
  const chunks = Array.isArray(content) ? content : [content];
  const text = chunks
    .map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : ''))
    .join('\n');

  const marker = text.indexOf('## Original Response');
  const tail = marker >= 0 ? text.slice(marker) : text;

  const start = tail.indexOf('{');
  if (start < 0) return { _raw: text };

  // 从第一个 { 开始做括号配平，避免截断
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < tail.length; i++) {
    const ch = tail[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(tail.slice(start, i + 1));
        } catch (_) {
          break;
        }
      }
    }
  }
  return { _raw: text };
}

/** 调用一个 MCP 工具，返回 { ok, data, raw } */
async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args || {} });
  const parsed = extractJson(result && result.content);
  const data = parsed && parsed.data !== undefined ? parsed.data : parsed;
  return {
    ok: parsed && parsed.success === true,
    data,
    raw: parsed,
  };
}

async function listTools() {
  const result = await rpc('tools/list', {});
  return (result.tools || []).map((t) => t.name);
}

module.exports = { callTool, listTools, rpc, extractJson, ENDPOINT };
