#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import { Package, PackageJson, DependencyInfo, Snapshot, ScanOptions } from "./types";

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
  const manifestFilesList = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "requirements.txt",
    "Pipfile",
    "composer.json",
    "go.mod",
    "poetry.lock" // not a manifest but include commonly alongside pyproject
  ];

  const lockFilesList = [
    "package-lock.json",
    "yarn.lock",
    "Pipfile.lock",
    "Cargo.lock",
    "composer.lock",
    "go.sum",
    "poetry.lock",
  ];

  if (manifestFilesList.includes(file)) {
    manifestFiles.push(fullPath);
  } else if (lockFilesList.includes(file)) {
    lockFiles.push(fullPath);
  }
}

function safeRequire<T = any>(name: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // `require` used conditionally so the package is optional
    // @ts-ignore
    return require(name) as T;
  } catch (err) {
    return null;
  }
}

function parsePackageJson(file: string, content: string): Package | null {
  const data = JSON.parse(content);
  const name = data.name || path.basename(path.dirname(file));
  const version = data.version || "0.0.0";

  // Collect declared dependencies from a few common fields
  const declared: Record<string, string> = {};
  if (data.dependencies && typeof data.dependencies === "object") {
    Object.assign(declared, data.dependencies);
  }
  if (data.devDependencies && typeof data.devDependencies === "object") {
    Object.assign(declared, data.devDependencies);
  }
  if (data.peerDependencies && typeof data.peerDependencies === "object") {
    Object.assign(declared, data.peerDependencies);
  }

  const deps: Record<string, DependencyInfo> = {};
  for (const [pkgName, declaredVersion] of Object.entries(declared)) {
    deps[pkgName] = { declaredVersion: String(declaredVersion) };
  }

  // Try to read package-lock.json
  try {
    const lockPath = path.join(path.dirname(file), "package-lock.json");
    if (fs.existsSync(lockPath)) {
      const lockData = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      for (const [depName, info] of Object.entries(lockData.dependencies || {})) {
        if (deps[depName]) {
          (deps[depName] as DependencyInfo).installedVersion = (info as any).version || undefined;
        } else {
          deps[depName] = { declaredVersion: "", installedVersion: (info as any).version || undefined };
        }
      }
    }
  } catch (err) {
    console.error(`Error reading package-lock for ${file}:`, err);
  }

  // Try to read yarn.lock (if present)
  try {
    const yarnPath = path.join(path.dirname(file), "yarn.lock");
    if (fs.existsSync(yarnPath)) {
      const lockfile = safeRequire<{ parse: (c: string) => any }>('@yarnpkg/lockfile') || safeRequire<any>('yarn-lockfile');
      if (lockfile && typeof lockfile.parse === 'function') {
        const parsed = lockfile.parse(fs.readFileSync(yarnPath, "utf-8"));
        const object = parsed && parsed.object ? parsed.object : {};
        for (const depName of Object.keys(deps)) {
          // yarn keys are like "pkg@^1.0.0" or "pkg@1.2.3, pkg@^1.2.3"
          const matches = Object.keys(object).filter((k) => k.startsWith(`${depName}@`));
          if (matches.length > 0) {
            const first = object[matches[0]];
            if (first && first.version) {
              (deps[depName] as DependencyInfo).installedVersion = first.version;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error reading yarn.lock for ${file}:`, err);
  }

  return {
    name,
    version,
    source: "npm",
    manifestPath: file,
    dependencies: deps,
  };
}

function parsePyprojectToml(file: string, content: string): Package | null {
  const toml = safeRequire<any>("toml") || safeRequire<any>("@iarna/toml");
  const data = toml ? toml.parse(content) : null;
  if (!data) return null;

  const pkgName = data.tool?.poetry?.name || path.basename(path.dirname(file));
  const pkgVersion = data.tool?.poetry?.version || "0.0.0";
  const declared: Record<string, string> = {};
  const poetryDeps = data.tool?.poetry?.dependencies || {};
  for (const [k, v] of Object.entries(poetryDeps)) {
    if (k === "python") continue;
    declared[k] = typeof v === "string" ? v : (v as any).version || "";
  }

  const deps: Record<string, DependencyInfo> = {};
  for (const [n, dv] of Object.entries(declared)) {
    deps[n] = { declaredVersion: dv };
  }

  // Try parsing poetry.lock (it's TOML-like but different); fallback to Pipfile.lock if present
  try {
    const poetryLockPath = path.join(path.dirname(file), "poetry.lock");
    if (fs.existsSync(poetryLockPath)) {
      const lockContent = fs.readFileSync(poetryLockPath, "utf-8");
      // poetry.lock is not strict TOML for the packages, so do a simple regex-based parse
      const packageBlocks = lockContent.split("\n\n").filter(Boolean);
      for (const block of packageBlocks) {
        const nameMatch = block.match(/^name = "([^"]+)"/m);
        const versionMatch = block.match(/^version = "([^"]+)"/m);
        if (nameMatch && versionMatch) {
          const name = nameMatch[1];
          const version = versionMatch[1];
          if (deps[name]) {
            (deps[name] as DependencyInfo).installedVersion = version;
          } else {
            deps[name] = { declaredVersion: "", installedVersion: version };
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error reading poetry.lock for ${file}:`, err);
  }

  // Fallback to Pipfile.lock (JSON) close to pyproject usage
  try {
    const pipfileLock = path.join(path.dirname(file), "Pipfile.lock");
    if (fs.existsSync(pipfileLock)) {
      const lockData = JSON.parse(fs.readFileSync(pipfileLock, "utf-8"));
      for (const [name, info] of Object.entries(lockData.default || {})) {
        const versionStr = (info as any).version || ""; // like "==1.2.3"
        const version = versionStr.replace(/^==/, "");
        if (deps[name]) (deps[name] as DependencyInfo).installedVersion = version;
        else deps[name] = { declaredVersion: "", installedVersion: version };
      }
    }
  } catch (err) {
    console.error(`Error reading Pipfile.lock for ${file}:`, err);
  }

  return {
    name: pkgName,
    version: pkgVersion,
    source: "pypi",
    manifestPath: file,
    dependencies: deps,
  };
}

function parseCargoToml(file: string, content: string): Package | null {
  const toml = safeRequire<any>("toml") || safeRequire<any>("@iarna/toml");
  const data = toml ? toml.parse(content) : null;
  if (!data) return null;

  const pkgName = data.package?.name || path.basename(path.dirname(file));
  const pkgVersion = data.package?.version || "0.0.0";
  const declared: Record<string, string> = {};
  const cargoDeps = data.dependencies || {};
  for (const [k, v] of Object.entries(cargoDeps)) {
    declared[k] = typeof v === "string" ? v : (v as any).version || "";
  }

  const deps: Record<string, DependencyInfo> = {};
  for (const [n, dv] of Object.entries(declared)) {
    deps[n] = { declaredVersion: dv };
  }

  // Parse Cargo.lock (TOML with [[package]] tables)
  try {
    const lockPath = path.join(path.dirname(file), "Cargo.lock");
    if (fs.existsSync(lockPath)) {
      const lockContent = fs.readFileSync(lockPath, "utf-8");
      const lockData = toml.parse(lockContent);
      const pkgs = lockData.package || [];
      for (const p of pkgs) {
        if (!p || !p.name) continue;
        const name = p.name;
        const version = p.version;
        if (deps[name]) (deps[name] as DependencyInfo).installedVersion = version;
        else deps[name] = { declaredVersion: "", installedVersion: version };
      }
    }
  } catch (err) {
    console.error(`Error reading Cargo.lock for ${file}:`, err);
  }

  return {
    name: pkgName,
    version: pkgVersion,
    source: "crates.io",
    manifestPath: file,
    dependencies: deps,
  };
}

function parseRequirementsTxt(file: string, content: string): Package | null {
  const deps: Record<string, DependencyInfo> = {};
  content.split(/\r?\n/).forEach((line) => {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith("#")) return;
    // simple exact-match parser: pkg==1.2.3 or pkg>= etc.
    const eqMatch = cleaned.match(/^([^=<>!~\s]+)\s*==\s*([^\s]+)$/);
    if (eqMatch) {
      deps[eqMatch[1]] = { declaredVersion: `==${eqMatch[2]}`, installedVersion: eqMatch[2] };
    } else {
      // fallback: store the whole spec as declaredVersion
      const name = cleaned.split(/[\s\[\];,]/)[0];
      deps[name] = { declaredVersion: cleaned };
    }
  });

  return {
    name: "requirements.txt",
    version: "N/A",
    source: "pypi",
    manifestPath: file,
    dependencies: deps,
  };
}

function parseGenericManifest(file: string, content: string): Package | null {
  if (file.endsWith("package.json")) return parsePackageJson(file, content);
  if (file.endsWith("pyproject.toml")) return parsePyprojectToml(file, content);
  if (file.endsWith("Cargo.toml")) return parseCargoToml(file, content);
  if (file.endsWith("requirements.txt")) return parseRequirementsTxt(file, content);
  if (file.endsWith("Pipfile")) {
    const toml = safeRequire<any>("toml") || safeRequire<any>("@iarna/toml");
    const data = toml ? toml.parse(content) : null;
    if (!data) return null;
    const declared = data.packages || {};
    const deps: Record<string, DependencyInfo> = {};
    for (const [n, v] of Object.entries(declared)) {
      deps[n] = { declaredVersion: typeof v === "string" ? v : JSON.stringify(v) };
    }
    return {
      name: path.basename(path.dirname(file)),
      version: "N/A",
      source: "pypi",
      manifestPath: file,
      dependencies: deps,
    };
  }

  return null;
}

async function runWithConcurrency<T, R>(items: T[], worker: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];
  let i = 0;

  async function runOne(index: number) {
    const res = await worker(items[index]);
    results[index] = res;
  }

  while (i < items.length) {
    const current = i++;
    const p = runOne(current);
    const e = p.then(() => { }).catch(() => { });
    executing.push(e);
    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // cleanup finished promises
      for (let j = executing.length - 1; j >= 0; j--) {
        if ((executing[j] as any).resolved) executing.splice(j, 1);
      }
      // naive cleanup — allow garbage collection; precise tracking isn't required here
      executing.splice(0, executing.length > concurrency ? executing.length - concurrency : 0);
    }
  }

  await Promise.all(executing);
  return results;
}

function loadCacheFromPath(cachePath?: string): Record<string, any> {
  const p = cachePath && cachePath.trim() !== "" ? cachePath : path.join(os.homedir(), ".packpilot-cache.json");
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      return JSON.parse(raw || "{}");
    }
  } catch (err) {
    // ignore
  }
  return {};
}

function saveCacheToPath(cache: Record<string, any>, cachePath?: string): void {
  const p = cachePath && cachePath.trim() !== "" ? cachePath : path.join(os.homedir(), ".packpilot-cache.json");
  try {
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    // ignore
  }
}

async function fetchNpmUpdates(packageNames: Set<string>, ops: ScanOptions, cache: Record<string, any>): Promise<Record<string, { latest?: string; versions: string[] }>> {
  const updates: Record<string, { latest?: string; versions: string[] }> = {};
  if (ops.skipRegistries) {
    if (ops.verbose) console.log("Skipping npm registry fetches due to options.skipRegistries");
    return updates;
  }

  const fetch = safeRequire<any>("node-fetch") || safeRequire<any>("cross-fetch") || safeRequire<any>("undici");
  if (!fetch) {
    if (ops.verbose) console.warn("Fetch library not available; skipping npm update checks.");
    return updates;
  }

  const names = Array.from(packageNames);
  const worker = async (pkgName: string) => {
    const cacheKey = `npm:${pkgName}`;
    if (cache[cacheKey]) {
      if (ops.verbose) console.log(`npm cache hit: ${pkgName}`);
      updates[pkgName] = cache[cacheKey];
      return;
    }
    try {
      if (ops.verbose) console.log(`Fetching npm info: ${pkgName}`);
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`);
      if (response.ok) {
        const data = await response.json();
        const versions = data && data.versions ? Object.keys(data.versions) : [];
        const latest = data && data['dist-tags'] && data['dist-tags'].latest ? data['dist-tags'].latest : undefined;
        updates[pkgName] = { latest, versions };
        cache[cacheKey] = updates[pkgName];
      }
    } catch (err) {
      if (ops.verbose) console.error(`Error fetching npm info for ${pkgName}:`, err);
    }
  };

  const concurrency = Math.max(1, ops.concurrency || 4);
  await runWithConcurrency(names, worker, concurrency);
  return updates;
}

async function fetchPyPiUpdates(packageNames: Set<string>, ops: ScanOptions, cache: Record<string, any>): Promise<Record<string, { latest?: string; versions: string[] }>> {
  const updates: Record<string, { latest?: string; versions: string[] }> = {};
  if (ops.skipRegistries) {
    if (ops.verbose) console.log("Skipping PyPI registry fetches due to options.skipRegistries");
    return updates;
  }

  const fetch = safeRequire<any>("node-fetch") || safeRequire<any>("cross-fetch") || safeRequire<any>("undici");
  if (!fetch) {
    if (ops.verbose) console.warn("Fetch library not available; skipping PyPI update checks.");
    return updates;
  }

  const names = Array.from(packageNames);
  const worker = async (pkgName: string) => {
    const cacheKey = `pypi:${pkgName}`;
    if (cache[cacheKey]) {
      if (ops.verbose) console.log(`PyPI cache hit: ${pkgName}`);
      updates[pkgName] = cache[cacheKey];
      return;
    }
    try {
      if (ops.verbose) console.log(`Fetching PyPI info: ${pkgName}`);
      const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkgName)}/json`);
      if (response.ok) {
        const data = await response.json();
        const releases = data && data.releases ? Object.keys(data.releases) : [];
        const latest = data && data.info && data.info.version ? data.info.version : undefined;
        updates[pkgName] = { latest, versions: releases };
        cache[cacheKey] = updates[pkgName];
      }
    } catch (err) {
      if (ops.verbose) console.error(`Error fetching PyPI info for ${pkgName}:`, err);
    }
  };

  const concurrency = Math.max(1, ops.concurrency || 4);
  await runWithConcurrency(names, worker, concurrency);
  return updates;
}

async function fetchCratesIoUpdates(packageNames: Set<string>, ops: ScanOptions, cache: Record<string, any>): Promise<Record<string, { latest?: string; versions: string[] }>> {
  const updates: Record<string, { latest?: string; versions: string[] }> = {};
  if (ops.skipRegistries) {
    if (ops.verbose) console.log("Skipping crates.io registry fetches due to options.skipRegistries");
    return updates;
  }

  const fetch = safeRequire<any>("node-fetch") || safeRequire<any>("cross-fetch") || safeRequire<any>("undici");
  if (!fetch) {
    if (ops.verbose) console.warn("Fetch library not available; skipping crates.io update checks.");
    return updates;
  }

  const names = Array.from(packageNames);
  const worker = async (pkgName: string) => {
    const cacheKey = `crates:${pkgName}`;
    if (cache[cacheKey]) {
      if (ops.verbose) console.log(`crates.io cache hit: ${pkgName}`);
      updates[pkgName] = cache[cacheKey];
      return;
    }
    try {
      if (ops.verbose) console.log(`Fetching crates.io info: ${pkgName}`);
      const response = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(pkgName)}`);
      if (response.ok) {
        const data = await response.json();
        const latest = data && data.crate && data.crate.max_version ? data.crate.max_version : undefined;
        // Try to fetch versions list as well
        const vresp = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(pkgName)}/versions`);
        let versions: string[] = [];
        if (vresp.ok) {
          const vdata = await vresp.json();
          versions = (vdata && vdata.versions ? vdata.versions.map((v: any) => v.num) : []);
        }
        updates[pkgName] = { latest, versions };
        cache[cacheKey] = updates[pkgName];
      }
    } catch (err) {
      if (ops.verbose) console.error(`Error fetching crates.io info for ${pkgName}:`, err);
    }
  };

  const concurrency = Math.max(1, ops.concurrency || 4);
  await runWithConcurrency(names, worker, concurrency);
  return updates;
}

function chooseLatestSatisfying(declaredRange: string, versions: string[]): string | undefined {
  if (!declaredRange || declaredRange.trim() === "") return undefined;
  // Prefer semver library if available
  const semver = safeRequire<any>("semver");
  if (semver && typeof semver.satisfies === "function" && Array.isArray(versions)) {
    try {
      // filter versions that are valid semver
      const valid = versions.filter((v) => semver.valid(v)).sort(semver.rcompare);
      for (const v of valid) {
        if (semver.satisfies(v, declaredRange)) return v;
      }
    } catch (err) {
      // fallback to none
    }
  }

  // Fallback heuristic: if declaredRange looks like exact version or starts with ==, pick that
  const eq = declaredRange.match(/^(?:==)?\s*([0-9][^\s]*)$/);
  if (eq) {
    return eq[1];
  }

  // As a last resort, return the latest (highest semver-like or lexicographic)
  if (versions.length === 0) return undefined;
  // try semver sort if semver available
  if (semver && typeof semver.rcompare === 'function') {
    const valid = versions.filter((v) => semver.valid(v)).sort(semver.rcompare);
    if (valid.length > 0) return valid[0];
  }
  // lexicographic fallback
  return versions.slice().sort().reverse()[0];
}

async function fetchUpdates(packages: Package[]): Promise<Record<string, Set<string>>> {
  // existing helper kept for compatibility (returns names grouped by source)
  const bySource: Record<string, Set<string>> = {};
  for (const pkg of packages) {
    const src = pkg.source || "unknown";
    if (!bySource[src]) bySource[src] = new Set<string>();
    for (const depName of Object.keys(pkg.dependencies)) {
      bySource[src].add(depName);
    }
  }
  return bySource;
}

export async function scanWorkspace(root: string, opts: ScanOptions): Promise<Snapshot> {
  const resolved = resolveRoot(root);

  const manifestFiles: string[] = [];
  const lockFiles: string[] = [];

  for (const dirEntry of fs.readdirSync(resolved)) {
    const fullPath = path.join(resolved, dirEntry);
    if (fs.statSync(fullPath).isDirectory()) {
      collectFiles(fullPath, manifestFiles, lockFiles);
    }
  }

  const packages: PackageJson[] = manifestFiles
    .map((file) => {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const pkg = parseGenericManifest(file, content);
        return pkg ? { manifest: file, packages: [pkg] } : null;
      } catch (err) {
        console.error(`Failed to read/parse manifest ${file}:`, err);
        return null;
      }
    })
    .filter(Boolean) as PackageJson[];

  const flatPackages: Package[] = [];
  for (const p of packages) {
    for (const pkg of p.packages) flatPackages.push(pkg);
  }

  const bySource = await fetchUpdates(flatPackages);

  const npmNames = bySource['npm'] || new Set<string>();
  const pypiNames = bySource['pypi'] || new Set<string>();
  const cratesNames = bySource['crates.io'] || new Set<string>();

  // load cache once
  const cache = loadCacheFromPath(ops.cachePath);

  const [npmData, pypiData, cratesData] = await Promise.all([
    fetchNpmUpdates(npmNames, ops, cache),
    fetchPyPiUpdates(pypiNames, ops, cache),
    fetchCratesIoUpdates(cratesNames, ops, cache),
  ]);

  // persist cache
  try {
    saveCacheToPath(cache, ops.cachePath);
  } catch (err) {
    if (ops.verbose) console.warn("Failed to save cache:", err);
  }

  for (const pkg of flatPackages) {
    const src = pkg.source || 'unknown';
    for (const [depName, info] of Object.entries(pkg.dependencies)) {
      let meta: { latest?: string; versions: string[] } | undefined;
      if (src === 'npm') meta = npmData[depName];
      else if (src === 'pypi') meta = pypiData[depName];
      else if (src === 'crates.io') meta = cratesData[depName];

      if (meta) {
        if (meta.latest) info.latestVersion = meta.latest;
        if (meta.versions && meta.versions.length > 0) {
          const satisf = chooseLatestSatisfying(info.declaredVersion, meta.versions);
          if (satisf) info.latestSatisfyingVersion = satisf;
          if (!info.latestVersion) info.latestVersion = meta.versions.slice().sort().reverse()[0];
        }
      }
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    root: resolved,
    packages,
  };
}