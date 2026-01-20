#!/usr/bin/env node

import fs from "fs";
import path from "path";

interface Snapshot {
  scannedAt: string;
  root: string;
  packages?: PackageJson[];
}

interface Package {
  name: string;
  version: string;
  source: string;
  manifestPath: string;
  dependencies: Record<string, string>;
  installedVersions?: Record<string, string>; // Added field for installed versions
}

interface PackageJson {
  manifest: string;
  packages: Package[];
}

function resolveRoot(root: string): string {
  const resolved = path.resolve(root);
  const systemRoot = path.parse(resolved).root;

  if (resolved === systemRoot) {
    throw new Error(`Refusing to scan system root: ${resolved}`);
  }

  return resolved;
}

function collectFiles(dir: string, manifestFiles: string[], lockFiles: string[]): void {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      collectFiles(fullPath, manifestFiles, lockFiles);
    } else {
      categorizeFile(file, fullPath, manifestFiles, lockFiles);
    }
  }
}

function categorizeFile(
  file: string,
  fullPath: string,
  manifestFiles: string[],
  lockFiles: string[]
): void {
  const manifestExtensions = ["package.json", "pyproject.toml", "Cargo.toml", "requirements.txt"];
  const lockExtensions = ["package-lock.json", "yarn.lock", "Pipfile.lock", "Cargo.lock"];

  if (manifestExtensions.includes(file)) {
    manifestFiles.push(fullPath);
  } else if (lockExtensions.includes(file)) {
    lockFiles.push(fullPath);
  }
}

function parseManifest(file: string, content: string): Package | null {
  if (file.endsWith("package.json")) {
    const data = JSON.parse(content);
    const dependencies = typeof data.dependencies === "object" && data.dependencies !== null ? data.dependencies : {};
    const installedVersions: Record<string, string> = {};

    try {
      const lockFilePath = file.replace("package.json", "package-lock.json");
      if (fs.existsSync(lockFilePath)) {
        const lockData = JSON.parse(fs.readFileSync(lockFilePath, "utf-8"));
        for (const [dep, version] of Object.entries(dependencies)) {
          installedVersions[dep] = lockData.dependencies?.[dep]?.version || "unknown";
        }
      }
    } catch (error) {
      console.error(`Failed to parse installed versions for ${file}:`, error);
    }

    try {
      const yarnLockPath = file.replace("package.json", "yarn.lock");
      if (fs.existsSync(yarnLockPath)) {
        const yarnLockContent = fs.readFileSync(yarnLockPath, "utf-8");
        const { parse } = require("@yarnpkg/lockfile");
        const lockData = parse(yarnLockContent).object;
        for (const [dep, version] of Object.entries(dependencies)) {
          const key = `${dep}@${version}`;
          installedVersions[dep] = lockData[key]?.version || "unknown";
        }
      }
    } catch (error) {
      console.error(`Failed to parse yarn.lock for ${file}:`, error);
    }

    return {
      name: data.name || "unknown",
      version: data.version || "0.0.0",
      source: "npm",
      manifestPath: file,
      dependencies,
      installedVersions,
    };
  } else if (file.endsWith("pyproject.toml")) {
    const toml = require("toml");
    const data = toml.parse(content);
    const installedVersions: Record<string, string> = {};

    try {
      const lockFilePath = file.replace("pyproject.toml", "Pipfile.lock");
      if (fs.existsSync(lockFilePath)) {
        const lockData = JSON.parse(fs.readFileSync(lockFilePath, "utf-8"));
        for (const [dep, version] of Object.entries(data.tool?.poetry?.dependencies || {})) {
          installedVersions[dep] = lockData[dep]?.version || "unknown";
        }
      }
    } catch (error) {
      console.error(`Failed to parse Pipfile.lock for ${file}:`, error);
    }

    return {
      name: data.tool?.poetry?.name || "unknown",
      version: data.tool?.poetry?.version || "0.0.0",
      source: "pypi",
      manifestPath: file,
      dependencies: data.tool?.poetry?.dependencies || {},
      installedVersions,
    };
  } else if (file.endsWith("Cargo.toml")) {
    const toml = require("toml");
    const data = toml.parse(content);
    const installedVersions: Record<string, string> = {};

    try {
      const lockFilePath = file.replace("Cargo.toml", "Cargo.lock");
      if (fs.existsSync(lockFilePath)) {
        const lockData = toml.parse(fs.readFileSync(lockFilePath, "utf-8"));
        for (const dep of lockData.package || []) {
          installedVersions[dep.name] = dep.version || "unknown";
        }
      }
    } catch (error) {
      console.error(`Failed to parse Cargo.lock for ${file}:`, error);
    }

    return {
      name: data.package?.name || "unknown",
      version: data.package?.version || "0.0.0",
      source: "crates.io",
      manifestPath: file,
      dependencies: data.dependencies || {},
      installedVersions,
    };
  } else if (file.endsWith("requirements.txt")) {
    const dependencies: Record<string, string> = {};
    content.split("\n").forEach((line) => {
      const match = line.match(/^(\S+)==(\S+)$/);
      if (match) {
        dependencies[match[1]] = match[2];
      }
    });
    return {
      name: "requirements",
      version: "N/A",
      source: "pypi",
      manifestPath: file,
      dependencies,
      installedVersions: {},
    };
  }

  return null;
}

export async function scanWorkspace(root: string): Promise<Snapshot> {
  const resolved = resolveRoot(root);

  const manifestFiles: string[] = [];
  const lockFiles: string[] = [];

  for (const dirEntry of fs.readdirSync(resolved)) {
    const fullPath = path.join(resolved, dirEntry);
    if (fs.statSync(fullPath).isDirectory()) {
      collectFiles(fullPath, manifestFiles, lockFiles);
    }
  }

  const packages: PackageJson[] = manifestFiles.map((file) => {
    const content = fs.readFileSync(file, "utf-8");
    const pkg = parseManifest(file, content);
    return pkg ? { manifest: file, packages: [pkg] } : null;
  }).filter(Boolean) as PackageJson[];

  return {
    scannedAt: new Date().toISOString(),
    root: resolved,
    packages,
  };
}