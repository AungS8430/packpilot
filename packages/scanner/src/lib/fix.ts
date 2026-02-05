import fs from "fs";
import { execSync } from "child_process";
import TOML from "toml";
import { Package, DependencyInfo } from "./types";

const MANIFEST_FILES = [
  "package.json",      // Node.js / npm
  "pyproject.toml",    // Python (PEP 517/518)
  "Cargo.toml",        // Rust
  "requirements.txt",  // Python pip
  "Pipfile",           // Python pipenv
  "composer.json",     // PHP Composer
  "go.mod",            // Go modules
];

interface FixOptions {
  dryRun?: boolean;
  runUpdate?: boolean;
}

interface FixResult {
  success: boolean;
  package: string;
  currentVersion?: string;
  targetVersion?: string;
  error?: string;
}

interface FixOutput {
  fixed: FixResult[];
  errors: string[];
  manifestsUpdated: string[];
  updateCommandsRun?: { manifestPath: string; command: string; success: boolean; output?: string; error?: string }[];
}

type FixEventType = 'fix-start' | 'fix-complete' | 'manifest-update' | 'update-command-start' | 'update-command-complete' | 'error' | 'log';

interface FixEvent {
  type: FixEventType;
  time: string;
  package?: string;
  currentVersion?: string;
  targetVersion?: string;
  success?: boolean;
  error?: string;
  message?: string;
  manifestPath?: string;
  command?: string;
  output?: string;
  level?: 'info' | 'warn' | 'error';
}

type FixEventCallback = (event: FixEvent) => void;

function parseVersionString(versionStr: string): { prefix: string; version: string } {
  const match = versionStr.match(/^([~^=<>*]*)(.*)/);
  if (match) {
    return { prefix: match[1] || '', version: match[2] };
  }
  return { prefix: '', version: versionStr };
}

function applyVersionPrefix(originalVersion: string, newVersion: string): string {
  const { prefix } = parseVersionString(originalVersion);
  const { version: cleanNewVersion } = parseVersionString(newVersion);
  return `${prefix}${cleanNewVersion}`;
}

function getNestedValue(obj: Record<string, any>, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, any>, path: string, value: any): void {
  const parts = path.split('.');
  const lastPart = parts.pop()!;
  let current = obj;

  for (const part of parts) {
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part];
  }

  current[lastPart] = value;
}

function updateArrayDependency(deps: string[], packageName: string, newVersion: string): string[] {
  return deps.map(dep => {
    if (dep.startsWith(packageName)) {
      // Extract operator and current version: "requests>=2.25" -> "requests", ">=2.25"
      const match = dep.match(/^([^=<>~!]+)(.*)/);
      if (match) {
        const name = match[1];
        const operator = match[2]?.match(/^[=<>~!]+/)?.[0] || '';
        return `${name}${operator}${newVersion}`;
      }
    }
    return dep;
  });
}

function getFixedVersion(dep: DependencyInfo): string | null {
  if (!dep.vulnerabilities || dep.vulnerabilities.length === 0) {
    return null;
  }

  const fixedVersions = dep.vulnerabilities
    .filter(v => v.fixedVersion)
    .map(v => v.fixedVersion as string);

  if (fixedVersions.length === 0) {
    return null;
  }

  return fixedVersions.sort().reverse()[0];
}

function loadManifest(manifestPath: string): Record<string, any> {
  const content = fs.readFileSync(manifestPath, 'utf-8');
  const filename = manifestPath.split('/').pop() || '';

  if (filename === 'package.json' || filename === 'composer.json') {
    return JSON.parse(content);
  }

  if (filename === 'pyproject.toml' || filename === 'Cargo.toml') {
    try {
      return TOML.parse(content);
    } catch (error) {
      console.warn(`Warning: Failed to parse TOML file ${filename}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {};
    }
  }

  if (filename === 'requirements.txt' || filename === 'Pipfile') {
    console.warn(`Warning: ${filename} format requires custom parsing. Skipping for now.`);
    return {};
  }

  if (filename === 'go.mod') {
    console.warn(`Warning: go.mod format requires custom parsing. Skipping for now.`);
    return {};
  }

  try {
    return JSON.parse(content);
  } catch {
    console.warn(`Warning: Could not parse ${filename}. Treating as empty manifest.`);
    return {};
  }
}

function serializeTOML(obj: Record<string, any>, currentPath = ''): string {
  const lines: string[] = [];
  const tables: Array<{ path: string; content: Record<string, any> }> = [];

  // First pass: collect simple key-value pairs and identify tables
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;

    if (typeof value === 'object' && !Array.isArray(value)) {
      // This is a table/section
      const tablePath = currentPath ? `${currentPath}.${key}` : key;
      tables.push({ path: tablePath, content: value });
    } else if (typeof value === 'string') {
      lines.push(`${key} = "${value}"`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${key} = ${value}`);
    } else if (Array.isArray(value)) {
      const items = value.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ');
      lines.push(`${key} = [${items}]`);
    }
  }

  // Second pass: process tables recursively
  for (const { path, content } of tables) {
    // Check if this table has any non-object values (meaning it needs a [section] header)
    const hasDirectValues = Object.values(content).some(v =>
      v !== null && v !== undefined && (typeof v !== 'object' || Array.isArray(v))
    );

    if (hasDirectValues) {
      lines.push(''); // Add blank line before section
      lines.push(`[${path}]`);

      // Add direct key-value pairs for this section
      for (const [key, value] of Object.entries(content)) {
        if (value === null || value === undefined) continue;

        if (typeof value === 'string') {
          lines.push(`${key} = "${value}"`);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          lines.push(`${key} = ${value}`);
        } else if (Array.isArray(value)) {
          const items = value.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ');
          lines.push(`${key} = [${items}]`);
        }
      }
    }

    // Process nested tables
    for (const [key, value] of Object.entries(content)) {
      if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
        const nestedPath = `${path}.${key}`;
        const nestedContent = serializeTOML({ [key]: value }, path);
        if (nestedContent) {
          lines.push(nestedContent);
        }
      }
    }
  }

  return lines.join('\n');
}

function saveManifest(manifestPath: string, data: Record<string, any>): void {
  const filename = manifestPath.split('/').pop() || '';
  let content = '';

  if (filename === 'package.json' || filename === 'composer.json') {
    content = JSON.stringify(data, null, 2) + '\n';
  }
  // TOML-based files: pyproject.toml, Cargo.toml
  else if (filename === 'pyproject.toml' || filename === 'Cargo.toml') {
    try {
      content = serializeTOML(data);
    } catch (error) {
      console.warn(`Warning: Failed to serialize TOML file ${filename}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return;
    }
  }
  // Text-based files: would require custom formatting
  else if (filename === 'requirements.txt' || filename === 'Pipfile' || filename === 'go.mod') {
    console.warn(`Warning: Saving ${filename} requires custom formatter. Not implemented.`);
    return;
  }
  // Fallback to JSON
  else {
    content = JSON.stringify(data, null, 2) + '\n';
  }

  const tmp = `${manifestPath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');

  // Create backup
  const backup = `${manifestPath}.backup-${Date.now()}`;
  fs.copyFileSync(manifestPath, backup);

  // Move temp to final
  fs.renameSync(tmp, manifestPath);
}

function findDependencySection(
  manifest: Record<string, any>,
  packageName: string,
  manifestPath?: string
): { section: string; found: boolean } | null {
  const filename = manifestPath?.split('/').pop() || '';

  // package.json (npm): dependencies, devDependencies, optionalDependencies, peerDependencies
  if (filename === 'package.json') {
    const npmSections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    for (const section of npmSections) {
      if (manifest[section] && manifest[section][packageName]) {
        return { section, found: true };
      }
    }
  }

  // composer.json (PHP): require, require-dev
  if (filename === 'composer.json') {
    const composerSections = ['require', 'require-dev'];
    for (const section of composerSections) {
      if (manifest[section] && manifest[section][packageName]) {
        return { section, found: true };
      }
    }
  }

  // pyproject.toml (Python): multiple formats supported
  if (filename === 'pyproject.toml') {
    // Check Poetry format: [tool.poetry.dependencies] and [tool.poetry.dev-dependencies]
    if (manifest.tool?.poetry?.dependencies && typeof manifest.tool.poetry.dependencies === 'object') {
      if (manifest.tool.poetry.dependencies[packageName]) {
        return { section: 'tool.poetry.dependencies', found: true };
      }
    }
    if (manifest.tool?.poetry?.['dev-dependencies'] && typeof manifest.tool.poetry['dev-dependencies'] === 'object') {
      if (manifest.tool.poetry['dev-dependencies'][packageName]) {
        return { section: 'tool.poetry.dev-dependencies', found: true };
      }
    }

    // Check Poetry format at root level: [poetry.dependencies] and [poetry.dev-dependencies]
    if (manifest.poetry?.dependencies && typeof manifest.poetry.dependencies === 'object') {
      if (manifest.poetry.dependencies[packageName]) {
        return { section: 'poetry.dependencies', found: true };
      }
    }
    if (manifest.poetry?.['dev-dependencies'] && typeof manifest.poetry['dev-dependencies'] === 'object') {
      if (manifest.poetry['dev-dependencies'][packageName]) {
        return { section: 'poetry.dev-dependencies', found: true };
      }
    }

    // Check PEP 621 format: [project] dependencies as array
    if (manifest.project?.dependencies && Array.isArray(manifest.project.dependencies)) {
      const depIndex = manifest.project.dependencies.findIndex((dep: string) => dep.startsWith(packageName));
      if (depIndex !== -1) {
        return { section: 'project.dependencies', found: true };
      }
    }

    // Check [project.optional-dependencies.*]
    if (manifest.project?.['optional-dependencies'] && typeof manifest.project['optional-dependencies'] === 'object') {
      for (const [groupName, deps] of Object.entries(manifest.project['optional-dependencies'])) {
        if (Array.isArray(deps)) {
          const depIndex = deps.findIndex((dep: string) => dep.startsWith(packageName));
          if (depIndex !== -1) {
            return { section: `project.optional-dependencies.${groupName}`, found: true };
          }
        }
      }
    }

    // Check direct [dependencies] section (if exists)
    if (manifest.dependencies && typeof manifest.dependencies === 'object' && manifest.dependencies[packageName]) {
      return { section: 'dependencies', found: true };
    }
    if (manifest['dev-dependencies'] && typeof manifest['dev-dependencies'] === 'object' && manifest['dev-dependencies'][packageName]) {
      return { section: 'dev-dependencies', found: true };
    }
  }

  // Cargo.toml (Rust): dependencies, dev-dependencies, build-dependencies
  if (filename === 'Cargo.toml') {
    const cargoSections = ['dependencies', 'dev-dependencies', 'build-dependencies'];
    for (const section of cargoSections) {
      if (manifest[section] && manifest[section][packageName]) {
        return { section, found: true };
      }
    }
  }

  // go.mod (Go): require, require indirect (parsed as dependencies)
  if (filename === 'go.mod') {
    const goSections = ['require', 'dependencies'];
    for (const section of goSections) {
      if (manifest[section] && manifest[section][packageName]) {
        return { section, found: true };
      }
    }
  }

  // Pipfile (Python pipenv): packages, dev-packages
  if (filename === 'Pipfile') {
    const pipfileSections = ['packages', 'dev-packages'];
    for (const section of pipfileSections) {
      if (manifest[section] && manifest[section][packageName]) {
        return { section, found: true };
      }
    }
  }

  // Fallback: try standard npm sections for unknown formats
  const fallbackSections = ['dependencies', 'devDependencies', 'require'];
  for (const section of fallbackSections) {
    if (manifest[section] && manifest[section][packageName]) {
      return { section, found: true };
    }
  }

  return null;
}

function getUpdateCommand(manifestPath: string): string | null {
  const filename = manifestPath.split('/').pop() || '';
  const dir = manifestPath.substring(0, manifestPath.lastIndexOf('/'));

  switch (filename) {
    case 'package.json':
      // Check if pnpm-lock.yaml, yarn.lock, or package-lock.json exists
      if (fs.existsSync(`${dir}/pnpm-lock.yaml`)) {
        return 'pnpm install';
      } else if (fs.existsSync(`${dir}/yarn.lock`)) {
        return 'yarn install';
      } else {
        return 'npm install';
      }

    case 'pyproject.toml':
      // Check if poetry.lock exists
      if (fs.existsSync(`${dir}/poetry.lock`)) {
        return 'poetry install';
      } else if (fs.existsSync(`${dir}/Pipfile.lock`)) {
        return 'pipenv install';
      } else {
        return 'pip install -e .';
      }

    case 'Cargo.toml':
      return 'cargo build';

    case 'requirements.txt':
      return 'pip install -r requirements.txt';

    case 'Pipfile':
      return 'pipenv install';

    case 'composer.json':
      return 'composer install';

    case 'go.mod':
      return 'go mod download';

    default:
      return null;
  }
}

function executeUpdateCommand(
  manifestPath: string,
  command: string,
  eventCallback?: FixEventCallback
): { success: boolean; output?: string; error?: string } {
  const dir = manifestPath.substring(0, manifestPath.lastIndexOf('/'));

  eventCallback?.({
    type: 'update-command-start',
    time: new Date().toISOString(),
    manifestPath,
    command,
    message: `Running update command: ${command}`,
  });

  try {
    const output = execSync(command, {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000, // 5 minutes timeout
    });

    eventCallback?.({
      type: 'update-command-complete',
      time: new Date().toISOString(),
      manifestPath,
      command,
      success: true,
      output,
      message: `Successfully ran: ${command}`,
    });

    return { success: true, output };
  } catch (error: any) {
    const errorMsg = error.message || 'Unknown error';
    const errorOutput = error.stderr?.toString() || error.stdout?.toString() || '';

    eventCallback?.({
      type: 'update-command-complete',
      time: new Date().toISOString(),
      manifestPath,
      command,
      success: false,
      error: errorMsg,
      output: errorOutput,
      message: `Failed to run: ${command}`,
    });

    return { success: false, error: errorMsg, output: errorOutput };
  }
}

async function fixPackageVulnerabilities(
  pkg: Package,
  options: FixOptions = {},
  eventCallback?: FixEventCallback
): Promise<FixResult[]> {
  const results: FixResult[] = [];
  const dryRun = options.dryRun ?? false;

  try {
    const manifest = loadManifest(pkg.manifestPath);
    let manifestChanged = false;

    // Process each dependency
    for (const [depName, depInfo] of Object.entries(pkg.dependencies)) {
      if (!depInfo.vulnerabilities || depInfo.vulnerabilities.length === 0) {
        continue;
      }

      const fixedVersion = getFixedVersion(depInfo);
      if (!fixedVersion) {
        eventCallback?.({
          type: 'log',
          time: new Date().toISOString(),
          level: 'warn',
          message: `No fixed version found for ${depName}`,
        });
        continue;
      }

      // Find the dependency section
      const sectionInfo = findDependencySection(manifest, depName, pkg.manifestPath);
      if (!sectionInfo) {
        eventCallback?.({
          type: 'error',
          time: new Date().toISOString(),
          package: depName,
          message: `Dependency not found in manifest: ${depName}`,
        });
        results.push({
          success: false,
          package: depName,
          currentVersion: depInfo.declaredVersion,
          targetVersion: fixedVersion,
          error: 'Dependency not found in manifest',
        });
        continue;
      }

      let currentVersion: string;
      const section = sectionInfo.section;

      // Handle nested paths (e.g., "tool.poetry.dependencies")
      if (section.includes('.')) {
        const parts = section.split('.');
        const depObj = getNestedValue(manifest, parts.slice(0, -1).join('.'));
        const finalKey = parts[parts.length - 1];

        if (Array.isArray(depObj?.[finalKey])) {
          // Array format: find the dependency
          const depEntry = depObj[finalKey].find((d: string) => d.startsWith(depName));
          currentVersion = depEntry || depInfo.declaredVersion;
        } else if (typeof depObj?.[finalKey] === 'object') {
          currentVersion = depObj[finalKey][depName] || depInfo.declaredVersion;
        } else {
          currentVersion = depInfo.declaredVersion;
        }
      } else {
        // Simple section like "dependencies"
        if (Array.isArray(manifest[section])) {
          const depEntry = manifest[section].find((d: string) => d.startsWith(depName));
          currentVersion = depEntry || depInfo.declaredVersion;
        } else {
          currentVersion = manifest[section][depName] || depInfo.declaredVersion;
        }
      }

      const newVersion = applyVersionPrefix(currentVersion, fixedVersion);

      eventCallback?.({
        type: 'fix-start',
        time: new Date().toISOString(),
        package: depName,
        currentVersion: currentVersion,
        targetVersion: newVersion,
      });

      if (!dryRun) {
        if (section.includes('.')) {
          // Nested path - need special handling
          const parts = section.split('.');
          const depObjPath = parts.slice(0, -1).join('.');
          const finalKey = parts[parts.length - 1];
          const depObj = getNestedValue(manifest, depObjPath);

          if (Array.isArray(depObj?.[finalKey])) {
            // Update array format
            depObj[finalKey] = updateArrayDependency(depObj[finalKey], depName, fixedVersion);
          } else if (typeof depObj?.[finalKey] === 'object') {
            // Update table format
            depObj[finalKey][depName] = newVersion;
          }
        } else {
          // Simple section
          if (Array.isArray(manifest[section])) {
            // Update array format
            manifest[section] = updateArrayDependency(manifest[section], depName, fixedVersion);
          } else {
            // Update table format
            manifest[section][depName] = newVersion;
          }
        }
        manifestChanged = true;
      }

      results.push({
        success: true,
        package: depName,
        currentVersion: currentVersion,
        targetVersion: newVersion,
      });

      eventCallback?.({
        type: 'fix-complete',
        time: new Date().toISOString(),
        package: depName,
        currentVersion: currentVersion,
        targetVersion: newVersion,
        success: true,
      });
    }

    // Save manifest if changes were made and not in dry-run mode
    if (manifestChanged && !dryRun) {
      saveManifest(pkg.manifestPath, manifest);
      eventCallback?.({
        type: 'manifest-update',
        time: new Date().toISOString(),
        manifestPath: pkg.manifestPath,
        message: `Updated ${pkg.manifestPath}`,
      });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    eventCallback?.({
      type: 'error',
      time: new Date().toISOString(),
      message: errorMsg,
    });
  }

  return results;
}

async function fixVulnerabilities(
  packages: Package[],
  options: FixOptions = {},
  eventCallback?: FixEventCallback
): Promise<FixOutput> {
  const output: FixOutput = {
    fixed: [],
    errors: [],
    manifestsUpdated: new Set<string>(),
    updateCommandsRun: [],
  } as any;

  for (const pkg of packages) {
    const results = await fixPackageVulnerabilities(pkg, options, eventCallback);

    for (const result of results) {
      if (result.success) {
        output.fixed.push(result);
      } else {
        output.errors.push(result.error || `Failed to fix ${result.package}`);
      }
    }

    // Track updated manifests
    if (results.length > 0 && !options.dryRun) {
      (output.manifestsUpdated as any).add(pkg.manifestPath);
    }
  }

  // Convert Set to Array
  output.manifestsUpdated = Array.from(output.manifestsUpdated as any);

  // Run update commands if requested and not in dry-run mode
  if (options.runUpdate && !options.dryRun && output.manifestsUpdated.length > 0) {
    eventCallback?.({
      type: 'log',
      time: new Date().toISOString(),
      level: 'info',
      message: `Running update commands for ${output.manifestsUpdated.length} manifest(s)...`,
    });

    for (const manifestPath of output.manifestsUpdated) {
      const command = getUpdateCommand(manifestPath);

      if (!command) {
        eventCallback?.({
          type: 'log',
          time: new Date().toISOString(),
          level: 'warn',
          message: `No update command found for ${manifestPath}`,
        });
        continue;
      }

      const result = executeUpdateCommand(manifestPath, command, eventCallback);
      output.updateCommandsRun!.push({
        manifestPath,
        command,
        ...result,
      });
    }
  }

  return output;
}

export {
  fixPackageVulnerabilities,
  fixVulnerabilities,
  MANIFEST_FILES,
  FixEvent,
  FixEventCallback,
  FixOptions,
  FixResult,
  FixOutput
};
