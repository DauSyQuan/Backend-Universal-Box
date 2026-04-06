import http from "node:http";

const req = http.request(
  {
    hostname: "127.0.0.1",
    port: 3000,
    path: "/api/mcu/edges/TENANT1/VSL1/EDG1/stream",
    method: "GET",
    headers: {
      Accept: "text/event-stream"
    }
  },
  (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      console.log(`BODY: ${chunk}`);
      // Close after receiving the first telemetry packet to prevent it hanging forever
      if (chunk.includes('"type":"telemetry"')) {
        console.log("Telemetry received! Test passed.");
        process.exit(0);
      }
    });
    res.on("end", () => {
      console.log("No more data in response.");
      process.exit(0);
    });
  }
);

req.on("error", (e) => {
  console.error(`problem with request: ${e.message}`);
  process.exit(1);
});

req.end();

setTimeout(() => {
  console.log("Timeout waiting for SSE events.");
  process.exit(0);
}, 5000);
