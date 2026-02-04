#!/usr/bin/env node

import fs from "fs";
import path from "path";
import minimist from "minimist";
import * as process from "node:process";
import { ScanOptions, Snapshot } from "./types";
import { scanWorkspace, scanStream } from "./scan";
import cliProgress from "cli-progress";
import ansiColors from "ansi-colors";

type Args = {
  dir?: string;
  out?: string;
  nostream?: boolean;
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
  --nostream, -ns      Stream results to stdout
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
    // recognize both --nostream and --no-stream (legacy spelling) as booleans
    boolean: ['nostream', 'no-stream', 'skip-registries', 'verbose', 'help', 'h'],
    string: ['dir', 'out', 'cache'],
    alias: {
      dir: 'd',
      out: 'o',
      nostream: 'ns',
      'no-stream': 'ns',
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

  // Normalize nostream flag (support both --nostream and --no-stream)
  const nostreamFlag = Boolean((argv as any).nostream || (argv as any)["no-stream"] || false);

  const scanOptions: ScanOptions = {
    concurrency: argv.concurrency,
    skipRegistries: argv.skipRegistries,
    cachePath: argv.cache,
    verbose: argv.verbose,
  };

  if (nostreamFlag) {
    // Non-streaming mode
    const snapshot: Snapshot = await scanWorkspace(argv.dir!, scanOptions);
    const outDir = path.dirname(argv.out!);
    ensureDirSync(outDir);
    await writeAtomic(argv.out!, JSON.stringify(snapshot, null, 2));
    console.log(`Scan complete. Report written to ${argv.out}`);
  } else {
    const outDir = path.dirname(argv.out!);
    ensureDirSync(outDir);

    const multiBar = new cliProgress.MultiBar({
      clearOnComplete: false,
      hideCursor: true,
      format: `${ansiColors.bold("{name}")} | {bar} | {value}/{total} | ${ansiColors.dim("{status}")}`,
    }, cliProgress.Presets.rect);

    const projectParsingBar = multiBar.create(1, 0, { name: 'Parsing Projects   ', status: 'Starting...' });
    const packagesBar = multiBar.create(1, 0, { name: 'Reading Packages   ', status: 'Waiting...' });
    const vulnBar = multiBar.create(1, 0, { name: 'Vuln Scanning      ', status: 'Waiting...' });
    const projectProcessingBar = multiBar.create(1, 0, { name: 'Processing Projects', status: 'Waiting...' });

    let packagesSeen = 0;
    let packagesTotal = 1;

    // Track progress with explicit counters to avoid relying on bar internals
    let projectsParsed = 0;
    let projectsProcessed = 0;
    let projectsTotal = 1;
    let vulnTotal = 1;
    let vulnScanned = 0;

    scanStream(argv.dir!, { ...scanOptions, outPath: argv.out! }, (event: any) => {
      switch (event.type) {
        case "discover":
          if (typeof event.totalProjects === "number") {
            projectsTotal = event.totalProjects;
            projectParsingBar.setTotal(projectsTotal);
            projectParsingBar.update(undefined, { status: "Discovered" });
            projectProcessingBar.setTotal(projectsTotal);
          }
          break;

        case "project-start": {
          // show current project name in the total bar status
          const name = path.basename(event.project || event.manifestFile || 'project');
          projectParsingBar.update(undefined, { status: `Parsing ${name}` });
          projectParsingBar.increment();
          projectsParsed += 1;

          // If we've parsed all discovered projects, mark parsing as done
          if (projectsTotal && projectsParsed >= projectsTotal) {
            projectParsingBar.update(undefined, { status: 'Done' });
          }
          break;
        }

        case "registry-summary": {
          // set packages total from registry summary
          packagesTotal = event.totalUnique || 1;
          packagesBar.setTotal(packagesTotal);
          break;
        }

        case "registry-item": {
          if (event.meta.state === "done" || event.meta.state === "cached") {
            packagesSeen += 1;
            packagesBar.increment();
            packagesBar.update(undefined, { status: event.package });
            if (packagesSeen >= packagesTotal) {
              packagesBar.update(undefined, { status: 'Done' });
            }
          }
          break;
        }

        // case "package": {
        //   // unified packages counter/bar
        //
        //   packagesBar.increment();
        //   packagesBar.update(undefined, { status: event.pkg?.status === "outdated" ? "outdated" : "ok" });
        //   break;
        // }

        case "log": {
          // surface useful status on the packages bar
          if (event.level === "error") {
            console.error(event.stack);
          }
          break;
        }

        case "error": {
          // mark overall packages bar on errors; print global errors once
          if (event.scope === "project") {
            packagesBar.update(undefined, { status: "error" });
          } else {
            console.error("Scan error:", event.message || event);
          }
          break;
        }

        case "project-done": {
          // advance processed projects bar and reflect outdated count in package status
          projectProcessingBar.increment();
          projectsProcessed += 1;

          // reflect outdated count in packages status
          projectProcessingBar.update(undefined, { status: `${event.counts?.outdated ?? 0} outdated` });

          // If we've processed all projects, mark processing as done
          if (projectsTotal && projectsProcessed >= projectsTotal) {
            projectProcessingBar.update(undefined, { status: 'Done' });
          }
          break;
        }

        case "vulnerability-scan-progress": {
          vulnTotal = event.total || 1;
          vulnScanned = event.scanned || 0;
          vulnBar.setTotal(vulnTotal);
          let status = 'Waiting...';
          if (vulnScanned === 0) {
            status = 'Waiting...';
          } else if (vulnScanned < vulnTotal) {
            status = 'In Progress';
          } else if (vulnScanned >= vulnTotal) {
            status = 'Done';
          }
          vulnBar.update(vulnScanned, { status });
          break;
        }

        case "snapshot":
          // finalize totals and stop
          packagesBar.setTotal(Math.max(packagesSeen, packagesBar.getTotal() || 0));
          packagesBar.update(undefined, { status: 'Done' });
          vulnBar.setTotal(Math.max(vulnScanned, vulnBar.getTotal() || 0));
          vulnBar.update(undefined, { status: 'Done' });

          // mark packages reading as done
          packagesBar.update(undefined, { status: 'Done' });

          // if parsing/processing weren't already marked done, mark them done now
          if (projectsTotal && projectsParsed >= projectsTotal) {
            projectParsingBar.update(undefined, { status: 'Done' });
          }
          if (projectsTotal && projectsProcessed >= projectsTotal) {
            projectProcessingBar.update(undefined, { status: 'Done' });
          }

          setTimeout(() => {
            multiBar.stop();
            console.log();
            console.log(`Parsed ${ansiColors.bold.blue(event.summary.projects)} Projects`);
            console.log(`Scanned ${ansiColors.bold.blue(event.summary.packages)} Packages`);
            console.log(`Outdated ${ansiColors.bold.cyan(event.summary.outdated)} Packages`);
            console.log(`Found ${ansiColors.bold.red(event.summary.vulnerabilities)} Vulnerabilities`);
            console.log();
            console.log("Scan complete. Report written to", argv.out);
          }, 100);

          break;
      }
    });

  }
}

main();
