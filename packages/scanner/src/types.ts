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

interface ScanOptions {
  concurrency: number
  skipRegistries: boolean
  cachePath: string
  verbose: boolean
}

export { Snapshot, PackageJson, Package, DependencyInfo, ScanOptions };