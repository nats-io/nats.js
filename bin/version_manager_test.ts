import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parse } from "https://deno.land/std@0.224.0/jsonc/parse.ts";

const testDir = await Deno.makeTempDir({ prefix: "version_manager_test_" });

async function createTestFile(path: string, content: object): Promise<void> {
  const fullPath = `${testDir}/${path}`;
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(fullPath, JSON.stringify(content, null, 2) + "\n");
}

async function readTestFile(path: string): Promise<unknown> {
  const fullPath = `${testDir}/${path}`;
  const content = await Deno.readTextFile(fullPath);
  return parse(content);
}

async function runVersionManager(args: string[]): Promise<{ success: boolean; output: string }> {
  // Get the absolute path to version_manager.ts
  const scriptPath = new URL("version_manager.ts", import.meta.url).pathname;
  
  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", scriptPath, ...args],
    cwd: testDir,
    stdout: "piped",
    stderr: "piped",
  });
  
  const { code, stdout, stderr } = await cmd.output();
  const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
  return { success: code === 0, output };
}

Deno.test("version_manager - check detects inconsistencies", async () => {
  // Create test files with inconsistencies
  await createTestFile("core/package.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });
  
  await createTestFile("core/deno.json", {
    name: "@nats-io/nats-core",
    version: "0.9.0", // Different version
  });
  
  await createTestFile("consumer/package.json", {
    name: "@nats-io/consumer",
    version: "1.0.0",
    dependencies: {
      "@nats-io/nats-core": "0.8.0", // Wrong version
    },
  });
  
  const result = await runVersionManager(["check"]);
  assertEquals(result.success, false); // Should exit with error when inconsistencies found
  assertEquals(result.output.includes("Found"), true);
  assertEquals(result.output.includes("version inconsistencies"), true);
});

Deno.test("version_manager - check returns success when consistent", async () => {
  // Clean up previous test files
  await Deno.remove(testDir, { recursive: true });
  await Deno.mkdir(testDir);
  
  // Create consistent test files
  await createTestFile("core/package.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });
  
  await createTestFile("core/deno.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });
  
  await createTestFile("consumer/package.json", {
    name: "@nats-io/consumer",
    version: "1.0.0",
    dependencies: {
      "@nats-io/nats-core": "1.0.0",
    },
  });
  
  const result = await runVersionManager(["check"]);
  assertEquals(result.success, true);
  assertEquals(result.output.includes("All internal NATS module versions are consistent"), true);
});

Deno.test("version_manager - fix updates inconsistent versions", async () => {
  // Clean up and create inconsistent files
  await Deno.remove(testDir, { recursive: true });
  await Deno.mkdir(testDir);
  
  await createTestFile("core/package.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });
  
  await createTestFile("core/deno.json", {
    name: "@nats-io/nats-core",
    version: "0.9.0",
  });
  
  await createTestFile("consumer/package.json", {
    name: "@nats-io/consumer",
    version: "1.0.0",
    dependencies: {
      "@nats-io/nats-core": "0.8.0",
    },
  });
  
  await createTestFile("consumer/deno.json", {
    name: "@nats-io/consumer",
    version: "1.0.0",
    imports: {
      "@nats-io/nats-core": "jsr:@nats-io/nats-core@0.8.0",
    },
  });
  
  // Run fix
  const fixResult = await runVersionManager(["fix"]);
  assertEquals(fixResult.success, true);
  assertEquals(fixResult.output.includes("Fixed"), true);
  
  // Verify files were updated
  const coreDenoJson = await readTestFile("core/deno.json");
  assertEquals((coreDenoJson as { version: string }).version, "1.0.0");
  
  const consumerPkg = await readTestFile("consumer/package.json");
  assertEquals((consumerPkg as { dependencies: Record<string, string> }).dependencies["@nats-io/nats-core"], "1.0.0");
  
  const consumerDeno = await readTestFile("consumer/deno.json");
  assertEquals((consumerDeno as { imports: Record<string, string> }).imports["@nats-io/nats-core"], "jsr:@nats-io/nats-core@1.0.0");
});

Deno.test("version_manager - bump updates version correctly", async () => {
  // Clean up and create files
  await Deno.remove(testDir, { recursive: true });
  await Deno.mkdir(testDir);
  
  await createTestFile("core/package.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });
  
  await createTestFile("core/deno.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });
  
  await createTestFile("consumer/package.json", {
    name: "@nats-io/consumer",
    version: "1.0.0",
    dependencies: {
      "@nats-io/nats-core": "1.0.0",
    },
  });
  
  // Test patch bump
  let result = await runVersionManager(["bump", "@nats-io/nats-core", "patch"]);
  assertEquals(result.success, true);
  
  let corePkg = await readTestFile("core/package.json") as { version: string };
  assertEquals(corePkg.version, "1.0.1");
  
  const coreDeno = await readTestFile("core/deno.json") as { version: string };
  assertEquals(coreDeno.version, "1.0.1");
  
  const consumerPkg = await readTestFile("consumer/package.json") as { dependencies: Record<string, string> };
  assertEquals(consumerPkg.dependencies["@nats-io/nats-core"], "1.0.1");
  
  // Test minor bump
  result = await runVersionManager(["bump", "@nats-io/nats-core", "minor"]);
  assertEquals(result.success, true);
  
  corePkg = await readTestFile("core/package.json") as { version: string };
  assertEquals(corePkg.version, "1.1.0");
  
  // Test major bump
  result = await runVersionManager(["bump", "@nats-io/nats-core", "major"]);
  assertEquals(result.success, true);
  
  corePkg = await readTestFile("core/package.json") as { version: string };
  assertEquals(corePkg.version, "2.0.0");
  
  // Test prerelease bump
  result = await runVersionManager(["bump", "@nats-io/nats-core", "prerelease"]);
  assertEquals(result.success, true);
  
  corePkg = await readTestFile("core/package.json") as { version: string };
  assertEquals(corePkg.version, "2.0.1-0");
});

Deno.test("version_manager - handles JSR imports correctly", async () => {
  // Clean up and create files
  await Deno.remove(testDir, { recursive: true });
  await Deno.mkdir(testDir);
  
  await createTestFile("core/deno.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });
  
  await createTestFile("consumer/deno.json", {
    name: "@nats-io/consumer",
    version: "1.0.0",
    imports: {
      "core": "jsr:@nats-io/nats-core@0.9.0",
      "other": "jsr:@std/testing@1.0.0", // Should not be touched
    },
  });
  
  // Run fix
  await runVersionManager(["fix"]);
  
  const consumerDeno = await readTestFile("consumer/deno.json");
  assertEquals((consumerDeno as { imports: Record<string, string> }).imports["core"], "jsr:@nats-io/nats-core@1.0.0");
  assertEquals((consumerDeno as { imports: Record<string, string> }).imports["other"], "jsr:@std/testing@1.0.0"); // Unchanged
});

Deno.test("version_manager - handles modules with special characters", async () => {
  // Clean up and create files
  await Deno.remove(testDir, { recursive: true });
  await Deno.mkdir(testDir);
  
  await createTestFile("core/package.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });
  
  await createTestFile("consumer/deno.json", {
    name: "@nats-io/consumer",
    version: "1.0.0",
    imports: {
      "core": "jsr:@nats-io/nats-core@1.0.0",
    },
  });
  
  // Bump should handle the special characters in module name
  const result = await runVersionManager(["bump", "@nats-io/nats-core", "patch"]);
  assertEquals(result.success, true);
  
  const consumerDeno = await readTestFile("consumer/deno.json");
  assertEquals((consumerDeno as { imports: Record<string, string> }).imports["core"], "jsr:@nats-io/nats-core@1.0.1");
});

Deno.test("version_manager - detects own version mismatches", async () => {
  // Clean up and create files
  await Deno.remove(testDir, { recursive: true });
  await Deno.mkdir(testDir);
  
  await createTestFile("core/package.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });
  
  await createTestFile("core/deno.json", {
    name: "@nats-io/nats-core",
    version: "0.9.0", // Mismatch
  });
  
  const result = await runVersionManager(["check"]);
  assertEquals(result.success, false);
  assertEquals(result.output.includes("(own version)"), true);
});

Deno.test("version_manager - uses higher version when mismatch detected", async () => {
  // Clean up and create files
  await Deno.remove(testDir, { recursive: true });
  await Deno.mkdir(testDir);
  
  await createTestFile("core/package.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });
  
  await createTestFile("core/deno.json", {
    name: "@nats-io/nats-core",
    version: "2.0.0", // Higher version
  });
  
  await createTestFile("consumer/package.json", {
    name: "@nats-io/consumer",
    version: "1.0.0",
    dependencies: {
      "@nats-io/nats-core": "1.0.0",
    },
  });
  
  // Fix should use the higher version (2.0.0)
  await runVersionManager(["fix"]);
  
  const consumerPkg = await readTestFile("consumer/package.json");
  assertEquals((consumerPkg as { dependencies: Record<string, string> }).dependencies["@nats-io/nats-core"], "2.0.0");
});

// Cleanup after all tests
Deno.test("cleanup", async () => {
  await Deno.remove(testDir, { recursive: true });
});