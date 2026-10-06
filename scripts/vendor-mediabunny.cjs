/* Reproduce the unchanged browser module and bundled MPL notice after npm ci. */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const root = path.resolve(__dirname, ".."),
  vendor = path.join(root, "node_modules/mediabunny");
const metadata = JSON.parse(fs.readFileSync(path.join(vendor, "package.json")));
if (metadata.version !== "1.61.0" || metadata.license !== "MPL-2.0")
  throw new Error("Unexpected Mediabunny dependency");
const bytes = fs.readFileSync(
  path.join(vendor, "dist/bundles/mediabunny.min.mjs"),
);
fs.writeFileSync(path.join(root, "extension/vendor-mediabunny.js"), bytes);
const escape = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
fs.writeFileSync(
  path.join(root, "extension/third-party.html"),
  `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Third-party notices</title>
<h1>Mediabunny 1.61.0</h1>
<p><a href="ffmpeg-license.html">Bundled trimmed FFmpeg WASM: licenses, source archives and build information</a>.</p>
<p>Copyright (c) 2026-present Vanilagy and contributors. Licensed under MPL-2.0. The unchanged browser module is distributed as vendor-mediabunny.js. The extension's other original files remain MIT.</p>
<p>Corresponding source (including src/): <a href="https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz">Mediabunny 1.61.0 source package</a>. <a href="https://github.com/Vanilagy/mediabunny/tree/v1.61.0">Upstream source repository</a>.</p>
<p>Reproduce with npm ci --ignore-scripts then node scripts/vendor-mediabunny.cjs. SHA-256: ${crypto.createHash("sha256").update(bytes).digest("hex")}</p>
<pre>${escape(fs.readFileSync(path.join(vendor, "LICENSE"), "utf8"))}</pre></html>\n`,
);
console.log(
  "Vendored unchanged Mediabunny 1.61.0 with MPL-2.0 notice and source link",
);
