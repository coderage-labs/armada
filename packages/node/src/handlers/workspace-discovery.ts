/**
 * Workspace discovery — auto-detects project stacks and reads armada.json config.
 *
 * Runs inside a container by executing shell commands via containerExec.
 * Returns a RepoDiscovery with optional rootConfig (from armada.json) and
 * a list of detected packages.
 */

import type { BuildConfig, DetectedPackage, RepoDiscovery } from '@coderage-labs/armada-shared';

/** Run a shell command inside a container and return stdout + stderr as a string. */
type ContainerExecFn = (cmd: string[]) => Promise<{ exitCode: number; output: string }>;

/** Parse armada.json content into a BuildConfig. Returns undefined if invalid. */
function parseArmadaJson(content: string): BuildConfig | undefined {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const cfg: BuildConfig = {};
    if (typeof parsed.install === 'string') cfg.install = parsed.install;
    if (typeof parsed.verify === 'string') cfg.verify = parsed.verify;
    if (typeof parsed.test === 'string') cfg.test = parsed.test;
    if (typeof parsed.context === 'string') cfg.context = parsed.context;
    if (typeof parsed.conventions === 'string') cfg.conventions = parsed.conventions;
    return cfg;
  } catch {
    return undefined;
  }
}

/** Infer BuildConfig for a Node.js project from its package.json. */
function inferNodeBuildConfig(packageJsonContent: string): BuildConfig {
  const cfg: BuildConfig = { install: 'npm install' };
  try {
    const pkg = JSON.parse(packageJsonContent);
    const devDeps = { ...pkg.devDependencies, ...pkg.dependencies };
    if (devDeps?.typescript) {
      cfg.verify = 'npx tsc --noEmit';
    }
    if (pkg.scripts?.test) {
      cfg.test = 'npm test';
    }
  } catch {
    // Use defaults
  }
  return cfg;
}

/** Infer BuildConfig for a known stack. */
function inferBuildConfig(stack: string, extraContent?: string): BuildConfig {
  switch (stack) {
    case 'node':
      return inferNodeBuildConfig(extraContent || '{}');
    case 'go':
      return { install: 'go mod download', verify: 'go build ./...', test: 'go test ./...' };
    case 'python':
      return { install: 'pip install -r requirements.txt', verify: 'python -m py_compile', test: 'pytest' };
    case 'rust':
      return { install: 'cargo fetch', verify: 'cargo check', test: 'cargo test' };
    case 'terraform':
      return { install: 'terraform init', verify: 'terraform validate', test: 'terraform plan' };
    case 'java-maven':
      return { install: 'mvn dependency:resolve', verify: 'mvn compile -q', test: 'mvn test' };
    case 'java-gradle':
      return { install: 'gradle dependencies', verify: 'gradle compileJava', test: 'gradle test' };
    case 'docker':
      return { verify: 'docker build --no-cache .' };
    default:
      return {};
  }
}

/** List files in a directory inside the container. Returns [] on failure. */
async function listDir(exec: ContainerExecFn, dirPath: string): Promise<string[]> {
  const result = await exec(['sh', '-c', `ls -1 "${dirPath}" 2>/dev/null || true`]);
  if (!result.output.trim()) return [];
  return result.output.split('\n').map(l => l.trim()).filter(Boolean);
}

/** Check if a file exists in the container. */
async function fileExists(exec: ContainerExecFn, filePath: string): Promise<boolean> {
  const result = await exec(['sh', '-c', `test -f "${filePath}" && echo "yes" || echo "no"`]);
  return result.output.trim() === 'yes';
}

/** Read file contents from container. Returns undefined on failure. */
async function readFile(exec: ContainerExecFn, filePath: string): Promise<string | undefined> {
  const result = await exec(['sh', '-c', `cat "${filePath}" 2>/dev/null`]);
  if (result.exitCode !== 0) return undefined;
  return result.output;
}

/** Check if any .tf files exist in a directory. */
async function hasTfFiles(exec: ContainerExecFn, dirPath: string): Promise<boolean> {
  const result = await exec(['sh', '-c', `ls "${dirPath}"/*.tf 2>/dev/null | head -1`]);
  return result.output.trim().length > 0;
}

/** Detect the stack at a given directory path. Returns null if nothing detected. */
async function detectStackAtPath(
  exec: ContainerExecFn,
  dirPath: string,
): Promise<{ stack: string; extraContent?: string } | null> {
  // Check package.json
  const pkgJsonPath = `${dirPath}/package.json`;
  if (await fileExists(exec, pkgJsonPath)) {
    const content = await readFile(exec, pkgJsonPath);
    return { stack: 'node', extraContent: content };
  }

  // Check go.mod
  if (await fileExists(exec, `${dirPath}/go.mod`)) {
    return { stack: 'go' };
  }

  // Check Python
  if (await fileExists(exec, `${dirPath}/requirements.txt`) || await fileExists(exec, `${dirPath}/pyproject.toml`)) {
    return { stack: 'python' };
  }

  // Check Rust
  if (await fileExists(exec, `${dirPath}/Cargo.toml`)) {
    return { stack: 'rust' };
  }

  // Check Java/Maven
  if (await fileExists(exec, `${dirPath}/pom.xml`)) {
    return { stack: 'java-maven' };
  }

  // Check Gradle
  if (await fileExists(exec, `${dirPath}/build.gradle`)) {
    return { stack: 'java-gradle' };
  }

  // Check Dockerfile
  if (await fileExists(exec, `${dirPath}/Dockerfile`)) {
    return { stack: 'docker' };
  }

  // Check Terraform (.tf files)
  if (await hasTfFiles(exec, dirPath)) {
    return { stack: 'terraform' };
  }

  return null;
}

/**
 * Discover workspace configuration and stacks at a given path inside a container.
 *
 * @param exec  A function that executes shell commands inside the container
 * @param rootPath  Absolute path in the container to start discovery from
 * @returns RepoDiscovery with optional rootConfig and detected packages
 */
export async function discoverWorkspace(
  exec: ContainerExecFn,
  rootPath: string,
): Promise<RepoDiscovery> {
  const result: RepoDiscovery = { detected: [] };

  // 1. Check for armada.json at root
  const armadaJsonPath = `${rootPath}/armada.json`;
  const armadaJsonContent = await readFile(exec, armadaJsonPath);
  if (armadaJsonContent) {
    const parsed = parseArmadaJson(armadaJsonContent);
    if (parsed) {
      result.rootConfig = parsed;
    }
  }

  // 2. Walk up to 2 levels deep looking for stack markers
  const detected: DetectedPackage[] = [];

  // Check root itself
  const rootStack = await detectStackAtPath(exec, rootPath);
  if (rootStack) {
    detected.push({
      path: '.',
      stack: rootStack.stack,
      buildConfig: inferBuildConfig(rootStack.stack, rootStack.extraContent),
    });
  }

  // Check level 1 subdirectories
  const level1Dirs = await listDir(exec, rootPath);
  for (const entry of level1Dirs) {
    // Skip hidden dirs and common non-project dirs
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === 'target' || entry === '.git') {
      continue;
    }
    const level1Path = `${rootPath}/${entry}`;
    // Only descend into directories
    const isDirResult = await exec(['sh', '-c', `test -d "${level1Path}" && echo "yes" || echo "no"`]);
    if (isDirResult.output.trim() !== 'yes') continue;

    const l1Stack = await detectStackAtPath(exec, level1Path);
    if (l1Stack) {
      // Only add if it wasn't already counted at root (path '.' covers the root)
      detected.push({
        path: entry,
        stack: l1Stack.stack,
        buildConfig: inferBuildConfig(l1Stack.stack, l1Stack.extraContent),
      });

      // Don't descend further into a detected stack dir (avoid noisy sub-packages)
      continue;
    }

    // Check level 2 subdirectories
    const level2Dirs = await listDir(exec, level1Path);
    for (const subEntry of level2Dirs) {
      if (subEntry.startsWith('.') || subEntry === 'node_modules' || subEntry === 'dist' || subEntry === 'build' || subEntry === 'target' || subEntry === '.git') {
        continue;
      }
      const level2Path = `${level1Path}/${subEntry}`;
      const isDirResult2 = await exec(['sh', '-c', `test -d "${level2Path}" && echo "yes" || echo "no"`]);
      if (isDirResult2.output.trim() !== 'yes') continue;

      const l2Stack = await detectStackAtPath(exec, level2Path);
      if (l2Stack) {
        detected.push({
          path: `${entry}/${subEntry}`,
          stack: l2Stack.stack,
          buildConfig: inferBuildConfig(l2Stack.stack, l2Stack.extraContent),
        });
      }
    }
  }

  result.detected = detected;
  return result;
}
