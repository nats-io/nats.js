/**
 * Version Manager for NATS.js Monorepo
 *
 * This tool manages versions across all modules in the NATS.js monorepo.
 * It is designed to handle future versions of modules that may not yet exist in registries.
 *
 * Key features:
 * - Check version consistency across all modules
 * - Fix version inconsistencies
 * - Bump versions using npm's versioning (with --ignore-scripts and --workspaces-update=false by default)
 * - Suggest version bumps based on conventional commits
 * - List versions from NPM/JSR registries
 *
 * Note: The bump command uses --ignore-scripts to prevent any npm lifecycle scripts
 * (including postversion) from running, and --workspaces-update=false to prevent npm
 * from attempting to resolve dependencies that don't exist yet in the registry.
 * All operations are local only.
 */

import { parse } from "https://deno.land/std@0.224.0/jsonc/parse.ts";
import * as semver from "https://deno.land/std@0.224.0/semver/mod.ts";

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface DenoJson {
  name?: string;
  version?: string;
  imports?: Record<string, string>;
  [key: string]: unknown;
}

interface Commit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

interface VersionSuggestion {
  module: string;
  currentVersion: string;
  suggestedBump: "major" | "minor" | "patch" | "none";
  reason: string;
  commits: Commit[];
}

const NATS_SCOPE = "@nats-io/";

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await Deno.readTextFile(filePath);
    return parse(content) as T;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await Deno.writeTextFile(filePath, content + "\n");
}

async function getAllPackageAndDenoJsonPaths(): Promise<string[]> {
  const paths: string[] = [];
  for await (const dirEntry of Deno.readDir(".")) {
    if (dirEntry.isDirectory && !dirEntry.name.startsWith(".")) {
      const packageJsonPath = `${dirEntry.name}/package.json`;
      const denoJsonPath = `${dirEntry.name}/deno.json`;
      try {
        await Deno.stat(packageJsonPath);
        paths.push(packageJsonPath);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          throw e;
        }
      }
      try {
        await Deno.stat(denoJsonPath);
        paths.push(denoJsonPath);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          throw e;
        }
      }
    }
  }
  // Add root package.json and deno.json
  try {
    await Deno.stat("package.json");
    paths.push("package.json");
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }
  try {
    await Deno.stat("deno.json");
    paths.push("deno.json");
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }
  return paths;
}

async function getModuleVersions(): Promise<Map<string, string>> {
  const moduleVersions = new Map<string, string>();
  const paths = await getAllPackageAndDenoJsonPaths();

  // First pass: collect all module versions from their own files
  for (const path of paths) {
    if (path.endsWith("package.json")) {
      const pkg = await readJsonFile<PackageJson>(path);
      if (pkg && pkg.name && pkg.version && pkg.name.startsWith(NATS_SCOPE)) {
        const existingVersion = moduleVersions.get(pkg.name);
        if (existingVersion && existingVersion !== pkg.version) {
          console.warn(
            `Warning: ${pkg.name} has different versions in package.json (${pkg.version}) and deno.json (${existingVersion})`,
          );
          // Use the higher version as the expected one
          const comparison = semver.compare(
            semver.parse(pkg.version),
            semver.parse(existingVersion),
          );
          if (comparison > 0) {
            moduleVersions.set(pkg.name, pkg.version);
          }
        } else {
          moduleVersions.set(pkg.name, pkg.version);
        }
      }
    } else if (path.endsWith("deno.json")) {
      const denoConfig = await readJsonFile<DenoJson>(path);
      if (
        denoConfig && denoConfig.name && denoConfig.version &&
        denoConfig.name.startsWith(NATS_SCOPE)
      ) {
        const existingVersion = moduleVersions.get(denoConfig.name);
        if (existingVersion && existingVersion !== denoConfig.version) {
          console.warn(
            `Warning: ${denoConfig.name} has different versions in package.json (${existingVersion}) and deno.json (${denoConfig.version})`,
          );
          // Use the higher version as the expected one
          const comparison = semver.compare(
            semver.parse(denoConfig.version),
            semver.parse(existingVersion),
          );
          if (comparison > 0) {
            moduleVersions.set(denoConfig.name, denoConfig.version);
          }
        } else {
          moduleVersions.set(denoConfig.name, denoConfig.version);
        }
      }
    }
  }
  return moduleVersions;
}

async function checkVersions() {
  const moduleVersions = await getModuleVersions();
  const allFiles = await getAllPackageAndDenoJsonPaths();
  const inconsistencies: Array<{
    file: string;
    module: string;
    expected: string;
    actual: string;
  }> = [];

  // First check if each module's own package.json and deno.json have the same version
  const moduleOwnVersions = new Map<
    string,
    { packageVersion?: string; denoVersion?: string }
  >();

  for (const filePath of allFiles) {
    if (filePath.endsWith("package.json")) {
      const pkg = await readJsonFile<PackageJson>(filePath);
      if (pkg && pkg.name && pkg.version && pkg.name.startsWith(NATS_SCOPE)) {
        const existing = moduleOwnVersions.get(pkg.name) || {};
        existing.packageVersion = pkg.version;
        moduleOwnVersions.set(pkg.name, existing);
      }
    } else if (filePath.endsWith("deno.json")) {
      const denoConfig = await readJsonFile<DenoJson>(filePath);
      if (
        denoConfig && denoConfig.name && denoConfig.version &&
        denoConfig.name.startsWith(NATS_SCOPE)
      ) {
        const existing = moduleOwnVersions.get(denoConfig.name) || {};
        existing.denoVersion = denoConfig.version;
        moduleOwnVersions.set(denoConfig.name, existing);
      }
    }
  }

  // Check for mismatches in module's own files
  for (const [moduleName, versions] of moduleOwnVersions) {
    if (
      versions.packageVersion && versions.denoVersion &&
      versions.packageVersion !== versions.denoVersion
    ) {
      // Find the actual file paths
      for (const filePath of allFiles) {
        if (filePath.endsWith("package.json")) {
          const pkg = await readJsonFile<PackageJson>(filePath);
          if (pkg && pkg.name === moduleName) {
            inconsistencies.push({
              file: filePath,
              module: `${moduleName} (own version)`,
              expected: versions.packageVersion!,
              actual: versions.packageVersion!,
            });
          }
        } else if (filePath.endsWith("deno.json")) {
          const denoConfig = await readJsonFile<DenoJson>(filePath);
          if (denoConfig && denoConfig.name === moduleName) {
            inconsistencies.push({
              file: filePath,
              module: `${moduleName} (own version)`,
              expected: versions.packageVersion!,
              actual: versions.denoVersion!,
            });
          }
        }
      }
    }
  }

  // Build module directory map
  const moduleDirs = new Map<string, string>();
  for (const filePath of allFiles) {
    if (filePath.endsWith("package.json")) {
      const pkg = await readJsonFile<PackageJson>(filePath);
      if (pkg && pkg.name && pkg.name.startsWith(NATS_SCOPE)) {
        const lastSlash = filePath.lastIndexOf("/");
        const dir = lastSlash > 0 ? filePath.substring(0, lastSlash) : ".";
        moduleDirs.set(pkg.name, dir);
      }
    } else if (filePath.endsWith("deno.json")) {
      const denoConfig = await readJsonFile<DenoJson>(filePath);
      if (
        denoConfig && denoConfig.name && denoConfig.name.startsWith(NATS_SCOPE)
      ) {
        const lastSlash = filePath.lastIndexOf("/");
        const dir = lastSlash > 0 ? filePath.substring(0, lastSlash) : ".";
        moduleDirs.set(denoConfig.name, dir);
      }
    }
  }

  // Check version.ts files match manifest versions
  const modulesWithVersionTs = [
    "@nats-io/nats-core",
    "@nats-io/transport-node",
    "@nats-io/transport-deno",
  ];

  for (const moduleName of modulesWithVersionTs) {
    const moduleDir = moduleDirs.get(moduleName);
    if (!moduleDir) continue;

    const versionTsPath = `${moduleDir}/src/version.ts`;
    try {
      const versionTsContent = await Deno.readTextFile(versionTsPath);
      const versionMatch = versionTsContent.match(
        /export const version = "([^"]+)"/,
      );
      if (versionMatch) {
        const versionTsVersion = versionMatch[1];
        const expectedVersion = moduleVersions.get(moduleName);
        if (expectedVersion && versionTsVersion !== expectedVersion) {
          inconsistencies.push({
            file: versionTsPath,
            module: `${moduleName} (version.ts)`,
            expected: expectedVersion,
            actual: versionTsVersion,
          });
        }
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        console.error(`Error reading ${versionTsPath}: ${e}`);
      }
    }
  }

  // Now check dependencies
  for (const filePath of allFiles) {
    if (filePath.endsWith("package.json")) {
      const pkg = await readJsonFile<PackageJson>(filePath);
      if (!pkg) continue;

      const checkDependencies = (deps?: Record<string, string>) => {
        if (!deps) return;
        for (const depName in deps) {
          if (depName.startsWith(NATS_SCOPE)) {
            const expectedVersion = moduleVersions.get(depName);
            const actualVersion = deps[depName];
            if (expectedVersion && actualVersion !== expectedVersion) {
              inconsistencies.push({
                file: filePath,
                module: depName,
                expected: expectedVersion,
                actual: actualVersion,
              });
            }
          }
        }
      };
      checkDependencies(pkg.dependencies);
      checkDependencies(pkg.devDependencies);
    } else if (filePath.endsWith("deno.json")) {
      const denoConfig = await readJsonFile<DenoJson>(filePath);
      if (!denoConfig || !denoConfig.imports) continue;

      for (const importPath in denoConfig.imports) {
        const importString = denoConfig.imports[importPath];
        const match = importString.match(/jsr:(@nats-io\/[^@]+)@([\d\.-]+)/);
        if (match) {
          const depName = match[1];
          const actualVersion = match[2];
          const expectedVersion = moduleVersions.get(depName);
          if (expectedVersion && actualVersion !== expectedVersion) {
            inconsistencies.push({
              file: filePath,
              module: depName,
              expected: expectedVersion,
              actual: actualVersion,
            });
          }
        }
      }
    }
  }

  if (inconsistencies.length === 0) {
    console.log("All internal NATS module versions are consistent.");
  } else {
    console.log(`Found ${inconsistencies.length} version inconsistencies:\n`);
    console.table(inconsistencies);
  }
  return inconsistencies.length > 0;
}

async function fixVersions() {
  const moduleVersions = await getModuleVersions();
  const allFiles = await getAllPackageAndDenoJsonPaths();
  let fixedCount = 0;

  // First fix module's own version mismatches
  for (const filePath of allFiles) {
    if (filePath.endsWith("deno.json")) {
      const denoConfig = await readJsonFile<DenoJson>(filePath);
      if (
        denoConfig && denoConfig.name && denoConfig.version &&
        denoConfig.name.startsWith(NATS_SCOPE)
      ) {
        const expectedVersion = moduleVersions.get(denoConfig.name);
        if (expectedVersion && denoConfig.version !== expectedVersion) {
          denoConfig.version = expectedVersion;
          await writeJsonFile(filePath, denoConfig);
          console.log(
            `Fixed ${filePath}: ${denoConfig.name} own version to ${expectedVersion}`,
          );
          fixedCount++;
        }
      }
    }
  }

  // Then fix dependencies
  for (const filePath of allFiles) {
    if (filePath.endsWith("package.json")) {
      const pkg = await readJsonFile<PackageJson>(filePath);
      if (!pkg) continue;

      let changed = false;
      const fixDependencies = (deps?: Record<string, string>) => {
        if (!deps) return;
        for (const depName in deps) {
          if (depName.startsWith(NATS_SCOPE)) {
            const expectedVersion = moduleVersions.get(depName);
            const actualVersion = deps[depName];
            if (expectedVersion && actualVersion !== expectedVersion) {
              deps[depName] = expectedVersion;
              console.log(
                `Fixed ${filePath}: ${depName} to ${expectedVersion}`,
              );
              changed = true;
              fixedCount++;
            }
          }
        }
      };
      fixDependencies(pkg.dependencies);
      fixDependencies(pkg.devDependencies);

      if (changed) {
        await writeJsonFile(filePath, pkg);
      }
    } else if (filePath.endsWith("deno.json")) {
      const denoConfig = await readJsonFile<DenoJson>(filePath);
      if (!denoConfig || !denoConfig.imports) continue;

      let changed = false;
      for (const importPath in denoConfig.imports) {
        const importString = denoConfig.imports[importPath];
        const match = importString.match(/jsr:(@nats-io\/[^@]+)@([\d\.-]+)/);
        if (match) {
          const depName = match[1];
          const actualVersion = match[2];
          const expectedVersion = moduleVersions.get(depName);
          if (expectedVersion && actualVersion !== expectedVersion) {
            denoConfig.imports[importPath] =
              `jsr:${depName}@${expectedVersion}`;
            console.log(
              `Fixed ${filePath}: ${depName} to ${expectedVersion}`,
            );
            changed = true;
            fixedCount++;
          }
        }
      }
      if (changed) {
        await writeJsonFile(filePath, denoConfig);
      }
    }
  }
  // Fix version.ts files
  const modulesWithVersionTs = [
    "@nats-io/nats-core",
    "@nats-io/transport-node",
    "@nats-io/transport-deno",
  ];

  // Build module directory map
  const moduleDirs = new Map<string, string>();
  for (const filePath of allFiles) {
    if (filePath.endsWith("package.json")) {
      const pkg = await readJsonFile<PackageJson>(filePath);
      if (pkg && pkg.name && pkg.name.startsWith(NATS_SCOPE)) {
        const lastSlash = filePath.lastIndexOf("/");
        const dir = lastSlash > 0 ? filePath.substring(0, lastSlash) : ".";
        moduleDirs.set(pkg.name, dir);
      }
    } else if (filePath.endsWith("deno.json")) {
      const denoConfig = await readJsonFile<DenoJson>(filePath);
      if (
        denoConfig && denoConfig.name && denoConfig.name.startsWith(NATS_SCOPE)
      ) {
        const lastSlash = filePath.lastIndexOf("/");
        const dir = lastSlash > 0 ? filePath.substring(0, lastSlash) : ".";
        moduleDirs.set(denoConfig.name, dir);
      }
    }
  }

  for (const moduleName of modulesWithVersionTs) {
    const moduleDir = moduleDirs.get(moduleName);
    if (!moduleDir) continue;

    const expectedVersion = moduleVersions.get(moduleName);
    if (!expectedVersion) continue;

    const versionTsPath = `${moduleDir}/src/version.ts`;
    try {
      const versionTsContent = await Deno.readTextFile(versionTsPath);
      const versionMatch = versionTsContent.match(
        /export const version = "([^"]+)"/,
      );
      if (versionMatch && versionMatch[1] !== expectedVersion) {
        const versionContent = `// This file is generated - do not edit
export const version = "${expectedVersion}";
`;
        await Deno.writeTextFile(versionTsPath, versionContent);
        console.log(`Fixed ${versionTsPath}: version to ${expectedVersion}`);
        fixedCount++;
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        console.error(`Error updating ${versionTsPath}: ${e}`);
      }
    }
  }

  console.log(`Fixed ${fixedCount} version inconsistencies.`);
}

async function bumpVersion(
  moduleName: string,
  bumpType: string,
  preid?: string,
  isDependent: boolean = false,
) {
  const allFiles = await getAllPackageAndDenoJsonPaths();
  let originalVersion: string | undefined;
  let newVersion: string | undefined;
  let moduleDir: string | undefined;

  // Find the module directory and its package.json or deno.json
  for (const filePath of allFiles) {
    if (filePath.endsWith("package.json")) {
      const content = await readJsonFile<PackageJson>(filePath);
      if (content && content.name === moduleName && content.version) {
        originalVersion = content.version;
        // Extract directory from path
        const lastSlash = filePath.lastIndexOf("/");
        moduleDir = lastSlash > 0 ? filePath.substring(0, lastSlash) : ".";
        break;
      }
    } else if (filePath.endsWith("deno.json")) {
      const content = await readJsonFile<DenoJson>(filePath);
      if (content && content.name === moduleName && content.version) {
        originalVersion = content.version;
        // Extract directory from path
        const lastSlash = filePath.lastIndexOf("/");
        moduleDir = lastSlash > 0 ? filePath.substring(0, lastSlash) : ".";
        break;
      }
    }
  }

  if (!originalVersion || !moduleDir) {
    console.error(`Could not find module ${moduleName} to bump its version.`);
    return;
  }

  // Handle release bump type to remove prerelease qualifier
  if (bumpType === "release") {
    const currentSemver = semver.parse(originalVersion);
    if (!currentSemver.prerelease || currentSemver.prerelease.length === 0) {
      console.log(
        `${moduleName} is already a release version: ${originalVersion}`,
      );
      return;
    }
    // Remove prerelease suffix
    newVersion =
      `${currentSemver.major}.${currentSemver.minor}.${currentSemver.patch}`;

    // Update package.json manually if it exists
    const pkg = await readJsonFile<PackageJson>(`${moduleDir}/package.json`);
    if (pkg) {
      pkg.version = newVersion;
      await writeJsonFile(`${moduleDir}/package.json`, pkg);
    }

    // Update deno.json if it exists (for deno-only modules)
    const denoJsonPath = `${moduleDir}/deno.json`;
    const denoConfig = await readJsonFile<DenoJson>(denoJsonPath);
    if (denoConfig && denoConfig.version) {
      denoConfig.version = newVersion;
      await writeJsonFile(denoJsonPath, denoConfig);
    }

    console.log(
      `Released ${moduleName} from ${originalVersion} to ${newVersion}`,
    );
  } else {
    // Calculate version using semver for all modules
    const currentSemver = semver.parse(originalVersion);

    // Handle special bump types with preid
    if (
      bumpType === "premajor" || bumpType === "preminor" ||
      bumpType === "prepatch" || bumpType === "prerelease"
    ) {
      // For pre-versions, use the preid if provided
      const prereleaseIdentifier = preid || undefined;

      if (
        bumpType === "prerelease" && currentSemver.prerelease &&
        currentSemver.prerelease.length > 0
      ) {
        // If already a prerelease, just increment the prerelease version
        newVersion = semver.format(
          semver.increment(currentSemver, "prerelease", prereleaseIdentifier)!,
        );
      } else {
        // Otherwise use the appropriate pre-bump type
        const releaseType = bumpType as
          | "premajor"
          | "preminor"
          | "prepatch"
          | "prerelease";
        newVersion = semver.format(
          semver.increment(currentSemver, releaseType, prereleaseIdentifier)!,
        );
      }
    } else {
      // Regular version bumps
      const releaseType = bumpType as "major" | "minor" | "patch";
      newVersion = semver.format(semver.increment(currentSemver, releaseType)!);
    }

    console.log(
      `Bumped ${moduleName} from ${originalVersion} to ${newVersion}`,
    );

    // Update package.json if it exists
    const pkg = await readJsonFile<PackageJson>(`${moduleDir}/package.json`);
    if (pkg) {
      pkg.version = newVersion;
      await writeJsonFile(`${moduleDir}/package.json`, pkg);
    }

    // Update deno.json if it exists
    const denoJsonPath = `${moduleDir}/deno.json`;
    const denoConfig = await readJsonFile<DenoJson>(denoJsonPath);
    if (denoConfig && denoConfig.version) {
      denoConfig.version = newVersion;
      await writeJsonFile(denoJsonPath, denoConfig);
      console.log(`Updated ${denoJsonPath} to version ${newVersion}`);
    }
  }

  // Update version.ts if it exists
  const versionTsPath = `${moduleDir}/src/version.ts`;
  try {
    await Deno.stat(versionTsPath);
    const versionContent = `// This file is generated - do not edit
export const version = "${newVersion}";
`;
    await Deno.writeTextFile(versionTsPath, versionContent);
    console.log(`Updated ${versionTsPath} to version ${newVersion}`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error(`Error updating version.ts: ${error}`);
    }
  }

  // Define module dependencies
  const MODULE_DEPENDENCIES: Record<string, string[]> = {
    "@nats-io/nats-core": [],
    "@nats-io/transport-node": ["@nats-io/nats-core"],
    "@nats-io/transport-deno": ["@nats-io/nats-core"],
    "@nats-io/jetstream": ["@nats-io/nats-core"],
    "@nats-io/kv": ["@nats-io/nats-core", "@nats-io/jetstream"],
    "@nats-io/obj": ["@nats-io/nats-core", "@nats-io/jetstream"],
    "@nats-io/services": ["@nats-io/nats-core"],
  };

  // Find all modules that depend on the bumped module
  const dependentModules = new Set<string>();
  for (const [mod, deps] of Object.entries(MODULE_DEPENDENCIES)) {
    if (deps.includes(moduleName)) {
      dependentModules.add(mod);
    }
  }

  // If we bumped a dependency, we need to bump dependents too (but only if not already a dependent)
  if (
    !isDependent && dependentModules.size > 0 &&
    (bumpType === "major" || bumpType === "minor")
  ) {
    console.log(`\nPropagating ${bumpType} bump to dependent modules...`);
    for (const depModule of dependentModules) {
      console.log(`\nBumping ${depModule} due to ${moduleName} dependency...`);
      await bumpVersion(
        depModule,
        bumpType === "major" ? "major" : "minor",
        preid,
        true,
      );
    }
  }

  // Update all references to the bumped module
  let updatedReferences = 0;
  for (const filePath of allFiles) {
    if (
      filePath.endsWith("package.json") || filePath.endsWith("deno.json")
    ) {
      let content: PackageJson | DenoJson | null = null;
      if (filePath.endsWith("package.json")) {
        content = await readJsonFile<PackageJson>(filePath);
      } else {
        content = await readJsonFile<DenoJson>(filePath);
      }

      if (!content) continue;

      let changed = false;
      // Update package.json dependencies
      const updateDeps = (deps?: Record<string, string>) => {
        if (!deps) return;
        if (deps[moduleName] && deps[moduleName] !== newVersion) {
          deps[moduleName] = newVersion;
          changed = true;
          updatedReferences++;
        }
      };
      updateDeps((content as PackageJson).dependencies);
      updateDeps((content as PackageJson).devDependencies);

      // Update deno.json imports
      if ((content as DenoJson).imports) {
        for (const importPath in (content as DenoJson).imports) {
          const importString = (content as DenoJson).imports![importPath];
          // Escape special regex characters in module name
          const escapedModuleName = moduleName.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\$&",
          );
          const match = importString.match(
            new RegExp(`(jsr:${escapedModuleName})@([\\d.-]+)`),
          );
          if (match && match[2] !== newVersion) {
            (content as DenoJson).imports![importPath] = `${
              match[1]
            }@${newVersion}`;
            changed = true;
            updatedReferences++;
          }
        }
      }

      if (changed) {
        await writeJsonFile(filePath, content);
      }
    }
  }
  console.log(
    `Updated ${updatedReferences} references to ${moduleName} to version ${newVersion}.`,
  );
}

async function fetchRemoteVersions(
  moduleName?: string,
  showAll: boolean = false,
) {
  const results: Array<{
    module: string;
    local?: string;
    npmLatest?: string;
    npmNext?: string;
    jsrLatest?: string;
    jsrPrerelease?: string;
  }> = [];

  if (moduleName) {
    // Single module specified - use it as-is
    const result = await fetchModuleVersions(moduleName, showAll);
    if (result) results.push(result);
  } else {
    // No module specified - fetch all local NATS modules
    const modules = Array.from((await getModuleVersions()).keys());

    // Define sort order
    const sortOrder = [
      "@nats-io/nats-core",
      "@nats-io/jetstream",
      "@nats-io/kv",
      "@nats-io/obj",
      "@nats-io/services",
      "@nats-io/transport-node",
      "@nats-io/transport-deno",
    ];

    // Sort modules according to defined order
    modules.sort((a, b) => {
      const aIndex = sortOrder.indexOf(a);
      const bIndex = sortOrder.indexOf(b);

      // If both are in sort order, sort by their position
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      // If only a is in sort order, it comes first
      if (aIndex !== -1) return -1;
      // If only b is in sort order, it comes first
      if (bIndex !== -1) return 1;
      // Neither in sort order, sort alphabetically
      return a.localeCompare(b);
    });

    for (const mod of modules) {
      const result = await fetchModuleVersions(mod, showAll);
      if (result) results.push(result);
    }
  }

  if (!showAll && results.length > 0) {
    // Display as table
    console.log();
    console.table(results);
  }
}

async function fetchModuleVersions(
  moduleName: string,
  showAll: boolean = false,
) {
  const result = {
    module: moduleName,
    local: undefined as string | undefined,
    npmLatest: undefined as string | undefined,
    npmNext: undefined as string | undefined,
    jsrLatest: undefined as string | undefined,
    jsrPrerelease: undefined as string | undefined,
  };

  if (showAll) {
    console.log(`\nFetching versions for ${moduleName}:`);
  }

  // Try JSR first - JSR requires scoped packages
  if (moduleName.startsWith("@")) {
    try {
      const jsrUrl = `https://jsr.io/${moduleName}/meta.json`;
      const response = await fetch(jsrUrl);
      if (response.ok) {
        const data = await response.json();
        const versions = Object.keys(data.versions || {});

        if (showAll) {
          const displayVersions = versions.slice(0, 10);
          console.log(
            `  JSR: ${displayVersions.join(", ")}${
              displayVersions.length >= 10 ? ", ..." : ""
            }`,
          );
        } else {
          // Sort versions using semver
          const sortedVersions = versions.sort((a, b) =>
            semver.compare(semver.parse(b), semver.parse(a))
          );

          // Find latest stable and latest prerelease
          result.jsrLatest = data.latest || sortedVersions.find((v) =>
            !v.includes("-")
          ) || sortedVersions[0];

          // Find the latest prerelease
          result.jsrPrerelease = sortedVersions.find((v) => v.includes("-"));
        }
      }
    } catch (_) {
      // JSR fetch failed, ignore
    }
  }

  // Try NPM - works with both scoped and unscoped packages
  try {
    const npmUrl = `https://registry.npmjs.org/${moduleName}`;
    const response = await fetch(npmUrl);
    if (response.ok) {
      const data = await response.json();

      if (showAll) {
        const versions = Object.keys(data.versions || {}).reverse().slice(
          0,
          10,
        );
        console.log(
          `  NPM: ${versions.join(", ")}${
            versions.length >= 10 ? ", ..." : ""
          }`,
        );
      } else {
        // Use dist-tags for latest versions
        if (data["dist-tags"]) {
          result.npmLatest = data["dist-tags"]["latest"];
          result.npmNext = data["dist-tags"]["next"];
        }
      }
    }
  } catch (_) {
    // NPM fetch failed, ignore
  }

  // Get local version if it exists
  const localVersions = await getModuleVersions();
  result.local = localVersions.get(moduleName);

  if (showAll && result.local) {
    console.log(`  Local: ${result.local}`);
  }

  return result;
}

async function getLastReleaseTag(): Promise<string | null> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["describe", "--tags", "--abbrev=0"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      return new TextDecoder().decode(stdout).trim();
    }
  } catch (_) {
    // Ignore errors
  }
  return null;
}

async function getCommitsSinceTag(
  tag: string,
  path?: string,
): Promise<Commit[]> {
  const commits: Commit[] = [];
  try {
    const args = ["log", `${tag}..HEAD`, "--pretty=format:%H|%s|%an|%aI"];
    if (path) {
      args.push("--", path);
    }

    const cmd = new Deno.Command("git", {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const output = new TextDecoder().decode(stdout).trim();
      if (output) {
        const lines = output.split("\n");
        for (const line of lines) {
          const [hash, message, author, date] = line.split("|");
          commits.push({ hash, message, author, date });
        }
      }
    }
  } catch (_) {
    // Ignore errors
  }
  return commits;
}

function analyzeCommits(
  commits: Commit[],
): { suggestedBump: "major" | "minor" | "patch" | "none"; reason: string } {
  if (commits.length === 0) {
    return { suggestedBump: "none", reason: "No changes" };
  }

  let hasMajor = false;
  let hasMinor = false;
  let hasPatch = false;

  const changeTypes = new Set<string>();

  for (const commit of commits) {
    const message = commit.message;
    const lowerMessage = message.toLowerCase();

    // Check for breaking changes
    if (
      lowerMessage.includes("breaking change") ||
      lowerMessage.includes("breaking:") || message.startsWith("!:") ||
      /^[a-z]+!(\([^)]+\))?:/.test(message)
    ) {
      hasMajor = true;
      changeTypes.add("breaking");
    } // Check for features
    else if (/^feat(\([^)]+\))?:/i.test(message)) {
      hasMinor = true;
      changeTypes.add("features");
    } // Check for fixes
    else if (/^fix(\([^)]+\))?:/i.test(message)) {
      hasPatch = true;
      changeTypes.add("fixes");
    } // Check for performance improvements
    else if (/^perf(\([^)]+\))?:/i.test(message)) {
      hasPatch = true;
      changeTypes.add("performance");
    } // Check for refactoring
    else if (/^refactor(\([^)]+\))?:/i.test(message)) {
      hasPatch = true;
      changeTypes.add("refactoring");
    } // Check for other changes
    else if (
      /^(test|docs|style|build|ci)(\([^)]+\))?:/i.test(message) ||
      (/^chore(\([^)]+\))?:/i.test(message) && !lowerMessage.includes("deps"))
    ) {
      hasPatch = true;
      changeTypes.add("maintenance");
    }
  }

  // Build concise reason string
  let reason: string;
  if (changeTypes.has("breaking")) {
    reason = "Breaking changes";
  } else if (changeTypes.has("features")) {
    const others = Array.from(changeTypes).filter((t) => t !== "features");
    reason = others.length > 0
      ? `Features + ${others.join(", ")}`
      : "Features added";
  } else if (changeTypes.has("fixes")) {
    const others = Array.from(changeTypes).filter((t) => t !== "fixes");
    reason = others.length > 0 ? `Fixes + ${others.join(", ")}` : "Bug fixes";
  } else if (changeTypes.has("performance")) {
    reason = "Performance improvements";
  } else if (changeTypes.has("refactoring")) {
    reason = "Code refactoring";
  } else if (changeTypes.has("maintenance")) {
    reason = "Maintenance";
  } else {
    reason = "No significant changes";
  }

  if (hasMajor) {
    return { suggestedBump: "major", reason };
  } else if (hasMinor) {
    return { suggestedBump: "minor", reason };
  } else if (hasPatch) {
    return { suggestedBump: "patch", reason };
  } else {
    return { suggestedBump: "none", reason };
  }
}

async function suggestVersionBumps(
  showDetails: boolean = false,
  apply: boolean = false,
  prerelease: boolean = true,
): Promise<void> {
  const lastTag = await getLastReleaseTag();
  if (!lastTag) {
    console.error("Could not find the last release tag");
    return;
  }

  console.log(`Analyzing commits since last release: ${lastTag}\n`);

  const moduleVersions = await getModuleVersions();
  const suggestions: VersionSuggestion[] = [];

  // Get module directories - reuse logic from checkVersions/fixVersions
  const moduleDirs = new Map<string, string>();
  const allPaths = await getAllPackageAndDenoJsonPaths();

  for (const filePath of allPaths) {
    if (filePath.endsWith("package.json")) {
      const pkg = await readJsonFile<PackageJson>(filePath);
      if (pkg && pkg.name && pkg.name.startsWith(NATS_SCOPE)) {
        const lastSlash = filePath.lastIndexOf("/");
        const dir = lastSlash > 0 ? filePath.substring(0, lastSlash) : ".";
        moduleDirs.set(pkg.name, dir);
      }
    } else if (filePath.endsWith("deno.json")) {
      const denoConfig = await readJsonFile<DenoJson>(filePath);
      if (
        denoConfig && denoConfig.name && denoConfig.name.startsWith(NATS_SCOPE)
      ) {
        const lastSlash = filePath.lastIndexOf("/");
        const dir = lastSlash > 0 ? filePath.substring(0, lastSlash) : ".";
        moduleDirs.set(denoConfig.name, dir);
      }
    }
  }

  // Analyze each module
  for (const [moduleName, currentVersion] of moduleVersions) {
    const moduleDir = moduleDirs.get(moduleName);
    if (!moduleDir) {
      console.log(`Warning: No directory found for module ${moduleName}`);
      continue;
    }

    // Get commits for this module
    const commits = await getCommitsSinceTag(lastTag, moduleDir);

    // Also check for commits that mention the module in the message
    const allCommits = await getCommitsSinceTag(lastTag);
    const moduleShortName = moduleName.replace("@nats-io/", "");
    const relevantCommits = allCommits.filter((commit) => {
      const msg = commit.message.toLowerCase();
      return msg.includes(moduleShortName) ||
        msg.includes(`(${moduleShortName})`) ||
        msg.includes(`[${moduleShortName}]`);
    });

    // Combine and deduplicate commits
    const combinedCommits = [...commits];
    for (const commit of relevantCommits) {
      if (!combinedCommits.find((c) => c.hash === commit.hash)) {
        combinedCommits.push(commit);
      }
    }

    const analysis = analyzeCommits(combinedCommits);

    suggestions.push({
      module: moduleName,
      currentVersion,
      suggestedBump: analysis.suggestedBump,
      reason: analysis.reason,
      commits: combinedCommits,
    });
  }

  // Define module dependencies (same as in bumpVersion)
  const MODULE_DEPENDENCIES: Record<string, string[]> = {
    "@nats-io/nats-core": [],
    "@nats-io/transport-node": ["@nats-io/nats-core"],
    "@nats-io/transport-deno": ["@nats-io/nats-core"],
    "@nats-io/jetstream": ["@nats-io/nats-core"],
    "@nats-io/kv": ["@nats-io/nats-core", "@nats-io/jetstream"],
    "@nats-io/obj": ["@nats-io/nats-core", "@nats-io/jetstream"],
    "@nats-io/services": ["@nats-io/nats-core"],
  };

  // Propagate version bumps through dependencies
  for (const suggestion of suggestions) {
    if (
      suggestion.suggestedBump !== "none" &&
      suggestion.suggestedBump !== "patch"
    ) {
      // Find all modules that depend on this module
      for (const [depModule, deps] of Object.entries(MODULE_DEPENDENCIES)) {
        if (deps.includes(suggestion.module)) {
          // Find the suggestion for the dependent module
          const depSuggestion = suggestions.find((s) => s.module === depModule);
          if (depSuggestion) {
            // Store the original bump type for comparison
            const originalBump = depSuggestion.suggestedBump;
            const moduleShortName = suggestion.module.replace("@nats-io/", "");

            if (suggestion.suggestedBump === "major") {
              if (depSuggestion.suggestedBump !== "major") {
                depSuggestion.suggestedBump = "major";
              }
              // Always add dependency info to reason
              if (
                !depSuggestion.reason.includes(`${moduleShortName} major bump`)
              ) {
                if (depSuggestion.reason === "No changes") {
                  depSuggestion.reason =
                    `Dependency ${moduleShortName} requires major bump`;
                } else if (
                  originalBump === "patch" || originalBump === "none"
                ) {
                  // Module had patch-level changes but needs major due to dependency
                  depSuggestion.reason =
                    `${depSuggestion.reason} (patch→major due to ${moduleShortName})`;
                } else {
                  depSuggestion.reason = depSuggestion.reason +
                    ` + ${moduleShortName} major bump`;
                }
              }
            } else if (
              suggestion.suggestedBump === "minor" &&
              depSuggestion.suggestedBump !== "major"
            ) {
              if (depSuggestion.suggestedBump !== "minor") {
                depSuggestion.suggestedBump = "minor";
              }
              // Always add dependency info to reason
              if (
                !depSuggestion.reason.includes(`${moduleShortName} minor bump`)
              ) {
                if (depSuggestion.reason === "No changes") {
                  depSuggestion.reason =
                    `Dependency ${moduleShortName} requires minor bump`;
                } else if (
                  originalBump === "patch" || originalBump === "none"
                ) {
                  // Module had patch-level changes but needs minor due to dependency
                  depSuggestion.reason =
                    `${depSuggestion.reason} (patch→minor due to ${moduleShortName})`;
                } else {
                  depSuggestion.reason = depSuggestion.reason +
                    ` + ${moduleShortName} minor bump`;
                }
              }
            }
          }
        }
      }
    }
  }

  // Sort suggestions by module order
  const sortOrder = [
    "@nats-io/nats-core",
    "@nats-io/jetstream",
    "@nats-io/kv",
    "@nats-io/obj",
    "@nats-io/services",
    "@nats-io/transport-node",
    "@nats-io/transport-deno",
  ];

  suggestions.sort((a, b) => {
    const aIndex = sortOrder.indexOf(a.module);
    const bIndex = sortOrder.indexOf(b.module);
    if (aIndex !== -1 && bIndex !== -1) {
      return aIndex - bIndex;
    }
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return a.module.localeCompare(b.module);
  });

  // Prepare table data
  const tableData = suggestions.map((suggestion) => {
    let newVersion = suggestion.currentVersion;
    if (suggestion.suggestedBump !== "none") {
      const currentSemver = semver.parse(suggestion.currentVersion);

      // If prerelease is true and we're suggesting a version bump, create a prerelease version
      if (prerelease) {
        // When bumping to a new major/minor/patch from a prerelease, the prerelease counter resets to 0
        // For example: 3.0.3-1 with minor bump becomes 3.1.0-0, not 3.1.0-2
        if (currentSemver.prerelease && currentSemver.prerelease.length > 0) {
          // Already in prerelease, we need to:
          // 1. First bump to the target version (which removes prerelease)
          // 2. Then convert to prerelease which will add -0
          const releaseType = suggestion.suggestedBump as
            | "major"
            | "minor"
            | "patch";
          const baseVersion = semver.increment(currentSemver, releaseType);
          // Now add prerelease suffix, which will be -0
          newVersion = `${baseVersion!.major}.${baseVersion!.minor}.${
            baseVersion!.patch
          }-0`;
        } else {
          // Not a prerelease, use normal pre-bump
          const preBumpType = suggestion.suggestedBump === "major"
            ? "premajor"
            : suggestion.suggestedBump === "minor"
            ? "preminor"
            : "prepatch";
          const incremented = semver.increment(
            currentSemver,
            preBumpType as "premajor" | "preminor" | "prepatch",
          );
          newVersion = semver.format(incremented!);
        }
      } else {
        newVersion = semver.format(
          semver.increment(currentSemver, suggestion.suggestedBump)!,
        );
      }
    }

    return {
      module: suggestion.module,
      current: suggestion.currentVersion,
      suggested: suggestion.suggestedBump === "none"
        ? suggestion.currentVersion
        : newVersion,
      bump: suggestion.suggestedBump,
      commits: suggestion.commits.length,
      reason: suggestion.reason,
    };
  });

  // Display main table
  console.log("Version Bump Suggestions:");
  console.log("========================\n");
  console.table(tableData);

  // Show detailed commits for modules needing bumps (only if --show-details flag is set)
  if (showDetails) {
    const modulesNeedingBumps = suggestions.filter((s) =>
      s.suggestedBump !== "none"
    );
    if (modulesNeedingBumps.length > 0) {
      console.log("\nDetailed Changes:");
      console.log("-----------------");
      for (const suggestion of modulesNeedingBumps) {
        console.log(
          `\n${suggestion.module} (${suggestion.commits.length} commits):`,
        );
        const commitDetails = suggestion.commits.slice(0, 5).map((commit) => ({
          hash: commit.hash.substring(0, 7),
          message: commit.message.length > 60
            ? commit.message.substring(0, 57) + "..."
            : commit.message,
          author: commit.author,
        }));
        console.table(commitDetails);
        if (suggestion.commits.length > 5) {
          console.log(
            `  ... and ${suggestion.commits.length - 5} more commits`,
          );
        }
      }
    }
  }

  // Apply the suggested bumps if --apply flag is set
  if (apply) {
    const modulesToBump = suggestions.filter((s) => s.suggestedBump !== "none");
    if (modulesToBump.length === 0) {
      console.log("\nNo version bumps needed.");
      return;
    }

    console.log("\nApplying version bumps...");
    console.log("========================\n");

    // Sort modules by dependency order to bump dependencies first
    const sortedModules = [...modulesToBump].sort((a, b) => {
      const aIndex = sortOrder.indexOf(a.module);
      const bIndex = sortOrder.indexOf(b.module);
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;
      return a.module.localeCompare(b.module);
    });

    // Apply bumps to each module
    // Note: We pass isDependent=true to prevent automatic propagation since we're handling all modules
    for (const suggestion of sortedModules) {
      // If prerelease is true, convert bump type to pre-version
      let bumpType: string = suggestion.suggestedBump;
      if (prerelease && suggestion.suggestedBump !== "none") {
        if (suggestion.suggestedBump === "major") bumpType = "premajor";
        else if (suggestion.suggestedBump === "minor") bumpType = "preminor";
        else if (suggestion.suggestedBump === "patch") bumpType = "prepatch";
      }

      console.log(`Bumping ${suggestion.module} (${bumpType})...`);
      await bumpVersion(suggestion.module, bumpType, undefined, true);
      console.log("");
    }

    // Run a version check to ensure everything is consistent
    console.log("\nVerifying version consistency...");
    const hasInconsistencies = await checkVersions();
    if (hasInconsistencies) {
      console.error(
        "\nWarning: Version inconsistencies detected after bumping. Running fix...",
      );
      await fixVersions();
      // Check again
      const stillHasInconsistencies = await checkVersions();
      if (stillHasInconsistencies) {
        console.error("\nError: Version inconsistencies persist after fix.");
        Deno.exit(1);
      }
    } else {
      console.log("\nAll versions bumped successfully!");
    }
  }
}

const args = Deno.args;
const command = args[0];

if (command === "check") {
  const hasInconsistencies = await checkVersions();
  if (hasInconsistencies) {
    Deno.exit(1);
  }
} else if (command === "fix") {
  await fixVersions();
} else if (command === "bump") {
  const moduleName = args[1];
  const bumpType = args[2];

  // Check for --preid flag
  const preidIndex = args.indexOf("--preid");
  const preid = preidIndex !== -1 && args[preidIndex + 1]
    ? args[preidIndex + 1]
    : undefined;

  const validBumpTypes = [
    "major",
    "minor",
    "patch",
    "premajor",
    "preminor",
    "prepatch",
    "prerelease",
    "release",
  ];
  if (!moduleName || !bumpType || !validBumpTypes.includes(bumpType)) {
    console.error(
      "Usage: deno run -A bin/version_manager.ts bump <module_name|all> <version_type> [--preid <identifier>]",
    );
    console.error(
      "  module_name: specific module name or 'all' to bump all modules",
    );
    console.error(
      "  version_type: major | minor | patch | premajor | preminor | prepatch | prerelease | release",
    );
    console.error(
      "  --preid: Identifier for prerelease versions (e.g., alpha, beta, rc)",
    );
    Deno.exit(1);
  }

  if (moduleName === "all") {
    // Bump all modules
    const allFiles = await getAllPackageAndDenoJsonPaths();
    const modules: string[] = [];

    // Collect all module names
    for (const filePath of allFiles) {
      if (filePath.endsWith("package.json")) {
        const pkg = await readJsonFile<PackageJson>(filePath);
        if (pkg && pkg.name && pkg.name.startsWith(NATS_SCOPE)) {
          modules.push(pkg.name);
        }
      } else if (filePath.endsWith("deno.json")) {
        const denoConfig = await readJsonFile<DenoJson>(filePath);
        if (
          denoConfig && denoConfig.name &&
          denoConfig.name.startsWith(NATS_SCOPE)
        ) {
          modules.push(denoConfig.name);
        }
      }
    }

    // Remove duplicates and sort
    const uniqueModules = [...new Set(modules)].sort();

    console.log(
      `Bumping all modules (${uniqueModules.length} total) to ${bumpType}...\n`,
    );

    // Bump each module
    for (const module of uniqueModules) {
      console.log(`Bumping ${module}...`);
      await bumpVersion(module, bumpType, preid, true);
      console.log("");
    }

    // Run version check and fix if needed
    console.log("\nVerifying version consistency...");
    const hasInconsistencies = await checkVersions();
    if (hasInconsistencies) {
      console.error("\nFixing version inconsistencies...");
      await fixVersions();
    }
    console.log("\nAll modules bumped successfully!");
  } else {
    await bumpVersion(moduleName, bumpType, preid);
  }
} else if (command === "ls" || command === "list") {
  // Check for --all flag
  const showAll = args.includes("--all");
  // Get module name (skip --all if it exists)
  const moduleName = args.find((arg) =>
    arg !== "ls" && arg !== "list" && arg !== "--all"
  );
  await fetchRemoteVersions(moduleName, showAll);
} else if (command === "suggest") {
  const showDetails = args.includes("--show-details");
  const apply = args.includes("--apply");
  const noPrerelease = args.includes("--no-prerelease");
  await suggestVersionBumps(showDetails, apply, !noPrerelease);
} else {
  console.log("Usage:");
  console.log("  deno run -A bin/version_manager.ts check");
  console.log("  deno run -A bin/version_manager.ts fix");
  console.log(
    "  deno run -A bin/version_manager.ts bump <module_name|all> <version_type> [--preid <identifier>]",
  );
  console.log(
    "    module_name: specific module name or 'all' to bump all modules",
  );
  console.log(
    "    version_type: major | minor | patch | premajor | preminor | prepatch | prerelease | release",
  );
  console.log(
    "    --preid: Identifier for prerelease versions (e.g., alpha, beta, rc)",
  );
  console.log(
    "  deno run -A bin/version_manager.ts ls [module_name] [--all]",
  );
  console.log(
    "  deno run -A bin/version_manager.ts suggest [--show-details] [--apply] [--no-prerelease]",
  );
  console.log(
    "    --show-details: Show detailed commit information for modules needing bumps",
  );
  console.log("    --apply: Apply all suggested version bumps automatically");
  console.log(
    "    --no-prerelease: Generate stable versions instead of prerelease versions",
  );
  Deno.exit(1);
}
