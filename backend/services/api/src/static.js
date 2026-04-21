import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../../shared/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const console = createLogger("api:static");
const publicDir = path.resolve(__dirname, "../public");

const routes = new Map([
  ["/dashboard", "dashboard.html"],
  ["/dashboard/", "dashboard.html"],
  ["/dashboard/index.html", "dashboard.html"],
  ["/dashboard/app.js", "app.js"],
  ["/dashboard/styles.css", "styles.css"],
  ["/package-catalog", "index.html"],
  ["/package-catalog/", "index.html"],
  ["/package-catalog/index.html", "index.html"],
  ["/package-catalog/app.js", "app.js"],
  ["/package-catalog/styles.css", "styles.css"]
]);

const vendorPrefix = "/dashboard/vendor/";
const packageVendorPrefix = "/package-catalog/vendor/";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

function buildEtag(stats) {
  return `"${stats.size}-${Number(stats.mtimeMs)}"`;
}

async function sendFile(res, filename) {
  const filePath = path.resolve(publicDir, filename);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }

  try {
    const stats = await stat(filePath);
    const etag = buildEtag(stats);
    if (res.req?.headers?.["if-none-match"] === etag) {
      res.writeHead(304, {
        etag,
        "cache-control": "no-cache"
      });
      res.end();
      return;
    }

    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      etag,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300",
      "content-type": contentTypes[ext] || "application/octet-stream"
    });
    res.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not_found");
      return;
    }

    console.error("[dashboard/static] failed:", error);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("static_file_failed");
  }
}

async function sendMarinePortalFile(res, filename) {
  const filePath = path.resolve(publicDir, filename);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }

  try {
    const stats = await stat(filePath);
    const etag = buildEtag(stats);
    if (res.req?.headers?.["if-none-match"] === etag) {
      res.writeHead(304, {
        etag,
        "cache-control": "no-cache"
      });
      res.end();
      return;
    }

    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      etag,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300",
      "content-type": contentTypes[ext] || "application/octet-stream"
    });
    res.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not_found");
      return;
    }

    console.error("[marine-portal/static] failed:", error);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("static_file_failed");
  }
}

export async function maybeServeStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  if (url.pathname === "/") {
    res.writeHead(302, { location: "/dashboard" });
    res.end();
    return true;
  }

  if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
    res.writeHead(302, { location: "/marine-portal#summary-section" });
    res.end();
    return true;
  }

  if (url.pathname === "/dashboard/index.html") {
    res.writeHead(302, { location: "/marine-portal#summary-section" });
    res.end();
    return true;
  }

  if (url.pathname === "/package-catalog" || url.pathname === "/package-catalog/") {
    res.writeHead(302, { location: "/marine-portal#packages-section" });
    res.end();
    return true;
  }

  if (url.pathname === "/package-catalog/index.html") {
    res.writeHead(302, { location: "/marine-portal#packages-section" });
    res.end();
    return true;
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (url.pathname === "/phase3" || url.pathname === "/phase3/" || url.pathname === "/phase3/index.html") {
    const next = `/marine-portal#packages-section`;
    res.writeHead(302, { location: next });
    res.end();
    return true;
  }

  if (url.pathname === "/alerts" || url.pathname === "/alerts/" || url.pathname === "/alerts/index.html") {
    res.writeHead(302, { location: "/marine-portal#alerts-section" });
    res.end();
    return true;
  }

  if (url.pathname === "/commands" || url.pathname === "/commands/" || url.pathname === "/commands/index.html") {
    res.writeHead(302, { location: "/marine-portal#commands-section" });
    res.end();
    return true;
  }

  if (url.pathname === "/marine-portal/alerts" || url.pathname === "/marine-portal/alerts/" || url.pathname === "/marine-portal/alerts/index.html") {
    res.writeHead(302, { location: "/marine-portal#alerts-section" });
    res.end();
    return true;
  }

  if (url.pathname === "/marine-portal/commands" || url.pathname === "/marine-portal/commands/" || url.pathname === "/marine-portal/commands/index.html") {
    res.writeHead(302, { location: "/marine-portal#commands-section" });
    res.end();
    return true;
  }

  if (url.pathname === "/marine-portal" || url.pathname === "/marine-portal/" || url.pathname === "/marine-portal/index.html") {
    await sendMarinePortalFile(res, "marine-portal.html");
    return true;
  }

  if (url.pathname.startsWith("/marine-portal/")) {
    await sendMarinePortalFile(res, "marine-portal.html");
    return true;
  }

  if (url.pathname.startsWith(vendorPrefix)) {
    const filename = url.pathname.slice("/dashboard/".length);
    await sendFile(res, filename);
    return true;
  }

  if (url.pathname.startsWith(packageVendorPrefix)) {
    const filename = url.pathname.slice("/package-catalog/".length);
    await sendFile(res, filename);
    return true;
  }

  const filename = routes.get(url.pathname);
  if (!filename) {
    return false;
  }

  await sendFile(res, filename);
  return true;
}
