#!/usr/bin/env node

import fs from "fs";
import path from "path";
import minimist from "minimist";
import * as process from "node:process";
import { Package, Snapshot } from "./lib/types";
import { fixVulnerabilities } from "./lib/fix";
import cliProgress from "cli-progress";
import ansiColors from "ansi-colors";

type Args = {
  report?: string;
  dir?: string;
  severity?: string;
  dryRun?: boolean;
  'dry-run'?: boolean;
  noUpdate?: boolean;
  'no-update'?: boolean;
  help?: boolean;
  verbose?: boolean;
  h?: boolean;
  v?: boolean;
}

function printHelp() {
  console.log(`
packpilot-fix

Usage:
  packpilot-fix [--report REPORT] [--severity SEVERITY] [--dry-run] [--verbose] [--help]
  
Options:
  --report, -r         Path to scan report (default: web/public/scan-report.json)
  --severity, -s       Minimum severity to fix (critical|high|medium|low; default: all)
  --dry-run, -d        Simulate fixes without applying changes
  --no-update, -n      Do not run package manager update commands
  --verbose, -v        Verbose logging
  --help, -h           Print this help
  `)
  /* eslint-enable no-console */
}

function loadScanReport(reportPath: string): Snapshot {
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Scan report not found: ${reportPath}`);
  }

  const content = fs.readFileSync(reportPath, 'utf-8');
  return JSON.parse(content);
}

function extractPackages(snapshot: Snapshot): Package[] {
  const packages: Package[] = [];

  if (!snapshot.packages) {
    return packages;
  }

  for (const packageJson of snapshot.packages) {
    for (const pkg of packageJson.packages) {
      packages.push(pkg);
    }
  }

  return packages;
}

function filterPackagesBySeverity(packages: Package[], minSeverity?: string): Package[] {
  if (!minSeverity) {
    return packages;
  }

  const severityLevels: Record<string, number> = {
    'critical': 5,
    'high': 4,
    'medium': 3,
    'low': 2,
    'unknown': 1,
  };

  const minLevel = severityLevels[minSeverity.toLowerCase()] || 0;

  return packages.map(pkg => ({
    ...pkg,
    dependencies: Object.fromEntries(
      Object.entries(pkg.dependencies).filter(([_, dep]) => {
        if (!dep.vulnerabilities || dep.vulnerabilities.length === 0) {
          return false;
        }
        return dep.vulnerabilities.some(vuln => {
          const vulnLevel = severityLevels[vuln.severity] || 0;
          return vulnLevel >= minLevel;
        });
      })
    )
  })).filter(pkg => Object.keys(pkg.dependencies).length > 0);
}

async function main() {
  const argv = minimist<Args>(process.argv.slice(2), {
    boolean: ['dry-run', 'dryRun', 'no-update', 'noUpdate', 'verbose', 'help', 'h', 'v'],
    string: ['report', 'severity', 'r', 's'],
    alias: {
      report: 'r',
      severity: 's',
      'dry-run': 'd',
      'no-update': 'n',
      verbose: 'v',
      help: 'h',
    },
    default: {
      report: path.join(process.cwd(), "web", "public", "scan-report.json"),
    },
  }) as unknown as Args;

  if (argv.help) {
    printHelp();
    process.exit(0);
  }

  // Normalize dryRun flag (support both --dry-run and --dryRun)
  const dryRunFlag = Boolean((argv as any)['dry-run'] || argv.dryRun || false);
  const noUpdateFlag = Boolean((argv as any)['no-update'] || argv.noUpdate || false);
  const verboseFlag = Boolean(argv.verbose || argv.v || false);

  try {
    console.log(`Loading scan report from ${argv.report}...`);
    const snapshot = loadScanReport(argv.report!);

    let packages = extractPackages(snapshot);

    if (packages.length === 0) {
      console.log('No packages found in scan report');
      process.exit(0);
    }

    console.log(`Found ${ansiColors.bold.blue(String(packages.length))} packages`);

    if (argv.severity) {
      const beforeFilter = packages.length;
      packages = filterPackagesBySeverity(packages, argv.severity);
      const filtered = beforeFilter - packages.length;
      if (filtered > 0) {
        console.log(`Filtered to ${ansiColors.bold.blue(String(packages.length))} packages with ${ansiColors.bold.yellow(argv.severity)} severity or higher`);
      }
    }

    if (packages.length === 0) {
      console.log('No vulnerabilities matching criteria found');
      process.exit(0);
    }

    // Create progress bar
    const bar = new cliProgress.SingleBar({
      format: `${ansiColors.bold("Fixing")} | {bar} | {value}/{total} | ${ansiColors.dim("{status}")}`,
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    });

    // Count total vulnerabilities to fix for more accurate progress
    const totalVulnerabilities = packages.reduce((sum, pkg) =>
      sum + Object.values(pkg.dependencies).filter(dep =>
        dep.vulnerabilities && dep.vulnerabilities.length > 0
      ).length, 0
    );

    bar.start(totalVulnerabilities, 0, { status: 'Starting...' });

    let fixedCount = 0;
    let errorCount = 0;
    const allErrors: string[] = [];

    const result = await fixVulnerabilities(packages, { dryRun: dryRunFlag, runUpdate: !noUpdateFlag }, (event) => {
      if (verboseFlag) {
        console.log(`[${event.type}] ${JSON.stringify(event)}`);
      }

      switch (event.type) {
        case 'fix-start':
          bar.update(undefined, {
            status: `${event.package}@${event.currentVersion} -> ${event.targetVersion}`
          });
          break;
        case 'fix-complete':
          bar.increment();

          if (event.success) {
            fixedCount++;
          } else {
            errorCount++;
            allErrors.push(`${event.package}: ${event.error || 'Unknown error'}`);
          }
          break;
        case 'update-command-start':
          bar.update(undefined, {
            status: `Running: ${event.command}`
          });
          break;
        case 'update-command-complete':
          if (!event.success) {
            errorCount++;
            allErrors.push(`Update command failed for ${event.manifestPath}: ${event.error || 'Unknown error'}`);
          }
          break;
        case 'error':
          errorCount++;
          allErrors.push(event.message || 'Unknown error');
          break;
      }
    });

    bar.stop();

    // Print summary
    console.log();
    console.log(`${ansiColors.bold("Summary:")}`);
    console.log(`  Fixed: ${ansiColors.bold.green(String(result.fixed.length))}`);
    console.log(`  Errors: ${ansiColors.bold.red(String(result.errors.length))}`);
    console.log(`  Manifests Updated: ${ansiColors.bold.blue(String(result.manifestsUpdated.length))}`);

    if (result.updateCommandsRun && result.updateCommandsRun.length > 0) {
      const successfulUpdates = result.updateCommandsRun.filter(u => u.success).length;
      console.log(`  Update Commands Run: ${ansiColors.bold.cyan(String(successfulUpdates))}/${result.updateCommandsRun.length}`);
    }

    if (dryRunFlag) {
      console.log();
      console.log(ansiColors.yellow('DRY RUN MODE - No changes were applied'));
    }

    if (result.errors.length > 0) {
      console.log();
      console.log(ansiColors.bold.red("Errors:"));
      for (const error of result.errors) {
        console.log(`  ${error}`);
      }
    }

    if (allErrors.length > 0) {
      console.log();
      console.log(ansiColors.bold.yellow("Issues:"));
      for (const error of allErrors) {
        console.log(`  ${error}`);
      }
    }

    process.exit(result.errors.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(ansiColors.bold.red("Error:"), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
