const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const port = Number(process.env.PORT || 4173);
const publicDir = path.join(__dirname, "public");

let latestAim = {
  x: 0.5,
  y: 0.5,
  confidence: 0,
  mode: "waiting",
  deviceId: null,
  updatedAt: 0,
};

const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/controller": ["controller.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/display.js": ["display.js", "text/javascript; charset=utf-8"],
  "/controller.js": ["controller.js", "text/javascript; charset=utf-8"],
};

function getLanAddress() {
  const networks = os.networkInterfaces();
  const preferred = [];
  const fallback = [];

  for (const entries of Object.values(networks)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      const bucket = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)
        ? preferred
        : fallback;
      bucket.push(entry.address);
    }
  }

  return preferred[0] || fallback[0] || "localhost";
}

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 32_768) reject(new Error("payload too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/info") {
    const lanHost = getLanAddress();
    const baseUrl = `http://${lanHost}:${port}`;
    json(res, 200, {
      baseUrl,
      displayUrl: `${baseUrl}/`,
      controllerUrl: `${baseUrl}/controller`,
      secureContextRequired: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    json(res, 200, latestAim);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/aim") {
    try {
      const value = JSON.parse(await readBody(req));
      const x = Number(value.x);
      const y = Number(value.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        json(res, 400, { ok: false, error: "invalid coordinates" });
        return;
      }
      latestAim = {
        x: Math.min(1.5, Math.max(-0.5, x)),
        y: Math.min(1.5, Math.max(-0.5, y)),
        confidence: Math.min(1, Math.max(0, Number(value.confidence) || 0)),
        mode: String(value.mode || "unknown"),
        deviceId: String(value.deviceId || "phone").slice(0, 80),
        updatedAt: Date.now(),
      };
      json(res, 200, { ok: true });
    } catch {
      json(res, 400, { ok: false, error: "invalid json" });
    }
    return;
  }

  const match = files[url.pathname];
  if (!match || req.method !== "GET") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const [fileName, contentType] = match;
  fs.readFile(path.join(publicDir, fileName), (error, content) => {
    if (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Failed to load the prototype");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
});

server.listen(port, "0.0.0.0", () => {
  const lanHost = getLanAddress();
  console.log("Phone Aim prototype is running");
  console.log(`Display:    http://localhost:${port}`);
  console.log(`Phone:      http://${lanHost}:${port}/controller`);
  console.log("Keep this window open while testing.");
});
