import process from "node:process";

async function main() {
  const baseUrl = process.env.API_BASE_URL || "http://localhost:3000";
  const healthUrl = `${baseUrl}/api/health`;
  const readyUrl = `${baseUrl}/api/ready`;

  const healthRes = await fetch(healthUrl);
  if (!healthRes.ok) {
    throw new Error(`health failed with status ${healthRes.status}`);
  }

  const readyRes = await fetch(readyUrl);
  if (!readyRes.ok) {
    throw new Error(`ready failed with status ${readyRes.status}`);
  }

  const health = await healthRes.json();
  const ready = await readyRes.json();

  console.log("[smoke] health:", health);
  console.log("[smoke] ready:", ready);
  console.log("[smoke] PASSED");
}

main().catch((error) => {
  console.error("[smoke] FAILED:", error.message);
  process.exit(1);
});

