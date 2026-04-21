import { EventEmitter } from "node:events";

const realtimeBus = new EventEmitter();
realtimeBus.setMaxListeners(1_000);

export { realtimeBus };
