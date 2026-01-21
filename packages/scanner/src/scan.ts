#!/usr/bin/env node

import fs from "fs";
import path from "path";

interface Snapshot {
  scannedAt: string;
  root: string;
  packages?: PackageJson[];
}

interface DependencyInfo {
  declaredVersion: string;
  installedVersion?: string;
  latestVersion?: string;
  latestSatisfyingVersion?: string;
}

interface Package {
  name: string;
  version: string;
  source: string;
  manifestPath: string;
  dependencies: Record<string, DependencyInfo>;
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
      const lockfile = safeRequire<{ parse: (c: string) => any }>("@yarnpkg/lockfile");
      if (lockfile) {
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

export async function fetchRegistryInfo(pkg: Package): Promise<void> {
  for (const info of Object.values(pkg.dependencies)) {
    info.latestVersion = info.latestVersion || "0.0.0";
    info.latestSatisfyingVersion = info.latestSatisfyingVersion || info.declaredVersion || "";
  }
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

  return {
    scannedAt: new Date().toISOString(),
    root: resolved,
    packages,
  };
}