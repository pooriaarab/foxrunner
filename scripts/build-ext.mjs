// Builds extension/ into dist-ext/: esbuild bundles each script, and the
// other files are copied. It stops when the manifest version is not the
// package.json version, so AMO signs the version that npm publishes.
//   node scripts/build-ext.mjs         the release build, which AMO signs
//   node scripts/build-ext.mjs --e2e   the test build: adds e2e/bridge.js as
//                                      a content script on 127.0.0.1 (AE1)
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const { values } = parseArgs({ options: { e2e: { type: "boolean", default: false } } });

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`extension/manifest.json has version ${manifest.version}, but package.json has ${pkg.version}. Make them equal.`);
  process.exit(1);
}

rmSync("dist-ext", { recursive: true, force: true });
const files = readdirSync("extension");
await build({
  entryPoints: [...files.filter((f) => f.endsWith(".js")).map((f) => `extension/${f}`), ...(values.e2e ? [{ in: "e2e/bridge.js", out: "e2e-bridge" }] : [])],
  outdir: "dist-ext",
  bundle: true,
  format: "iife",
  target: "firefox153",
  logLevel: "warning",
});
// amo-metadata.json is the AMO listing, not a part of the add-on.
for (const file of files.filter((f) => !f.endsWith(".js") && f !== "amo-metadata.json")) cpSync(`extension/${file}`, `dist-ext/${file}`, { recursive: true });
// AE1, AE2: only the test build has the bridge. It lets a 127.0.0.1 page
// drive tasks and read their state, so it must never reach AMO.
if (values.e2e) {
  manifest.content_scripts = [{ matches: ["http://127.0.0.1/*"], js: ["e2e-bridge.js"] }];
  writeFileSync("dist-ext/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(`Built dist-ext/ (version ${pkg.version}${values.e2e ? ", e2e build" : ""}).`);
