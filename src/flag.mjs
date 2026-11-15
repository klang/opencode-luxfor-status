#!/usr/bin/env node
import HID from "node-hid";
// Luxafor Flag: VID 0x04D8, PID 0xF372.
// Usage: luxafor-flag [solid|strobe] R G B   (values 0-255; mode defaults to solid)
// Reports (leading 0 = report ID, led 0xFF = all):
//   solid  [0, 1, led, r, g, b, 0, 0, 0]
//   strobe [0, 3, led, r, g, b, speed, 0, repeat]
const args = process.argv.slice(2);
let mode = "solid";
if (args[0] === "solid" || args[0] === "strobe") mode = args.shift();
const [r = 0, g = 0, b = 0] = args.map((n) => Math.max(0, Math.min(255, Number(n) || 0)));

let dev;
try {
  dev = new HID.HID(0x04d8, 0xf372);
} catch (err) {
  console.error(`luxafor-flag: cannot open device: ${err.message}`);
  process.exit(1);
}
dev.write(
  mode === "strobe"
    ? [0, 3, 0xff, r, g, b, 20, 0, 255]
    : [0, 1, 0xff, r, g, b, 0, 0, 0],
);
dev.close();
