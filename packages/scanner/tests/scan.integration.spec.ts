import path from "path";
import { describe, it, expect } from "vitest";
import { scanWorkspace } from "../src/scan";
import { Snapshot } from "../src/types";

const FIXTURES_DIR = path.resolve(__dirname, "fixtures");

describe("scanWorkspace integration (fixtures)", () => {
  it("parses pyproject.toml and reads poetry.lock installed versions", async () => {
    const snapshot: Snapshot = await scanWorkspace(FIXTURES_DIR, { skipRegistries: true, verbose: false });

    if (!snapshot.packages) {
      throw new Error("No packages found in snapshot");
    }
    const pyProject = snapshot.packages.find((p: any) => p.manifest && p.manifest.endsWith("pyproject.toml"));
    expect(pyProject, "pyproject project should be present").toBeDefined();

    if (!pyProject) {
      throw new Error("pyproject project not found");
    }

    const pyPkg = pyProject.packages && pyProject.packages[0];
    expect(pyPkg, "pyproject package object should exist").toBeDefined();

    const requests = pyPkg.dependencies["requests"];
    expect(requests).toBeDefined();
    expect(requests.declaredVersion).toBe("2.25.1");
    expect(requests.installedVersion).toBe("2.25.1");

    const numpy = pyPkg.dependencies["numpy"];
    expect(numpy).toBeDefined();
    expect(numpy.declaredVersion).toBe("1.21.0");
    expect(numpy.installedVersion).toBe("1.21.0");
  });

  it("parses Cargo.toml and reads Cargo.lock installed versions", async () => {
    const snapshot = await scanWorkspace(FIXTURES_DIR, { skipRegistries: true, verbose: false });

    if (!snapshot.packages) {
      throw new Error("No packages found in snapshot");
    }

    const rustProject = snapshot.packages.find((p: any) => p.manifest && p.manifest.endsWith("Cargo.toml"));
    expect(rustProject, "rust project should be present").toBeDefined();

    if (!rustProject) {
      throw new Error("rust project not found");
    }

    const rustPkg = rustProject.packages && rustProject.packages[0];
    expect(rustPkg, "rust package object should exist").toBeDefined();

    const serde = rustPkg.dependencies["serde"];
    expect(serde).toBeDefined();
    expect(serde.declaredVersion).toBe("1.0");
    expect(serde.installedVersion).toBe("1.0.130");

    const anyhow = rustPkg.dependencies["anyhow"];
    expect(anyhow).toBeDefined();
    expect(anyhow.declaredVersion).toBe("1.0.28");
    expect(anyhow.installedVersion).toBe("1.0.28");
  });
});