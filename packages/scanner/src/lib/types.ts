interface Snapshot {
  scannedAt: string;
  root: string;
  packages?: PackageJson[];
}

interface VulnerabilityInfo {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown';
  title: string;
  description?: string;
  affectedVersions?: string;
  affectedVersionList?: string[];
  fixedVersion?: string;
  url?: string;
  publishedAt?: string;
}

interface DependencyInfo {
  declaredVersion: string;
  installedVersion?: string;
  latestVersion?: string;
  latestSatisfyingVersion?: string;
  vulnerabilities?: VulnerabilityInfo[];
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
  concurrency?: number;
  skipRegistries?: boolean;
  cachePath?: string;
  verbose?: boolean;
  signal?: AbortSignal; // optional cancellation signal
}

interface ScanStreamOptions extends ScanOptions {
  outPath?: string;
}

type BaseEvent = {
  type: string;
  time: string;
  seq?: number;
};

type DiscoverEvent = BaseEvent & {
  type: 'discover';
  totalProjects: number;
  manifests?: string[];
};

type ProjectStartEvent = BaseEvent & {
  type: 'project-start';
  project: string;
  manifestFile: string;
  manifestType: string;
};

type PackageEvent = BaseEvent & {
  type: 'package';
  project: string;
  pkg: {
    name: string;
    manager: 'npm' | 'pypi' | 'crates';
    declaredSpec?: string | null;
    installedVersion?: string | null;
    latestVersion?: string | null;
    latestMatching?: string | null;
    status?: 'ok' | 'outdated' | 'unknown';
    updateType?: 'major'|'minor'|'patch'|'unknown';
    manifestFile: string;
    notes?: string[];
  };
};

type RegistryItemEvent = BaseEvent & {
  type: 'registry-item';
  source: 'npm' | 'pypi' | 'crates';
  package: string;
  meta: { latest: string; versions: string[] };
};

type RegistrySummaryEvent = BaseEvent & {
  type: 'registry-summary';
  totalUnique: number;
  flattenedCount: number;
  counts: { npm: number; pypi: number; crates: number };
}

type ProjectDoneEvent = BaseEvent & {
  type: 'project-done';
  project: string;
  counts: { total: number; outdated: number; unknown: number };
  durationMs?: number;
};

type LogEvent = BaseEvent & {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  msg: string;
  context?: Record<string, any>;
};

type ErrorEvent = BaseEvent & {
  type: 'error';
  scope: 'project' | 'registry' | 'global';
  message: string;
  detail?: any;
};

type SnapshotEvent = BaseEvent & {
  type: 'snapshot';
  path?: string;
  summary?: { projects: number; packages: number; outdated: number; vulnerabilities?: number };
};

type VulnerabilityEvent = BaseEvent & {
  type: 'vulnerability';
  package: string;
  version: string;
  source: 'npm' | 'pypi' | 'crates.io';
  vulnerability: VulnerabilityInfo;
};

type VulnerabilityScanProgressEvent = BaseEvent & {
  type: 'vulnerability-scan-progress';
  scanned: number;
  total: number;
};

type ScanEvent =
  | DiscoverEvent
  | ProjectStartEvent
  | PackageEvent
  | RegistryItemEvent
  | RegistrySummaryEvent
  | ProjectDoneEvent
  | LogEvent
  | ErrorEvent
  | SnapshotEvent
  | VulnerabilityEvent
  | VulnerabilityScanProgressEvent;

export { Snapshot, PackageJson, Package, DependencyInfo, VulnerabilityInfo, ScanOptions, ScanStreamOptions, BaseEvent, DiscoverEvent, ProjectStartEvent, PackageEvent, ProjectDoneEvent, LogEvent, ErrorEvent, VulnerabilityEvent, VulnerabilityScanProgressEvent, ScanEvent };
