const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  extension = path.join(root, "extension");
const manifest = JSON.parse(
  fs.readFileSync(path.join(extension, "manifest.json")),
);
const resources = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...manifest.content_scripts.flatMap((entry) => [
    ...(entry.js || []),
    ...(entry.css || []),
  ]),
  ...(manifest.web_accessible_resources || []).flatMap(
    (entry) => entry.resources,
  ),
];
for (const filename of resources)
  if (!fs.existsSync(path.join(extension, filename)))
    throw new Error("Missing manifest resource: " + filename);
const scripts = fs
  .readdirSync(extension)
  .filter((name) => name.endsWith(".js"));
for (const filename of scripts) {
  const source = fs.readFileSync(path.join(extension, filename), "utf8");
  for (const match of source.matchAll(
    /^import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm,
  )) {
    if (
      !match[1].startsWith("./") ||
      !fs.existsSync(path.resolve(extension, match[1]))
    )
      throw new Error("Missing or remote ESM import: " + match[1]);
  }
  const result = spawnSync(
    process.execPath,
    ["--check", path.join(extension, filename)],
    { encoding: "utf8" },
  );
  if (result.status) {
    process.stderr.write(result.stderr);
    process.exit(1);
  }
}
for (const filename of fs
  .readdirSync(extension)
  .filter((name) => name.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(extension, filename), "utf8");
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g))
    if (
      /https?:/.test(match[1]) ||
      !fs.existsSync(path.join(extension, match[1]))
    )
      throw new Error("Missing or remote page script: " + match[1]);
  for (const match of html.matchAll(/<link[^>]+href="([^"]+)"/g))
    if (
      /^[a-z]+:/i.test(match[1]) ||
      !fs.existsSync(path.join(extension, match[1]))
    )
      throw new Error("Missing or remote page stylesheet: " + match[1]);
  if (/onclick\s*=|<script>(?!\s*<\/script>)/i.test(html))
    throw new Error("Inline script violates extension CSP: " + filename);
}
if (
  manifest.permissions.some((permission) =>
    ["downloads", "nativeMessaging", "tabs", "cookies", "webRequest"].includes(
      permission,
    ),
  )
)
  throw new Error("Optional capabilities must not be mandatory");
console.log(
  `Checked ${scripts.length} scripts, all manifest resources, local page scripts and permissions`,
);
if ((manifest.optional_permissions || []).includes("nativeMessaging"))
  throw new Error("Native helper capability must not return");
for (const name of [
  "ffmpeg-core.js",
  "ffmpeg-core.wasm",
  "ffmpeg-vendor.json",
  "ffmpeg-license.html",
])
  if (!fs.existsSync(path.join(extension, name)))
    throw new Error("Missing packaged conversion asset: " + name);
