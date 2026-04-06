import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");

const routes = new Map([
  ["/dashboard", "index.html"],
  ["/dashboard/", "index.html"],
  ["/dashboard/index.html", "index.html"],
  ["/dashboard/app.js", "app.js"],
  ["/dashboard/styles.css", "styles.css"]
]);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

async function sendFile(res, filename) {
  const filePath = path.resolve(publicDir, filename);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "cache-control": "no-store",
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

export async function maybeServeStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  if (url.pathname === "/") {
    res.writeHead(302, { location: "/dashboard" });
    res.end();
    return true;
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return true;
  }

  const filename = routes.get(url.pathname);
  if (!filename) {
    return false;
  }

  await sendFile(res, filename);
  return true;
}
