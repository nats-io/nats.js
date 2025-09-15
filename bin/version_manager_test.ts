import { assertEquals } from "@std/assert";
import { parse } from "@std/jsonc/parse";

const testDir = await Deno.makeTempDir({ prefix: "version_manager_test_" });

async function createTestFile(path: string, content: unknown): Promise<void> {
  const fullPath = `${testDir}/${path}`;
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  if (typeof content === "string") {
    await Deno.writeTextFile(fullPath, content);
    return;
  } else {
    await Deno.writeTextFile(fullPath, JSON.stringify(content, null, 2) + "\n");
  }
}

async function readTestFile(path: string): Promise<unknown> {
  const fullPath = `${testDir}/${path}`;
  const content = await Deno.readTextFile(fullPath);
  return parse(content);
}

async function runVersionManager(
  args: string[],
): Promise<{ success: boolean; output: string }> {
  // Get the absolute path to version_manager.ts
  const scriptPath = new URL("version_manager.ts", import.meta.url).pathname;

  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", scriptPath, ...args],
    cwd: testDir,
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await cmd.output();
  const output = new TextDecoder().decode(stdout) +
    new TextDecoder().decode(stderr);
  return { success: code === 0, output };
}

Deno.test("version_manager - check detects inconsistencies manifests", async () => {
  // Create test files with inconsistencies
  await createTestFile("core/package.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });

  await createTestFile("core/deno.json", {
    name: "@nats-io/nats-core",
    version: "0.9.0", // Different version
  });

  const result = await runVersionManager(["check"]);
  assertEquals(result.success, false); // Should exit with error when inconsistencies found
  assertEquals(result.output.includes("Found"), true);
  assertEquals(result.output.includes("version inconsistencies"), true);
});

Deno.test("version_manager - check detects inconsistencies src", async () => {
  // Create test files with inconsistencies
  await createTestFile("core/package.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });

  await createTestFile("core/deno.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0", // Different version
  });

  await createTestFile(
    "core/src/version.ts",
    "// This file is generated - do not edit\n" +
      'export const version = "3.0.3-1";\n',
  );

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

  await createTestFile(
    "core/src/version.ts",
    "// This file is generated - do not edit\n" +
      'export const version = "1.0.0";\n',
  );

  const result = await runVersionManager(["check"]);
  assertEquals(result.success, true);
  assertEquals(
    result.output.includes("All internal NATS module versions are consistent"),
    true,
  );
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
  assertEquals(
    (consumerPkg as { dependencies: Record<string, string> })
      .dependencies["@nats-io/nats-core"],
    "1.0.0",
  );

  const consumerDeno = await readTestFile("consumer/deno.json");
  assertEquals(
    (consumerDeno as { imports: Record<string, string> })
      .imports["@nats-io/nats-core"],
    "jsr:@nats-io/nats-core@1.0.0",
  );
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

  const consumerPkg = await readTestFile("consumer/package.json") as {
    dependencies: Record<string, string>;
  };
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
  result = await runVersionManager([
    "bump",
    "@nats-io/nats-core",
    "prerelease",
  ]);
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
  assertEquals(
    (consumerDeno as { imports: Record<string, string> }).imports["core"],
    "jsr:@nats-io/nats-core@1.0.0",
  );
  assertEquals(
    (consumerDeno as { imports: Record<string, string> }).imports["other"],
    "jsr:@std/testing@1.0.0",
  ); // Unchanged
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
  const result = await runVersionManager([
    "bump",
    "@nats-io/nats-core",
    "patch",
  ]);
  assertEquals(result.success, true);

  const consumerDeno = await readTestFile("consumer/deno.json");
  assertEquals(
    (consumerDeno as { imports: Record<string, string> }).imports["core"],
    "jsr:@nats-io/nats-core@1.0.1",
  );
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
  assertEquals(
    (consumerPkg as { dependencies: Record<string, string> })
      .dependencies["@nats-io/nats-core"],
    "2.0.0",
  );
});

Deno.test("version_manager - bump propagates to dependent modules", async () => {
  // Clean up and create files
  await Deno.remove(testDir, { recursive: true });
  await Deno.mkdir(testDir);

  // Create core module
  await createTestFile("core/package.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });

  await createTestFile("core/deno.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0",
  });

  // Create services module that depends on core
  await createTestFile("services/package.json", {
    name: "@nats-io/services",
    version: "1.0.0",
    dependencies: {
      "@nats-io/nats-core": "1.0.0",
    },
  });

  await createTestFile("services/deno.json", {
    name: "@nats-io/services",
    version: "1.0.0",
  });

  // Create jetstream module that depends on core
  await createTestFile("jetstream/package.json", {
    name: "@nats-io/jetstream",
    version: "1.0.0",
    dependencies: {
      "@nats-io/nats-core": "1.0.0",
    },
  });

  await createTestFile("jetstream/deno.json", {
    name: "@nats-io/jetstream",
    version: "1.0.0",
  });

  // Create kv module that depends on both core and jetstream
  await createTestFile("kv/package.json", {
    name: "@nats-io/kv",
    version: "1.0.0",
    dependencies: {
      "@nats-io/nats-core": "1.0.0",
      "@nats-io/jetstream": "1.0.0",
    },
  });

  await createTestFile("kv/deno.json", {
    name: "@nats-io/kv",
    version: "1.0.0",
  });

  // Bump core with minor version - should propagate to all dependents
  const result = await runVersionManager([
    "bump",
    "@nats-io/nats-core",
    "minor",
  ]);
  assertEquals(result.success, true);

  // Check that core was bumped to 1.1.0
  const corePkg = await readTestFile("core/package.json") as {
    version: string;
  };
  assertEquals(corePkg.version, "1.1.0");

  // Check that services was also bumped (depends on core)
  const servicesPkg = await readTestFile("services/package.json") as {
    version: string;
    dependencies: Record<string, string>;
  };
  assertEquals(
    servicesPkg.version,
    "1.1.0",
    "services should be bumped to 1.1.0 due to core dependency",
  );
  assertEquals(servicesPkg.dependencies["@nats-io/nats-core"], "1.1.0");

  // Check that jetstream was also bumped (depends on core)
  const jetstreamPkg = await readTestFile("jetstream/package.json") as {
    version: string;
    dependencies: Record<string, string>;
  };
  assertEquals(
    jetstreamPkg.version,
    "1.1.0",
    "jetstream should be bumped to 1.1.0 due to core dependency",
  );
  assertEquals(jetstreamPkg.dependencies["@nats-io/nats-core"], "1.1.0");

  // Check that kv was also bumped (depends on both core and jetstream)
  const kvPkg = await readTestFile("kv/package.json") as {
    version: string;
    dependencies: Record<string, string>;
  };
  assertEquals(
    kvPkg.version,
    "1.1.0",
    "kv should be bumped to 1.1.0 due to dependencies",
  );
  assertEquals(kvPkg.dependencies["@nats-io/nats-core"], "1.1.0");
  assertEquals(kvPkg.dependencies["@nats-io/jetstream"], "1.1.0");

  // Now test major version bump propagation
  const majorResult = await runVersionManager([
    "bump",
    "@nats-io/nats-core",
    "major",
  ]);
  assertEquals(majorResult.success, true);

  // Check that all modules got major bumps
  const corePkg2 = await readTestFile("core/package.json") as {
    version: string;
  };
  assertEquals(corePkg2.version, "2.0.0");

  const servicesPkg2 = await readTestFile("services/package.json") as {
    version: string;
  };
  assertEquals(
    servicesPkg2.version,
    "2.0.0",
    "services should have major bump due to core major bump",
  );

  const jetstreamPkg2 = await readTestFile("jetstream/package.json") as {
    version: string;
  };
  assertEquals(
    jetstreamPkg2.version,
    "2.0.0",
    "jetstream should have major bump due to core major bump",
  );

  const kvPkg2 = await readTestFile("kv/package.json") as { version: string };
  assertEquals(
    kvPkg2.version,
    "2.0.0",
    "kv should have major bump due to dependencies",
  );
});

Deno.test("version_manager - release bump removes prerelease qualifier", async () => {
  // Clean up and create files
  await Deno.remove(testDir, { recursive: true });
  await Deno.mkdir(testDir);

  // Create core module with prerelease version
  await createTestFile("core/package.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0-beta.3",
  });

  await createTestFile("core/deno.json", {
    name: "@nats-io/nats-core",
    version: "1.0.0-beta.3",
  });

  // Test release bump
  const result = await runVersionManager([
    "bump",
    "@nats-io/nats-core",
    "release",
  ]);
  assertEquals(result.success, true);
  assertEquals(
    result.output.includes(
      "Released @nats-io/nats-core from 1.0.0-beta.3 to 1.0.0",
    ),
    true,
  );

  // Verify version was updated
  const corePkg = await readTestFile("core/package.json") as {
    version: string;
  };
  assertEquals(corePkg.version, "1.0.0");

  const coreDeno = await readTestFile("core/deno.json") as { version: string };
  assertEquals(coreDeno.version, "1.0.0");

  // Test release on already released version
  const result2 = await runVersionManager([
    "bump",
    "@nats-io/nats-core",
    "release",
  ]);
  assertEquals(result2.success, true);
  assertEquals(result2.output.includes("is already a release version"), true);
});

// Cleanup after all tests
Deno.test("cleanup", async () => {
  await Deno.remove(testDir, { recursive: true });
});
