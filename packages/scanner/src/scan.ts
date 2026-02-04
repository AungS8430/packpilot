#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import { Package, PackageJson, DependencyInfo, VulnerabilityInfo, Snapshot, ScanOptions, ScanStreamOptions, ScanEvent } from "./types";

function resolveRoot(root: string): string {
  const resolved = path.resolve(root);
  const systemRoot = path.parse(resolved).root;

  if (resolved === systemRoot) {
    throw new Error(`Refusing to scan system root: ${resolved}`);
  }

  return resolved;
}

function collectFiles(dir: string, manifestFiles: string[], lockFiles: string[]): void {
  const IGNORE_DIRS = new Set([
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    ".cache",
    "vendor",
    ".tox",
    ".parcel-cache",
  ]);

  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      const base = path.basename(fullPath);
      if (IGNORE_DIRS.has(base)) continue;
      collectFiles(fullPath, manifestFiles, lockFiles);
    } else {
      categorizeFile(entry, fullPath, manifestFiles, lockFiles);
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
      // v1/v2: dependencies map
      if (lockData.dependencies && typeof lockData.dependencies === "object") {
        for (const [depName, info] of Object.entries(lockData.dependencies || {})) {
          if (deps[depName]) {
            (deps[depName] as DependencyInfo).installedVersion = (info as any).version || undefined;
          } else {
            deps[depName] = { declaredVersion: "", installedVersion: (info as any).version || undefined };
          }
        }
      }
      // v2: packages map (keys like "node_modules/<name>" or "")
      if (lockData.packages && typeof lockData.packages === "object") {
        for (const [key, info] of Object.entries(lockData.packages || {})) {
          try {
            // skip root package entry (key === "")
            if (typeof key === "string" && key.trim() === "") continue;

            const ver = (info as any).version;
            // derive a candidate name from key when possible
            let nameFromKey: string | undefined;
            if (typeof key === "string" && key.includes("node_modules/")) {
              // extract the part after the first node_modules/ to get the package path
              const after = key.split('node_modules/').pop() || '';
              // capture a scoped (@scope/name) or unscoped (name) package identifier
              const m = after.match(/^(@[^\/]+\/[^^\/]+|[^\/]+)/);
              nameFromKey = m ? m[0] : after;
            } else if ((info as any).name) {
              nameFromKey = (info as any).name;
            }

            // avoid adding the project itself to deps
            if (nameFromKey && nameFromKey === name) continue;

            if (nameFromKey && ver) {
              if (deps[nameFromKey]) {
                (deps[nameFromKey] as DependencyInfo).installedVersion = ver;
              } else {
                deps[nameFromKey] = { declaredVersion: "", installedVersion: ver };
              }
            }
          } catch {
            // noop
          }
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
        const object = parsed && (parsed.object || parsed) ? (parsed.object || parsed) : {};
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

  // Try parsing poetry.lock (best-effort)
  try {
    const poetryLockPath = path.join(path.dirname(file), "poetry.lock");
    if (fs.existsSync(poetryLockPath)) {
      const lockContent = fs.readFileSync(poetryLockPath, "utf-8");
      const blocks = lockContent.split('\n[[package]]\n').filter(Boolean);
      for (const block of blocks) {
        const nameMatch = block.match(/^name\s*=\s*"([^"]+)"/m);
        const versionMatch = block.match(/^version\s*=\s*"([^"]+)"/m);
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

  // Fallback to Pipfile.lock (JSON)
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
      // store declared constraint only; installedVersion must come from lockfile
      deps[eqMatch[1]] = { declaredVersion: `==${eqMatch[2]}` };
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

async function runWithConcurrency<T, R>(items: T[], worker: (item: T) => Promise<R>, concurrency: number, signal?: AbortSignal): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();
  let i = 0;

  async function runOne(index: number) {
    if (signal?.aborted) return;
    try {
      results[index] = await worker(items[index]);
    } catch (err) {
      // keep index reserved with undefined result on error
      (results as any)[index] = undefined;
    }
  }

  while (i < items.length) {
    if (signal?.aborted) break;
    const current = i++;
    const p = runOne(current).then(() => { executing.delete(p); }).catch(() => { executing.delete(p); });
    executing.add(p as unknown as Promise<void>);
    if (executing.size >= concurrency) {
      await Promise.race(Array.from(executing));
    }
  }

  await Promise.all(Array.from(executing));
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

async function fetchNpmUpdates(packageNames: Set<string>, opts: ScanOptions & { signal?: AbortSignal }, cache: Record<string, any>, onItem?: (pkgName: string, meta: { latest?: string; versions: string[] }) => void): Promise<Record<string, { latest?: string; versions: string[] }>> {
  const updates: Record<string, { latest?: string; versions: string[] }> = {};
  if (opts.skipRegistries) {
    if (opts.verbose) console.log("Skipping npm registry fetches due to options.skipRegistries");
    return updates;
  }

  const fetch = safeRequire<any>("node-fetch") || safeRequire<any>("cross-fetch") || safeRequire<any>("undici");
  if (!fetch) {
    if (opts.verbose) console.warn("Fetch library not available; skipping npm update checks.");
    return updates;
  }

  const names = Array.from(packageNames);
  const worker = async (pkgName: string) => {
    if ((opts as any).signal?.aborted) return;
    const cacheKey = `npm:${pkgName}`;
    if (cache[cacheKey]) {
      if (opts.verbose) console.log(`npm cache hit: ${pkgName}`);
      updates[pkgName] = cache[cacheKey];
      if (onItem) onItem(pkgName, Object.assign({}, updates[pkgName], { state: 'cached' }));
      return;
    }
    try {
      if (opts.verbose) console.log(`Fetching npm info: ${pkgName}`);
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`, { signal: (opts as any).signal } as any);
      if (response && response.ok) {
        const data = await response.json();
        const versions = data && data.versions ? Object.keys(data.versions) : [];
        const latest = data && data['dist-tags'] && data['dist-tags'].latest ? data['dist-tags'].latest : undefined;
        updates[pkgName] = { latest, versions };
        cache[cacheKey] = updates[pkgName];
        if (onItem) onItem(pkgName, Object.assign({}, updates[pkgName], { state: 'done' }));
      }
    } catch (err) {
      if (opts.verbose) console.error(`Error fetching npm info for ${pkgName}:`, err);
    }
  };

  const concurrency = Math.max(1, opts.concurrency || 4);
  await runWithConcurrency(names, worker, concurrency, (opts as any).signal);
  return updates;
}

async function fetchPyPiUpdates(packageNames: Set<string>, opts: ScanOptions & { signal?: AbortSignal }, cache: Record<string, any>, onItem?: (pkgName: string, meta: { latest?: string; versions: string[] }) => void): Promise<Record<string, { latest?: string; versions: string[] }>> {
  const updates: Record<string, { latest?: string; versions: string[] }> = {};
  if (opts.skipRegistries) {
    if (opts.verbose) console.log("Skipping PyPI registry fetches due to options.skipRegistries");
    return updates;
  }

  const fetch = safeRequire<any>("node-fetch") || safeRequire<any>("cross-fetch") || safeRequire<any>("undici");
  if (!fetch) {
    if (opts.verbose) console.warn("Fetch library not available; skipping PyPI update checks.");
    return updates;
  }

  const names = Array.from(packageNames);
  const worker = async (pkgName: string) => {
    if ((opts as any).signal?.aborted) return;
    const cacheKey = `pypi:${pkgName}`;
    if (cache[cacheKey]) {
      if (opts.verbose) console.log(`PyPI cache hit: ${pkgName}`);
      updates[pkgName] = cache[cacheKey];
      if (onItem) onItem(pkgName, Object.assign({}, updates[pkgName], { state: 'cached' }));
      return;
    }
    try {
      if (opts.verbose) console.log(`Fetching PyPI info: ${pkgName}`);
      const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkgName)}/json`, { signal: (opts as any).signal } as any);
      if (response && response.ok) {
        const data = await response.json();
        const releases = data && data.releases ? Object.keys(data.releases) : [];
        const latest = data && data.info && data.info.version ? data.info.version : undefined;
        updates[pkgName] = { latest, versions: releases };
        cache[cacheKey] = updates[pkgName];
        if (onItem) onItem(pkgName, Object.assign({}, updates[pkgName], { state: 'done' }));
      }
    } catch (err) {
      if (opts.verbose) console.error(`Error fetching PyPI info for ${pkgName}:`, err);
    }
  };

  const concurrency = Math.max(1, opts.concurrency || 4);
  await runWithConcurrency(names, worker, concurrency, (opts as any).signal);
  return updates;
}

async function fetchCratesIoUpdates(packageNames: Set<string>, opts: ScanOptions & { signal?: AbortSignal }, cache: Record<string, any>, onItem?: (pkgName: string, meta: { latest?: string; versions: string[] }) => void): Promise<Record<string, { latest?: string; versions: string[] }>> {
  const updates: Record<string, { latest?: string; versions: string[] }> = {};
  if (opts.skipRegistries) {
    if (opts.verbose) console.log("Skipping crates.io registry fetches due to options.skipRegistries");
    return updates;
  }

  const fetch = safeRequire<any>("node-fetch") || safeRequire<any>("cross-fetch") || safeRequire<any>("undici");
  if (!fetch) {
    if (opts.verbose) console.warn("Fetch library not available; skipping crates.io update checks.");
    return updates;
  }

  const names = Array.from(packageNames);
  const worker = async (pkgName: string) => {
    if ((opts as any).signal?.aborted) return;
    const cacheKey = `crates:${pkgName}`;
    if (cache[cacheKey]) {
      if (opts.verbose) console.log(`crates.io cache hit: ${pkgName}`);
      updates[pkgName] = cache[cacheKey];
      if (onItem) onItem(pkgName, Object.assign({}, updates[pkgName], { state: 'cached' }));
      return;
    }
    try {
      if (opts.verbose) console.log(`Fetching crates.io info: ${pkgName}`);
      // crates.io requires a User-Agent header, otherwise it returns 403
      const headers = { 'User-Agent': 'packpilot-scanner (https://github.com/packpilot)' };
      const response = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(pkgName)}`, { signal: (opts as any).signal, headers } as any);
      if (response && response.ok) {
        const data = await response.json();
        const latest = data && data.crate && data.crate.max_version ? data.crate.max_version : undefined;
        // Try to fetch versions list as well
        const vresp = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(pkgName)}/versions`, { signal: (opts as any).signal, headers } as unknown as any);
        let versions: string[] = [];
        if (vresp && vresp.ok) {
          const vdata = await vresp.json();
          versions = (vdata && vdata.versions ? vdata.versions.map((v: any) => v.num) : []);
        }
        updates[pkgName] = { latest, versions };
        cache[cacheKey] = updates[pkgName];
        if (onItem) onItem(pkgName, Object.assign({}, updates[pkgName], { state: 'done' }));
      }
    } catch (err) {
      if (opts.verbose) console.error(`Error fetching crates.io info for ${pkgName}:`, err);
    }
  };

  const concurrency = Math.max(1, opts.concurrency || 4);
  await runWithConcurrency(names, worker, concurrency, (opts as any).signal);
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

function isVersionAffected(version: string, vuln: VulnerabilityInfo, semver: any): boolean {
  if (vuln.affectedVersionList && vuln.affectedVersionList.includes(version)) return true;
  if (vuln.affectedVersions && typeof semver?.satisfies === 'function') {
    try {
      if (semver.satisfies(version, vuln.affectedVersions)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function chooseUpgradeTarget(installed: string | undefined, vuln: VulnerabilityInfo, versions: string[]): string | undefined {
  if (!Array.isArray(versions) || versions.length === 0) return undefined;
  const semver = safeRequire<any>('semver');
  if (!semver || typeof semver.valid !== 'function' || typeof semver.compare !== 'function') return undefined;

  const valid = versions.filter((v) => semver.valid(v)).sort(semver.compare);
  if (valid.length === 0) return undefined;

  const installedValid = installed && semver.valid(installed) ? installed : undefined;
  for (const v of valid) {
    if (installedValid && semver.lte(v, installedValid)) continue;
    if (!isVersionAffected(v, vuln, semver)) return v;
  }
  return undefined;
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

async function checkVulnerabilities(
  packages: Array<{ name: string; version: string; ecosystem: string }>,
  opts: ScanOptions & { signal?: AbortSignal },
  cache: Record<string, any>,
  onVulnerability?: (pkgName: string, version: string, vulns: VulnerabilityInfo[]) => void,
  onProgress?: (scanned: number, total: number) => void
): Promise<Record<string, VulnerabilityInfo[]>> {
  const results: Record<string, VulnerabilityInfo[]> = {};

  if (opts.skipRegistries) {
    if (opts.verbose) console.log("Skipping vulnerability checks due to options.skipRegistries");
    return results;
  }

  const fetch = safeRequire<any>("node-fetch") || safeRequire<any>("cross-fetch") || safeRequire<any>("undici");
  if (!fetch) {
    if (opts.verbose) console.warn("Fetch library not available; skipping vulnerability checks.");
    return results;
  }

  // Map ecosystem names to OSV ecosystem format
  function mapEcosystem(source: string): string {
    switch (source) {
      case 'npm': return 'npm';
      case 'pypi': return 'PyPI';
      case 'crates.io': return 'crates.io';
      default: return source;
    }
  }

  // Parse severity from CVSS or severity string
  function parseSeverity(vuln: any): 'critical' | 'high' | 'medium' | 'low' | 'unknown' {
    // Check database_specific severity
    if (vuln.database_specific?.severity) {
      const sev = vuln.database_specific.severity.toLowerCase();
      if (sev === 'critical') return 'critical';
      if (sev === 'high') return 'high';
      if (sev === 'medium' || sev === 'moderate') return 'medium';
      if (sev === 'low') return 'low';
    }

    // Check CVSS score from severity array
    if (vuln.severity && Array.isArray(vuln.severity)) {
      for (const s of vuln.severity) {
        if (s.type === 'CVSS_V3' && s.score) {
          const score = parseFloat(s.score);
          if (score >= 9.0) return 'critical';
          if (score >= 7.0) return 'high';
          if (score >= 4.0) return 'medium';
          if (score >= 0.1) return 'low';
        }
      }
    }

    return 'unknown';
  }

  // Extract fixed version from affected ranges
  function extractFixedVersion(affected: any): string | undefined {
    if (!affected?.ranges) return undefined;
    for (const range of affected.ranges) {
      if (range.events) {
        for (const event of range.events) {
          if (event.fixed) return event.fixed;
        }
      }
    }
    return undefined;
  }

  function extractAffectedVersionList(affected: any): string[] | undefined {
    if (!Array.isArray(affected?.versions) || affected.versions.length === 0) return undefined;
    return affected.versions.slice();
  }

  // Extracts the range of affected versions from the vulnerability data
  function extractAffectedVersionRange(affected: any): string | undefined {
    if (!affected?.ranges) return undefined;
    const ranges: string[] = [];
    for (const range of affected.ranges) {
      if (range.events) {
        let introduced: string | undefined;
        let fixed: string | undefined;
        for (const event of range.events) {
          if (event.introduced) introduced = event.introduced;
          if (event.fixed) fixed = event.fixed;
        }
        if (introduced && fixed) {
          ranges.push(`>=${introduced}, <${fixed}`);
        } else if (introduced) {
          ranges.push(`>=${introduced}`);
        } else if (fixed) {
          ranges.push(`<${fixed}`);
        }
      }
    }
    return ranges.length > 0 ? ranges.join(' || ') : undefined;
  }

  // Query OSV API in batches (OSV supports batch queries)
  const OSV_BATCH_SIZE = 1000;
  const batches: Array<Array<{ name: string; version: string; ecosystem: string }>> = [];
  for (let i = 0; i < packages.length; i += OSV_BATCH_SIZE) {
    batches.push(packages.slice(i, i + OSV_BATCH_SIZE));
  }

  let scanned = 0;
  for (const batch of batches) {
    if (opts.signal?.aborted) break;

    // Check cache first, separate cached and uncached
    const uncached: Array<{ name: string; version: string; ecosystem: string; cacheKey: string }> = [];
    for (const pkg of batch) {
      const cacheKey = `vuln:${pkg.ecosystem}:${pkg.name}:${pkg.version}`;
      // Only use in-memory results for this run, do not persist vulnerability results to disk cache
      if (results[`${pkg.ecosystem}:${pkg.name}@${pkg.version}`] !== undefined) {
        // Already checked in this run

      } else {
        uncached.push({ ...pkg, cacheKey });
      }
    }

    if (uncached.length === 0) continue;

    // Build OSV batch query
    const queries = uncached.map(pkg => ({
      package: {
        name: pkg.name,
        ecosystem: mapEcosystem(pkg.ecosystem),
      },
      version: pkg.version,
    }));

    try {
      if (opts.verbose) console.log(`Checking vulnerabilities for ${uncached.length} packages via OSV...`);

      const response = await fetch('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries }),
        signal: opts.signal,
      } as any);

      if (response && response.ok) {
        const data = await response.json();
        const resultsArray = data.results || [];

        for (let i = 0; i < uncached.length; i++) {
          const pkg = uncached[i];
          const key = `${pkg.ecosystem}:${pkg.name}@${pkg.version}`;
          const vulnResult = resultsArray[i];
          const vulns: VulnerabilityInfo[] = [];

          if (vulnResult?.vulns && Array.isArray(vulnResult.vulns)) {
            for (const v of vulnResult.vulns) {
              // Find the affected entry for this package
              const affected = v.affected?.find((a: any) =>
                a.package?.name?.toLowerCase() === pkg.name.toLowerCase()
              );

              const vulnInfo: VulnerabilityInfo = {
                id: v.id || 'unknown',
                severity: parseSeverity(v),
                title: v.summary || v.details?.substring(0, 100) || v.id || 'Unknown vulnerability',
                description: v.details,
                affectedVersionList: extractAffectedVersionList(affected),
                fixedVersion: extractFixedVersion(affected),
                url: v.references?.find((r: any) => r.type === 'ADVISORY')?.url ||
                     v.references?.find((r: any) => r.type === 'WEB')?.url ||
                     v.references?.[0]?.url ||
                     `https://osv.dev/vulnerability/${v.id}`,
                publishedAt: v.published,
              };
              vulns.push(vulnInfo);
            }
          }

          results[key] = vulns;
          // Do NOT persist vulnerability results to the cache object
          // cache[pkg.cacheKey] = vulns; // <-- REMOVE THIS LINE

          if (onVulnerability && vulns.length > 0) {
            onVulnerability(pkg.name, pkg.version, vulns);
          }
        }
      } else {
        if (opts.verbose) {
          console.error(`OSV API returned non-ok status: ${response?.status}`);
        }
      }
    } catch (err) {
      if (opts.verbose) console.error('Error querying OSV API:', err);
    }

    scanned += batch.length;
    if (onProgress) onProgress(Math.min(scanned, packages.length), packages.length);
  }

  return results;
}

async function writeAtomic(filePath: string, data: string) {
  const tmp = `${filePath}.tmp-${Date.now()}`;
  await fs.promises.writeFile(tmp, data, 'utf8');
  await fs.promises.rename(tmp, filePath);
}

export async function scanWorkspace(root: string, opts: ScanOptions = {}): Promise<Snapshot> {
  const resolved = resolveRoot(root);

  const manifestFiles: string[] = [];
  const lockFiles: string[] = [];

  // collect from root (includes root manifest)
  collectFiles(resolved, manifestFiles, lockFiles);

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
  const cache = loadCacheFromPath(opts.cachePath);

  const [npmData, pypiData, cratesData] = await Promise.all([
    fetchNpmUpdates(npmNames, opts as any, cache),
    fetchPyPiUpdates(pypiNames, opts as any, cache),
    fetchCratesIoUpdates(cratesNames, opts as any, cache),
  ]);

  // persist cache
  try {
    saveCacheToPath(cache, opts.cachePath);
  } catch (err) {
    if (opts.verbose) console.warn("Failed to save cache:", err);
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
          if (satisf) (info as any).latestSatisfyingVersion = satisf;
          if (!info.latestVersion) info.latestVersion = meta.versions.slice().sort().reverse()[0];
        }
      }
    }
  }

  // Collect all packages with versions for vulnerability scanning
  const packagesForVulnCheck: Array<{ name: string; version: string; ecosystem: string }> = [];
  for (const pkg of flatPackages) {
    const ecosystem = pkg.source || 'unknown';
    for (const [depName, info] of Object.entries(pkg.dependencies)) {
      // Use installed version if available, otherwise fall back to declared version (cleaned)
      const version = info.installedVersion || info.declaredVersion?.replace(/^[\^~>=<]+/, '');
      if (version && /^\d/.test(version)) {
        packagesForVulnCheck.push({ name: depName, version, ecosystem });
      }
    }
  }

  // Check for vulnerabilities
  const vulnResults = await checkVulnerabilities(packagesForVulnCheck, opts as any, cache);

  // Apply vulnerability results to dependency info
  for (const pkg of flatPackages) {
    const ecosystem = pkg.source || 'unknown';
    for (const [depName, info] of Object.entries(pkg.dependencies)) {
      const version = info.installedVersion || info.declaredVersion?.replace(/^[\^~>=<]+/, '');
      if (version) {
        const key = `${ecosystem}:${depName}@${version}`;
        const vulns = vulnResults[key];
        if (vulns && vulns.length > 0) {
          let meta: { latest?: string; versions: string[] } | undefined;
          if (ecosystem === 'npm') meta = npmData[depName];
          else if (ecosystem === 'pypi') meta = pypiData[depName];
          else if (ecosystem === 'crates.io') meta = cratesData[depName];

          if (meta?.versions?.length) {
            for (const vuln of vulns) {
              if (!vuln.fixedVersion) {
                const upgrade = chooseUpgradeTarget(version, vuln, meta.versions);
                if (upgrade) vuln.fixedVersion = upgrade;
              }
            }
          }

          info.vulnerabilities = vulns;
        }
      }
    }
  }

  // Save cache again after vulnerability checks
  try {
    saveCacheToPath(cache, opts.cachePath);
  } catch (err) {
    if (opts.verbose) console.warn("Failed to save cache after vulnerability check:", err);
  }

  return {
    scannedAt: new Date().toISOString(),
    root: resolved,
    packages,
  };
}

export function scanStream(
  root: string,
  opts: ScanStreamOptions = {} as ScanStreamOptions,
  onEvent: (evt: ScanEvent) => void,
  done?: (err?: Error | null, outPath?: string) => void
): void {
  let seq = 0;
  function emit<T extends ScanEvent>(evt: T) {
    // attach time and seq; avoid mutating caller object deeply
    const out = Object.assign({ seq: ++seq, time: new Date().toISOString() }, evt) as T;
    try {
      onEvent(out);
    } catch {
      // consumer may throw; ignore here
    }
  }

  (async () => {
    try {
      const resolved = resolveRoot(root);

      const manifestFiles: string[] = [];
      const lockFiles: string[] = [];

      // collect from root (includes root manifest)
      collectFiles(resolved, manifestFiles, lockFiles);

      // Emit discover (do not include enormous manifests list for huge repos)
      emit({ type: 'discover', totalProjects: manifestFiles.length } as unknown as ScanEvent);

      // Parse manifests and emit project-start logs
      const projects: PackageJson[] = [];

      for (const manifest of manifestFiles) {
        const projectDir = path.dirname(manifest);
        const manifestType = manifest.endsWith('package.json')
          ? 'npm'
          : manifest.endsWith('pyproject.toml')
            ? 'pypi'
            : manifest.endsWith('Cargo.toml')
              ? 'crates'
              : path.basename(manifest);

        emit({ type: 'project-start', project: projectDir, manifestFile: manifest, manifestType } as unknown as ScanEvent);

        try {
          const content = fs.readFileSync(manifest, 'utf-8');
          const pkg = parseGenericManifest(manifest, content);
          const pj: PackageJson = pkg ? { manifest, packages: [pkg] } : { manifest, packages: [] };
          projects.push(pj);
          emit({ type: 'log', level: 'info', msg: `Parsed manifest ${manifest}`, context: { manifest } } as unknown as ScanEvent);
        } catch (err) {
          emit({ type: 'error', scope: 'project', message: `Failed to read/parse manifest ${manifest}`, detail: err } as unknown as ScanEvent);
        }
      }

      // Flatten packages
      const flatPackages: Package[] = [];
      for (const p of projects) for (const pkg of p.packages) flatPackages.push(pkg);

      // Group dependency names by source and prepare cache
      const bySource = await fetchUpdates(flatPackages);
      const cache = loadCacheFromPath(opts.cachePath);

      const npmNames = bySource['npm'] || new Set<string>();
      const pypiNames = bySource['pypi'] || new Set<string>();
      const cratesNames = bySource['crates.io'] || new Set<string>();

      // Emit summary of unique packages we will fetch from registries.
      // Always include counts and total; include full lists only if opts.emitPackageList is truthy.
      const totalUnique = npmNames.size + pypiNames.size + cratesNames.size;
      const flattenedCount = flatPackages.length; // total occurrences across all projects
       const summaryEvent: any = {
         type: 'registry-summary',
         totalUnique,
         flattenedCount,
         counts: {
           npm: npmNames.size,
           pypi: pypiNames.size,
           crates: cratesNames.size,
         },
       };
      if ((opts as any).emitPackageList) {
        summaryEvent.packages = {
          npm: Array.from(npmNames),
          pypi: Array.from(pypiNames),
          'crates.io': Array.from(cratesNames),
        };
      }
      emit(summaryEvent as ScanEvent);

      // Emit a single registry-item 'fetching' event for each unique package we will query.
      // Consumers can use these to show overall registry fetch progress without per-project duplication.
      for (const pkgName of npmNames) {
        emit({ type: 'registry-item', source: 'npm', package: pkgName, meta: { state: 'fetching' } } as unknown as ScanEvent);
      }
      for (const pkgName of pypiNames) {
        emit({ type: 'registry-item', source: 'pypi', package: pkgName, meta: { state: 'fetching' } } as unknown as ScanEvent);
      }
      for (const pkgName of cratesNames) {
        emit({ type: 'registry-item', source: 'crates.io', package: pkgName, meta: { state: 'fetching' } } as unknown as ScanEvent);
      }

      emit({ type: 'log', level: 'info', msg: `Fetching registry metadata for ${npmNames.size + pypiNames.size + cratesNames.size} packages` } as unknown as ScanEvent);

      const [npmData, pypiData, cratesData] = await Promise.all([
        fetchNpmUpdates(npmNames, opts as any, cache, (pkg, meta) => emit({ type: 'registry-item', source: 'npm', package: pkg, meta } as unknown as ScanEvent)),
        fetchPyPiUpdates(pypiNames, opts as any, cache, (pkg, meta) => emit({ type: 'registry-item', source: 'pypi', package: pkg, meta } as unknown as ScanEvent)),
        fetchCratesIoUpdates(cratesNames, opts as any, cache, (pkg, meta) => emit({ type: 'registry-item', source: 'crates.io', package: pkg, meta } as unknown as ScanEvent)),
      ]);

      try {
        saveCacheToPath(cache, opts.cachePath);
      } catch (err) {
        if (opts.verbose) console.warn('Failed to save cache:', err);
      }

      // Collect all packages with versions for vulnerability scanning
      const packagesForVulnCheck: Array<{ name: string; version: string; ecosystem: string }> = [];
      for (const pkg of flatPackages) {
        const ecosystem = pkg.source || 'unknown';
        for (const [depName, info] of Object.entries(pkg.dependencies)) {
          const version = info.installedVersion || info.declaredVersion?.replace(/^[\^~>=<]+/, '');
          if (version && /^\d/.test(version)) {
            packagesForVulnCheck.push({ name: depName, version, ecosystem });
          }
        }
      }

      emit({
        type: 'vulnerability-scan-progress',
        scanned: 0,
        total: packagesForVulnCheck.length,
        time: new Date().toISOString(),
        seq: ++seq
      } as any);

      emit({ type: 'log', level: 'info', msg: `Checking vulnerabilities for ${packagesForVulnCheck.length} packages` } as unknown as ScanEvent);

      // Check for vulnerabilities
      const vulnResults = await checkVulnerabilities(
        packagesForVulnCheck,
        opts as any,
        cache,
        (pkgName, version, vulns) => {
          // Emit vulnerability events for each vulnerability found
          for (const vuln of vulns) {
            const pkg = packagesForVulnCheck.find(p => p.name === pkgName && p.version === version);
            const source = (pkg?.ecosystem || 'npm') as 'npm' | 'pypi' | 'crates.io';
            emit({
              type: 'vulnerability',
              package: pkgName,
              version,
              source,
              vulnerability: vuln,
            } as unknown as ScanEvent);
          }
        },
        (scanned, total) => {
          emit({
            type: 'vulnerability-scan-progress',
            scanned,
            total,
            time: new Date().toISOString(),
            seq: ++seq
          } as any);
        }
      );

      // Build a map for quick vulnerability lookup
      const vulnMap = new Map<string, VulnerabilityInfo[]>();
      for (const [key, vulns] of Object.entries(vulnResults)) {
        vulnMap.set(key, vulns);
      }

      // Apply vulnerability results to dependency info
      for (const pkg of flatPackages) {
        const ecosystem = pkg.source || 'unknown';
        for (const [depName, info] of Object.entries(pkg.dependencies)) {
          const version = info.installedVersion || info.declaredVersion?.replace(/^[\^~>=<]+/, '');
          if (version) {
            const key = `${ecosystem}:${depName}@${version}`;
            const vulns = vulnMap.get(key);
            if (vulns && vulns.length > 0) {
              let meta: { latest?: string; versions: string[] } | undefined;
              if (ecosystem === 'npm') meta = npmData[depName];
              else if (ecosystem === 'pypi') meta = pypiData[depName];
              else if (ecosystem === 'crates.io') meta = cratesData[depName];

              if (meta?.versions?.length) {
                for (const vuln of vulns) {
                  if (!vuln.fixedVersion) {
                    const upgrade = chooseUpgradeTarget(version, vuln, meta.versions);
                    if (upgrade) vuln.fixedVersion = upgrade;
                  }
                }
              }

              info.vulnerabilities = vulns;
            }
          }
        }
      }

      // Save cache again after vulnerability checks
      try {
        saveCacheToPath(cache, opts.cachePath);
      } catch (err) {
        if (opts.verbose) console.warn('Failed to save cache after vulnerability check:', err);
      }

      const semver = safeRequire<any>('semver');
      function computeStatus(installed?: string | null, declared?: string | null, latest?: string | null, matching?: string | null) {
        const result: { status: 'ok' | 'outdated' | 'unknown'; updateType?: 'major' | 'minor' | 'patch' | 'unknown' } = { status: 'unknown' };
        try {
          const cur = installed || undefined;
          const target = matching || latest || undefined;
          if (cur && target && semver && semver.valid(cur) && semver.valid(target)) {
            if (semver.eq(cur, target)) result.status = 'ok';
            else if (semver.lt(cur, target)) {
              result.status = 'outdated';
              const d = semver.diff(cur, target);
              result.updateType = d === 'major' || d === 'minor' || d === 'patch' ? d : 'unknown';
            } else result.status = 'ok';
          } else if (target && cur) {
            result.status = cur === target ? 'ok' : 'outdated';
          } else if (target && !cur) {
            result.status = 'unknown';
          } else result.status = 'unknown';
        } catch (e) {
          result.status = 'unknown';
        }
        return result;
      }

      // Emit package events and project-done events
      let totalProjects = 0;
      let totalPackages = 0;
      let totalOutdated = 0;
      let totalVulnerabilities = 0;

      for (const proj of projects) {
        totalProjects++;
        const projectPath = path.dirname(proj.manifest);
        const start = Date.now();
        let projectTotal = 0;
        let projectOutdated = 0;
        let projectVulnerabilities = 0;

        for (const pkg of proj.packages) {
          for (const [depName, info] of Object.entries(pkg.dependencies)) {
            projectTotal++;
            totalPackages++;

            let meta: { latest?: string; versions: string[] } | undefined;
            if (pkg.source === 'npm') meta = npmData[depName];
            else if (pkg.source === 'pypi') meta = pypiData[depName];
            else if (pkg.source === 'crates.io') meta = cratesData[depName];

            if (meta) {
              if (meta.latest) info.latestVersion = meta.latest;
              if (meta.versions && meta.versions.length > 0) {
                const satisf = chooseLatestSatisfying(info.declaredVersion, meta.versions);
                if (satisf) (info as any).latestSatisfyingVersion = satisf;
                if (!info.latestVersion) info.latestVersion = meta.versions.slice().sort().reverse()[0];
              }
            }

            const manager = pkg.source === 'npm' ? 'npm' : pkg.source === 'crates.io' ? 'crates' : 'pypi';
            const declaredSpec = info.declaredVersion || null;
            const installedVersion = info.installedVersion || null;
            const latestVersion = info.latestVersion || null;
            const latestMatching = (info as any).latestSatisfyingVersion || null;

            const st = computeStatus(installedVersion || undefined, declaredSpec || undefined, latestVersion || undefined, latestMatching || undefined);
            if (st.status === 'outdated') {
              projectOutdated++;
              totalOutdated++;
            }

            // Count vulnerabilities
            const vulnCount = info.vulnerabilities?.length || 0;
            if (vulnCount > 0) {
              projectVulnerabilities += vulnCount;
              totalVulnerabilities += vulnCount;
            }

            const pkgEvent: any = {
              type: 'package',
              project: projectPath,
              pkg: {
                name: depName,
                manager: manager,
                declaredSpec,
                installedVersion,
                latestVersion,
                latestMatching,
                status: st.status,
                updateType: st.updateType,
                manifestFile: proj.manifest,
                vulnerabilities: info.vulnerabilities || [],
                vulnerabilityCount: vulnCount,
              },
            };

            emit(pkgEvent as ScanEvent);
          }
        }

        const durationMs = Date.now() - start;
        emit({ type: 'project-done', project: projectPath, counts: { total: projectTotal, outdated: projectOutdated, unknown: Math.max(0, projectTotal - projectOutdated), vulnerabilities: projectVulnerabilities }, durationMs } as unknown as ScanEvent);
      }

      // Build snapshot
      const snapshot: Snapshot = {
        scannedAt: new Date().toISOString(),
        root: resolved,
        packages: projects,
      };

      if (opts.outPath) {
        try {
          await writeAtomic(opts.outPath, JSON.stringify(snapshot, null, 2));
          emit({ type: 'snapshot', path: opts.outPath, summary: { projects: totalProjects, packages: totalPackages, outdated: totalOutdated, vulnerabilities: totalVulnerabilities } } as unknown as ScanEvent);
          if (done) done(null, opts.outPath);
        } catch (err) {
          emit({ type: 'error', scope: 'global', message: `Failed to write snapshot to ${opts.outPath}`, detail: err } as unknown as ScanEvent);
          if (done) done(err as Error);
        }
      } else {
        emit({ type: 'snapshot', summary: { projects: totalProjects, packages: totalPackages, outdated: totalOutdated, vulnerabilities: totalVulnerabilities } } as unknown as ScanEvent);
        if (done) done(null, undefined);
      }
    } catch (err) {
      emit({ type: 'error', scope: 'global', message: 'Unexpected error during scan', detail: err } as unknown as ScanEvent);
      if (done) done(err as Error);
    }
  })();
}

