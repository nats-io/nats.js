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
          console.warn(`Warning: ${pkg.name} has different versions in package.json (${pkg.version}) and deno.json (${existingVersion})`);
          // Use the higher version as the expected one
          const comparison = semver.compare(semver.parse(pkg.version), semver.parse(existingVersion));
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
          console.warn(`Warning: ${denoConfig.name} has different versions in package.json (${existingVersion}) and deno.json (${denoConfig.version})`);
          // Use the higher version as the expected one
          const comparison = semver.compare(semver.parse(denoConfig.version), semver.parse(existingVersion));
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
  const moduleOwnVersions = new Map<string, { packageVersion?: string; denoVersion?: string }>();
  
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
      if (denoConfig && denoConfig.name && denoConfig.version && denoConfig.name.startsWith(NATS_SCOPE)) {
        const existing = moduleOwnVersions.get(denoConfig.name) || {};
        existing.denoVersion = denoConfig.version;
        moduleOwnVersions.set(denoConfig.name, existing);
      }
    }
  }

  // Check for mismatches in module's own files
  for (const [moduleName, versions] of moduleOwnVersions) {
    if (versions.packageVersion && versions.denoVersion && versions.packageVersion !== versions.denoVersion) {
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
      if (denoConfig && denoConfig.name && denoConfig.version && denoConfig.name.startsWith(NATS_SCOPE)) {
        const expectedVersion = moduleVersions.get(denoConfig.name);
        if (expectedVersion && denoConfig.version !== expectedVersion) {
          denoConfig.version = expectedVersion;
          await writeJsonFile(filePath, denoConfig);
          console.log(`Fixed ${filePath}: ${denoConfig.name} own version to ${expectedVersion}`);
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
  console.log(`Fixed ${fixedCount} version inconsistencies.`);
}

async function bumpVersion(
  moduleName: string,
  bumpType: "major" | "minor" | "patch" | "prerelease",
) {
  const allFiles = await getAllPackageAndDenoJsonPaths();
  let originalVersion: string | undefined;
  let newVersion: string | undefined;

  // Find ALL files (package.json and deno.json) for the module and bump their versions
  const moduleFiles: string[] = [];
  for (const filePath of allFiles) {
    if (filePath.endsWith("package.json") || filePath.endsWith("deno.json")) {
      let content: PackageJson | DenoJson | null = null;
      if (filePath.endsWith("package.json")) {
        content = await readJsonFile<PackageJson>(filePath);
      } else {
        content = await readJsonFile<DenoJson>(filePath);
      }

      if (content && content.name === moduleName && content.version) {
        moduleFiles.push(filePath);
        if (!originalVersion) {
          originalVersion = content.version;
          const parsedVersion = semver.parse(originalVersion);
          const bumped = semver.increment(parsedVersion, bumpType);
          if (!bumped) {
            console.error(
              `Failed to bump version for ${moduleName} with type ${bumpType}`,
            );
            return;
          }
          newVersion = semver.format(bumped);
        }
      }
    }
  }

  // Update all module files with the new version
  for (const filePath of moduleFiles) {
    let content: PackageJson | DenoJson | null = null;
    if (filePath.endsWith("package.json")) {
      content = await readJsonFile<PackageJson>(filePath);
    } else {
      content = await readJsonFile<DenoJson>(filePath);
    }

    if (content && content.version && newVersion) {
      content.version = newVersion;
      await writeJsonFile(filePath, content);
      console.log(
        `Bumped ${moduleName} from ${originalVersion} to ${newVersion} in ${filePath}`,
      );
    }
  }

  if (!newVersion) {
    console.error(`Could not find module ${moduleName} to bump its version.`);
    return;
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
          const escapedModuleName = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const match = importString.match(
            new RegExp(`(jsr:${escapedModuleName})@([\\d\\.-]+)`),
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
          const latestPrerelease = sortedVersions.find((v) => v.includes("-"));
          result.jsrPrerelease = latestPrerelease;
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

async function getCommitsSinceTag(tag: string, path?: string): Promise<Commit[]> {
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

function analyzeCommits(commits: Commit[]): { suggestedBump: "major" | "minor" | "patch" | "none"; reason: string } {
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
    if (lowerMessage.includes("breaking change") || lowerMessage.includes("breaking:") || message.startsWith("!:") || /^[a-z]+!(\([^)]+\))?:/.test(message)) {
      hasMajor = true;
      changeTypes.add("breaking");
    }
    // Check for features
    else if (/^feat(\([^)]+\))?:/i.test(message)) {
      hasMinor = true;
      changeTypes.add("features");
    }
    // Check for fixes
    else if (/^fix(\([^)]+\))?:/i.test(message)) {
      hasPatch = true;
      changeTypes.add("fixes");
    }
    // Check for performance improvements
    else if (/^perf(\([^)]+\))?:/i.test(message)) {
      hasPatch = true;
      changeTypes.add("performance");
    }
    // Check for refactoring
    else if (/^refactor(\([^)]+\))?:/i.test(message)) {
      hasPatch = true;
      changeTypes.add("refactoring");
    }
    // Check for other changes
    else if (
      /^(test|docs|style|build|ci)(\([^)]+\))?:/i.test(message) ||
      (/^chore(\([^)]+\))?:/i.test(message) && !lowerMessage.includes("deps"))
    ) {
      hasPatch = true;
      changeTypes.add("maintenance");
    }
  }

  // Build concise reason string
  let reason = "";
  if (changeTypes.has("breaking")) {
    reason = "Breaking changes";
  } else if (changeTypes.has("features")) {
    const others = Array.from(changeTypes).filter(t => t !== "features");
    reason = others.length > 0 ? `Features + ${others.join(", ")}` : "Features added";
  } else if (changeTypes.has("fixes")) {
    const others = Array.from(changeTypes).filter(t => t !== "fixes");
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

async function suggestVersionBumps(): Promise<void> {
  const lastTag = await getLastReleaseTag();
  if (!lastTag) {
    console.error("Could not find the last release tag");
    return;
  }

  console.log(`Analyzing commits since last release: ${lastTag}\n`);

  const moduleVersions = await getModuleVersions();
  const suggestions: VersionSuggestion[] = [];

  // Get module directories
  const moduleDirs = new Map<string, string>();
  for await (const dirEntry of Deno.readDir(".")) {
    if (dirEntry.isDirectory && !dirEntry.name.startsWith(".")) {
      const packageJsonPath = `${dirEntry.name}/package.json`;
      try {
        const pkg = await readJsonFile<PackageJson>(packageJsonPath);
        if (pkg && pkg.name && pkg.name.startsWith(NATS_SCOPE)) {
          moduleDirs.set(pkg.name, dirEntry.name);
        }
      } catch (_) {
        // Ignore
      }
    }
  }

  // Analyze each module
  for (const [moduleName, currentVersion] of moduleVersions) {
    const moduleDir = moduleDirs.get(moduleName);
    if (!moduleDir) continue;

    // Get commits for this module
    const commits = await getCommitsSinceTag(lastTag, moduleDir);
    
    // Also check for commits that mention the module in the message
    const allCommits = await getCommitsSinceTag(lastTag);
    const moduleShortName = moduleName.replace("@nats-io/", "");
    const relevantCommits = allCommits.filter(commit => {
      const msg = commit.message.toLowerCase();
      return msg.includes(moduleShortName) || 
             msg.includes(`(${moduleShortName})`) ||
             msg.includes(`[${moduleShortName}]`);
    });

    // Combine and deduplicate commits
    const combinedCommits = [...commits];
    for (const commit of relevantCommits) {
      if (!combinedCommits.find(c => c.hash === commit.hash)) {
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
  const tableData = suggestions.map(suggestion => {
    let newVersion = suggestion.currentVersion;
    if (suggestion.suggestedBump !== "none") {
      const currentSemver = semver.parse(suggestion.currentVersion);
      newVersion = semver.format(semver.increment(currentSemver, suggestion.suggestedBump)!);
    }
    
    return {
      module: suggestion.module,
      current: suggestion.currentVersion,
      suggested: suggestion.suggestedBump === "none" ? suggestion.currentVersion : newVersion,
      bump: suggestion.suggestedBump,
      commits: suggestion.commits.length,
      reason: suggestion.reason.length > 50 ? suggestion.reason.substring(0, 47) + "..." : suggestion.reason,
    };
  });

  // Display main table
  console.log("Version Bump Suggestions:");
  console.log("========================\n");
  console.table(tableData);

  // Show detailed commits for modules needing bumps
  const modulesNeedingBumps = suggestions.filter(s => s.suggestedBump !== "none");
  if (modulesNeedingBumps.length > 0) {
    console.log("\nDetailed Changes:");
    console.log("-----------------");
    for (const suggestion of modulesNeedingBumps) {
      console.log(`\n${suggestion.module} (${suggestion.commits.length} commits):`);
      const commitDetails = suggestion.commits.slice(0, 5).map(commit => ({
        hash: commit.hash.substring(0, 7),
        message: commit.message.length > 60 ? commit.message.substring(0, 57) + "..." : commit.message,
        author: commit.author,
      }));
      console.table(commitDetails);
      if (suggestion.commits.length > 5) {
        console.log(`  ... and ${suggestion.commits.length - 5} more commits`);
      }
    }
  }

  // Show suggested versions summary
  console.log("\nSuggested Versions:");
  console.log("-------------------");
  const versionSummary = suggestions.map(s => {
    let newVersion = s.currentVersion;
    if (s.suggestedBump !== "none") {
      const currentSemver = semver.parse(s.currentVersion);
      newVersion = semver.format(semver.increment(currentSemver, s.suggestedBump)!);
    }
    return {
      module: s.module,
      version: newVersion,
      action: s.suggestedBump === "none" ? "keep current" : `bump ${s.suggestedBump}`,
    };
  });
  console.table(versionSummary);
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
  const bumpType = args[2] as "major" | "minor" | "patch" | "prerelease";
  if (!moduleName || !bumpType) {
    console.error(
      "Usage: deno run -A bin/version_manager.ts bump <module_name> <major|minor|patch|prerelease>",
    );
    Deno.exit(1);
  }
  await bumpVersion(moduleName, bumpType);
} else if (command === "ls" || command === "list") {
  // Check for --all flag
  const showAll = args.includes("--all");
  // Get module name (skip --all if it exists)
  const moduleName = args.find((arg) => arg !== "ls" && arg !== "list" && arg !== "--all");
  await fetchRemoteVersions(moduleName, showAll);
} else if (command === "suggest") {
  await suggestVersionBumps();
} else {
  console.log("Usage:");
  console.log("  deno run -A bin/version_manager.ts check");
  console.log("  deno run -A bin/version_manager.ts fix");
  console.log(
    "  deno run -A bin/version_manager.ts bump <module_name> <major|minor|patch|prerelease>",
  );
  console.log(
    "  deno run -A bin/version_manager.ts ls [module_name] [--all]",
  );
  console.log("  deno run -A bin/version_manager.ts suggest");
  Deno.exit(1);
}
