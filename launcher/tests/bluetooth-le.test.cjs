const test = require("node:test");
const assert = require("node:assert/strict");
const { parseBluetoothLeStatus, probeBluetoothLe } = require("../electron/bluetooth-le.cjs");

const observed = `Index list with 1 item
hci0: Primary controller
  supported settings: powered connectable br/edr le secure-conn
  current settings: powered br/edr secure-conn
`;

test("Bluetooth LE preflight distinguishes disabled LE from a powered BR/EDR controller", async () => {
  assert.equal(parseBluetoothLeStatus(observed), "disabled");
  assert.equal(parseBluetoothLeStatus(observed.replace("current settings: powered br/edr", "current settings: powered le br/edr")), "available");
  assert.equal(parseBluetoothLeStatus(observed.replace(" br/edr le secure-conn", " br/edr secure-conn")), "unknown");
  assert.equal(await probeBluetoothLe("linux", (_file, _args, _options, done) => done(null, observed)), "disabled");
  assert.equal(await probeBluetoothLe("darwin", () => { throw new Error("Other platforms use Chromium's native status"); }), "unknown");
});
