import { stat, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const allowedExtensions = new Set([".js", ".mjs", ".cjs"]);

function isSourceFile(filePath) {
  return allowedExtensions.has(path.extname(filePath));
}

async function collectFiles(entryPath) {
  const absolutePath = path.resolve(process.cwd(), entryPath);
  const entryStat = await stat(absolutePath);

  if (entryStat.isFile()) {
    return isSourceFile(absolutePath) ? [absolutePath] : [];
  }

  if (!entryStat.isDirectory()) {
    return [];
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    const childPath = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(childPath)));
      continue;
    }

    if (entry.isFile() && isSourceFile(childPath)) {
      files.push(childPath);
    }
  }

  return files;
}

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("usage: node scripts/check-source.mjs <path...>");
    process.exit(1);
  }

  const files = [];
  for (const target of targets) {
    try {
      files.push(...(await collectFiles(target)));
    } catch (error) {
      console.error(`[check-source] unable to inspect ${target}: ${error?.message || error}`);
      process.exit(1);
    }
  }

  const uniqueFiles = [...new Set(files)].sort();
  if (uniqueFiles.length === 0) {
    console.error("[check-source] no source files found");
    process.exit(1);
  }

  for (const file of uniqueFiles) {
    const result = spawnSync(process.execPath, ["--check", file], {
      cwd: process.cwd(),
      stdio: "inherit"
    });

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

main().catch((error) => {
  console.error("[check-source] failed:", error?.message || error);
  process.exit(1);
});
