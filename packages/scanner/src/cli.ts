#!/usr/bin/env node

import fs from "fs";
import path from "path";
import minimist from "minimist";
import { resolve } from "@tauri-apps/api/path";
import * as process from "node:process";

type Args = {
  dir?: string;
  out?: string;
  stream?: boolean;
  concurrency?: number;
  skipRegistries?: boolean;
  cache?: string;
  verbose?: boolean;
  help?: boolean;
}

function printHelp() {
  console.log(`
packpilot-scanner

Usage:
  packpilot-scan [--dir DIR] [--out OUT] [--stream] [--concurrency N] [--skip-registries] [--cache PATH] [--verbose] [--help]
  
Options:
  --dir, -d            Directory to scan (default: current directory)
  --out, -o            Output file path (default: scan-report.json)
  --stream, -s         Stream results to stdout
  --concurrency=N      Registry request concurrency limit (default: implementation default)
  --skip-registries    Parse manifests and lockfiles only; do not query registries
  --cache=PATH         Path to a persistent registry cache (optional)
  --verbose, -v        Verbose logging
  --help, -h           Print this help
  `)
  /* eslint-enable no-console */
}

function ensureDirSync(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function writeAtomic(filePath: string, data: string) {
  const tmp = `${filePath}.tmp-${Date.now()}`;
  await fs.promises.writeFile(tmp, data, 'utf8');
  await fs.promises.rename(tmp, filePath);
}

async function main() {
  const argv = minimist<Args>(process.argv.slice(2), {
    boolean: ['stream', 'skip-registries', 'verbose', 'help', 'h'],
    string: ['dir', 'out', 'cache'],
    alias: {
      dir: 'd',
      out: 'o',
      stream: 's',
      verbose: 'v',
      help: 'h',
    },
    default: {
      dir: process.cwd(),
      out: path.join(process.cwd(), "web", "public", "scan-report.json"),
    },
  }) as unknown as Args;

  if (argv.help) {
    printHelp();
    process.exit(0);
  }

  const root = path.resolve(argv.dir || process.cwd());
  const outPath = path.resolve(argv.out || path.join(process.cwd(), "web", "public", "scan-report.json"));
  const opts = {
    concurrency: argv.concurrency,
    skipRegistries: Boolean(argv["skip-registries"] || argv.skipRegistries),
    cachePath: argv.cache,
    verbose: Boolean(argv.verbose),
  };

  if (root === "/" || root === path.parse(root).root) {
    console.log("Refusing to scan root directory. Please specify a workspace directory with --dir.");
    process.exit(2);
  }

  ensureDirSync(path.dirname(outPath));

  let scanner: any;
  try {
    const candidatePaths = [
      path.join(__dirname, "scan"),
      path.join(__dirname, "..", "dist", "scan"),
      path.join(__dirname, "..", "dist", "scan.js"),
      path.join(__dirname, "dist", "scan.js"),
      path.join(process.cwd(), "packages", "scanner", "dist", "scan.js"),
    ];
    let loaded = false;
    for (const p of candidatePaths) {
      try {
        const mod = require(p);
        if (mod) {
          scanner = mod;
          loaded = true;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (!loaded) {
      scanner = require("./scan");
    }
  } catch (err) {
    console.error("Failed to load scanner module:", err);
    if (argv.verbose) console.error(err);
    process.exit(3);
  }

  const supportsStream = typeof scanner.scanStream === "function";
  const supportsScan = typeof scanner.scanWorkspace === "function" || typeof scanner.default === "function";

  try {
    if (argv.stream && supportsStream) {
      await new Promise<void>((resolve, reject) => {
        const onEvent = (event: any) => {
          try {
            const line = JSON.stringify(event);
            process.stdout.write(line + "\n");
          } catch (err) {
            // ignore
          }
        }
        const cb = (err: any, finalSnapshotPath?: string) => {
          if (err) return reject(err);
          if (finalSnapshotPath) {
            const ev = {
              type: "snapshot",
              path: finalSnapshotPath,
              time: new Date().toISOString(),
            }
            process.stdout.write(JSON.stringify(ev) + "\n");
          }
          resolve();
        };
        try {
          scanner.scanStream(root, { outPath, ...opts }, onEvent, cb);
        } catch (err) {
          reject(err);
        }
      });
      process.exit(0);
    }

    if (supportsScan) {
      const scanFn = scanner.scanWorkspace || scanner.default || scanner.run || scanner.scan;
      if (typeof scanFn !== "function") {
        throw new Error("No valid scan function found in scanner module.");
      }

      if (argv.verbose) console.log(`Starting scan of workspace at ${root}...`);

      const snapshot = await scanFn(root, opts);

      if (!snapshot || typeof snapshot !== "object") {
        throw new Error("Scan did not return a valid snapshot object.");
      }

      const snapshotJson = JSON.stringify(snapshot, null, 2);
      await writeAtomic(outPath, snapshotJson);

      if (argv.verbose) console.log(`Scan complete. Report written to ${outPath}`);
      else console.log(outPath);

      process.exit(0);
    }

    throw new Error("Scanner module does not support streaming or standard scan methods.");
  } catch (err: any) {
    console.error("Scan failed:", err.message || err);
    if (argv.verbose && err && err.stack) console.error(err);
    process.exit(4);
  }
}

main();