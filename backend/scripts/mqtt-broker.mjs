import aedes from "aedes";
import { createServer } from "node:net";

const port = process.env.MQTT_PORT || 1883;

// Create Aedes broker
const broker = new aedes();

// Create TCP server passing Aedes handle
const server = createServer(broker.handle);

server.listen(port, function () {
  console.log(`[mqtt-broker] server started and listening on port ${port}`);
});
