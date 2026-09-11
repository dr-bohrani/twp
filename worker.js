/**
 * Telegram Cloudflare Worker Proxy
 * Single-file Worker script for proxying Telegram traffic through Cloudflare Workers.
 *
 * Requirements:
 * - Cloudflare Workers runtime with NodeJS compatibility or compatibility_date >= 2023-05-15
 * - (Optional) Environment variable `SECRET` for access control.
 */

import { connect } from 'cloudflare:sockets';

// Optional fallback secret if not configured in Cloudflare Environment variables
const DEFAULT_SECRET = '';

// Default Telegram Datacenter (DC 2 - Amsterdam: 149.154.167.50:443)
const DEFAULT_TG_DC_IP = '149.154.167.50';
const DEFAULT_TG_DC_PORT = 443;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get('Upgrade');

    // If request is not a WebSocket upgrade, show the status/setup dashboard
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return handleHttpDashboard(request, env, url);
    }

    return handleWebSocketProxy(request, env, url);
  }
};

async function handleWebSocketProxy(request, env, url) {
  // 1. Resolve authentication secret
  const configuredSecret = (env && env.SECRET) ? env.SECRET : DEFAULT_SECRET;
  const pathParts = url.pathname.split('/').filter(Boolean);

  let targetIp = url.searchParams.get('ip');
  let targetPort = parseInt(url.searchParams.get('port') || '', 10);
  let clientSecret = url.searchParams.get('secret') || request.headers.get('X-Worker-Secret') || '';

  // Support path routing: /:secret/:ip/:port or /:ip/:port
  if (pathParts.length >= 2) {
    if (pathParts.length >= 3) {
      clientSecret = pathParts[0];
      targetIp = pathParts[1];
      targetPort = parseInt(pathParts[2], 10);
    } else if (pathParts.length === 2 && !isNaN(parseInt(pathParts[1], 10))) {
      targetIp = pathParts[0];
      targetPort = parseInt(pathParts[1], 10);
    }
  }

  if (configuredSecret && clientSecret !== configuredSecret) {
    return new Response('Unauthorized: Invalid secret token', { status: 403 });
  }

  // 2. Validate Target IP and Port
  if (!targetIp) {
    targetIp = DEFAULT_TG_DC_IP;
  }
  if (!targetPort || isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
    targetPort = DEFAULT_TG_DC_PORT;
  }

  // 3. Connect to Telegram DC via TCP using cloudflare:sockets
  let tcpSocket;
  try {
    tcpSocket = connect({
      hostname: targetIp,
      port: targetPort,
    });
  } catch (err) {
    return new Response(`Failed to connect to Telegram DC: ${err.message}`, { status: 502 });
  }

  // 4. Create WebSocket pair
  const webSocketPair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(webSocketPair);
  
  // Set binaryType to arraybuffer before accept()
  try {
    serverWs.binaryType = 'arraybuffer';
  } catch {}
  
  serverWs.accept();

  // 5. Pipe WebSocket -> TCP socket
  const tcpWriter = tcpSocket.writable.getWriter();
  
  serverWs.addEventListener('message', async (event) => {
    try {
      let data = event.data;
      // In Cloudflare Workers modern runtime, binary frames arrive as Blob by default
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data = await data.arrayBuffer();
      }
      if (data instanceof ArrayBuffer) {
        await tcpWriter.write(new Uint8Array(data));
      } else if (ArrayBuffer.isView(data)) {
        await tcpWriter.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } else if (typeof data === 'string') {
        await tcpWriter.write(new TextEncoder().encode(data));
      }
    } catch {
      try { serverWs.close(1011, 'TCP Write Error'); } catch {}
    }
  });

  const closeConnections = () => {
    try { tcpWriter.close(); } catch {}
    try { tcpSocket.close(); } catch {}
    try { serverWs.close(); } catch {}
  };

  serverWs.addEventListener('close', closeConnections);
  serverWs.addEventListener('error', closeConnections);

  // 6. Pipe TCP socket -> WebSocket
  tcpSocket.readable.pipeTo(new WritableStream({
    write(chunk) {
      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(chunk);
      }
    },
    close() {
      try { serverWs.close(1000, 'TCP Closed'); } catch {}
    },
    abort() {
      try { serverWs.close(1011, 'TCP Error'); } catch {}
    }
  })).catch(() => {
    try { serverWs.close(1011, 'Stream Error'); } catch {}
  });

  // 7. Return 101 Switching Protocols with client WebSocket
  return new Response(null, {
    status: 101,
    webSocket: clientWs,
  });
}

function handleHttpDashboard(request, env, url) {
  const host = url.host;

  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>پروکسی ورکر تلگرام (Cloudflare Worker)</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: rgba(30, 41, 59, 0.85);
      --border: #334155;
      --accent: #0ea5e9;
      --accent-hover: #0284c7;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --success: #10b981;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background: radial-gradient(circle at top, #1e293b, var(--bg));
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      backdrop-filter: blur(16px);
      border-radius: 20px;
      max-width: 640px;
      width: 100%;
      padding: 36px 32px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 20px;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .dot {
      width: 8px;
      height: 8px;
      background: var(--success);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--success);
    }
    h1 {
      font-size: 24px;
      margin-bottom: 12px;
      font-weight: 700;
    }
    p.desc {
      color: var(--text-muted);
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 28px;
    }
    .info-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 24px;
      text-align: left;
      direction: ltr;
      word-break: break-all;
    }
    .info-label {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 6px;
      direction: rtl;
      text-align: right;
    }
    .info-value {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 14px;
      color: var(--accent);
      user-select: all;
    }

    .steps {
      margin-top: 32px;
      border-top: 1px solid var(--border);
      padding-top: 24px;
    }
    .steps h2 {
      font-size: 16px;
      margin-bottom: 14px;
      color: var(--text);
    }
    .steps ol {
      padding-right: 20px;
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1.8;
    }
    .steps code {
      background: rgba(255, 255, 255, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
      color: var(--text);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="status-badge">
      <span class="dot"></span>
      ورکر کلادفلر فعال و آماده اتصال است
    </div>
    <h1>پروکسی اختصاصی ورکر تلگرام</h1>
    <p class="desc">
      این سرور ورکر، ترافیک تلگرام را از طریق شبکه توزیع‌شده Cloudflare به سمت دیتاسنترهای رسمی تلگرام تونل می‌کند تا دسترسی امن و پرسرعت فراهم شود.
    </p>

    <div class="info-label">آدرس سرور ورکر شما:</div>
    <div class="info-card">
      <span class="info-value">https://${host}</span>
    </div>

    <div class="steps">
      <h2>نحوه تنظیم دستی در تلگرام دسکتاپ:</h2>
      <ol>
        <li>وارد <code>Settings</code> (تنظیمات) تلگرام شوید.</li>
        <li>به بخش <code>Advanced</code> و سپس <code>Connection type</code> بروید.</li>
        <li>روی <code>Use custom proxy</code> کلیک کرده و گزینه <code>Add proxy</code> را بزنید.</li>
        <li>نوع پروکسی را روی <b>WORKER</b> قرار دهید.</li>
        <li>آدرس ورکر را <code>https://${host}</code> وارد نمایید.</li>
        <li>ذخیره کرده و از اتصال بدون وقفه لذت ببرید!</li>
      </ol>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}