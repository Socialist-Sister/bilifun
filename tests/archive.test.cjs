const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const archive = require("../extension/archive.js");

test("ZIP CRC matches the standard vector and bounds reject unsafe paths", () => {
  assert.equal(archive.crc(new TextEncoder().encode("123456789")), 0xcbf43926);
  for (const name of ["../a", "/a", "C:/a", "a\\b", "a/./b", "a\0b"])
    assert.throws(() => archive.zip([{ name, data: "x" }]));
  assert.throws(() =>
    archive.zip([
      { name: "same", data: "a" },
      { name: "same", data: "b" },
    ]),
  );
  assert.throws(
    () =>
      archive.zip([{ name: "x", data: new Uint8Array(30 * 1024 * 1024 + 1) }]),
    /30 MB/,
  );
});
test("ZIP preserves Unicode names and binary data in an independent Python reader", async () => {
  const directory = path.join(__dirname, "..", "artifacts");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "archive-roundtrip.zip");
  fs.writeFileSync(
    filename,
    Buffer.from(
      await archive
        .zip([
          { name: "P01-弹幕.xml", data: "<i>你好 &amp;</i>" },
          { name: "binary.bin", data: new Uint8Array([0, 1, 255]) },
        ])
        .arrayBuffer(),
    ),
  );
  const result = spawnSync(
    process.env.TEST_PYTHON_EXECUTABLE || "python",
    [
      "-c",
      'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read("P01-弹幕.xml").decode()=="<i>你好 &amp;</i>"; assert z.read("binary.bin")==bytes([0,1,255])',
      filename,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
