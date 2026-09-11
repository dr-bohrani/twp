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
  <title>TWP - هسته پروکسی ورکر تلگرام</title>
  <style>
    :root {
      --bg: #000000;
      --card-bg: #0a0a0a;
      --card-inner: #000000;
      --border: #1c1c1c;
      --accent: #00e5ff;
      --text: #ffffff;
      --text-muted: #8e8e93;
      --success: #00e676;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
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
      border-radius: 20px;
      max-width: 580px;
      width: 100%;
      padding: 36px 30px;
      box-shadow: 0 0 50px rgba(0, 0, 0, 0.95), 0 0 0 1px rgba(255, 255, 255, 0.04);
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #03140a;
      color: var(--success);
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 22px;
      border: 1px solid rgba(0, 230, 118, 0.25);
    }
    .dot {
      width: 8px;
      height: 8px;
      background: var(--success);
      border-radius: 50%;
      box-shadow: 0 0 12px var(--success);
    }
    h1 {
      font-size: 24px;
      margin-bottom: 12px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: #ffffff;
    }
    p.desc {
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1.7;
      margin-bottom: 26px;
    }
    .info-card {
      background: var(--card-inner);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 18px;
      margin-bottom: 18px;
      text-align: left;
      direction: ltr;
      word-break: break-all;
    }
    .info-label {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 8px;
      direction: rtl;
      text-align: right;
    }
    .info-value {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 14px;
      color: var(--accent);
      user-select: all;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 18px;
    }
    .meta-box {
      background: var(--card-inner);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
    }
    .meta-title {
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    .meta-val {
      font-size: 13px;
      font-weight: 600;
      color: #ffffff;
      font-family: ui-monospace, SFMono-Regular, monospace;
      direction: ltr;
      text-align: right;
    }
    .footer {
      margin-top: 26px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
    }
    .footer a {
      color: var(--accent);
      text-decoration: none;
      transition: opacity 0.2s;
    }
    .footer a:hover {
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="status-badge">
      <span class="dot"></span>
      ورکر کلادفلر فعال و آماده اتصال است
    </div>
    <h1>پروکسی اختصاصی ورکر تلگرام (TWP)</h1>
    <p class="desc">
      این سرور ترافیک پروتکل MTProto را از طریق شبکه لبه (Edge) کلادفلر با پروتکل WebSocket به سمت دیتاسنترهای رسمی تلگرام تونل می‌کند.
    </p>

    <div class="info-label">آدرس سرور ورکر (Server Host):</div>
    <div class="info-card">
      <span class="info-value">https://${host}</span>
    </div>

    <div class="meta-grid">
      <div class="meta-box">
        <div class="meta-title">پروتکل انتقال</div>
        <div class="meta-val">WSS (RFC 6455)</div>
      </div>
      <div class="meta-box">
        <div class="meta-title">پورت پیش‌فرض</div>
        <div class="meta-val">443 (TLS 1.3)</div>
      </div>
    </div>

    <div class="footer">
      توسعه داده شده توسط <a href="https://t.me/Qorvhex_Channel" target="_blank" rel="noopener">Qorvhex</a>
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