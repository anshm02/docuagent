import { fetchRepoTree, fetchFileContent } from "../lib/github.js";
import { claudeText, parseJsonResponse } from "../lib/claude.js";
import { componentAnalysisPrompt } from "../prompts/code-analysis.js";
import type { CrawlPlan, RouteInfo, FieldInfo, ModalInfo } from "@docuagent/shared";

interface ComponentAnalysisResult {
  fields: FieldInfo[];
  apiCalls: { method: string; endpoint: string; purpose: string }[];
  permissions: { action: string; role: string }[];
  modals: { trigger: string; component: string; fields: FieldInfo[] }[];
  tableColumns: { header: string; dataKey: string }[];
  actions: { label: string; handler_description: string }[];
}

function detectFramework(packageJson: Record<string, unknown>): CrawlPlan["framework"] {
  const deps = {
    ...(packageJson.dependencies as Record<string, string> || {}),
    ...(packageJson.devDependencies as Record<string, string> || {}),
  };

  if (deps["next"]) {
    return "nextjs-app"; // We'll verify app vs pages later
  }
  if (deps["react-router-dom"] || deps["react-router"]) {
    return "react-router";
  }
  return "unknown";
}

function classifyRoute(path: string, componentName: string): RouteInfo["type"] {
  const lowerPath = path.toLowerCase();
  const lowerComp = componentName.toLowerCase();

  if (lowerPath.includes("dashboard") || lowerComp.includes("dashboard")) return "dashboard";
  if (lowerPath.includes("settings") || lowerComp.includes("settings")) return "settings";
  if (lowerPath.includes("new") || lowerPath.includes("create") || lowerComp.includes("create")) return "create";
  if (lowerPath.includes("[") || lowerPath.includes(":")) return "detail";
  if (lowerPath.endsWith("s") || lowerComp.includes("list")) return "list";
  return "other";
}

function appRouterPathToUrl(filePath: string): string {
  // app/(group)/dashboard/page.tsx → /dashboard
  // app/projects/[id]/page.tsx → /projects/[id]
  let route = filePath
    .replace(/^app\//, "/")
    .replace(/\/page\.tsx$/, "")
    .replace(/\/page\.ts$/, "")
    .replace(/\/page\.jsx$/, "")
    .replace(/\/page\.js$/, "");

  // Remove route groups: /(auth)/ → /
  route = route.replace(/\/\([^)]+\)/g, "");

  // Clean up double slashes
  route = route.replace(/\/+/g, "/");

  return route || "/";
}

function findNextJsAppRouterPages(tree: { path: string }[]): { filePath: string; routePath: string }[] {
  return tree
    .filter((item) => {
      const p = item.path;
      return (
        p.startsWith("app/") &&
        /\/page\.(tsx|ts|jsx|js)$/.test(p) &&
        !p.includes("/api/") &&
        !p.includes("_")
      );
    })
    .map((item) => ({
      filePath: item.path,
      routePath: appRouterPathToUrl(item.path),
    }));
}

function findNextJsPagesRouterPages(tree: { path: string }[]): { filePath: string; routePath: string }[] {
  return tree
    .filter((item) => {
      const p = item.path;
      return (
        p.startsWith("pages/") &&
        /\.(tsx|ts|jsx|js)$/.test(p) &&
        !p.startsWith("pages/api/") &&
        !p.startsWith("pages/_")
      );
    })
    .map((item) => {
      const routePath = item.path
        .replace(/^pages/, "")
        .replace(/\.(tsx|ts|jsx|js)$/, "")
        .replace(/\/index$/, "") || "/";
      return { filePath: item.path, routePath };
    });
}

async function analyzeComponent(repoUrl: string, filePath: string): Promise<ComponentAnalysisResult> {
  try {
    const source = await fetchFileContent(repoUrl, filePath);
    // Truncate very large files to avoid token limits
    const truncated = source.length > 12000 ? source.substring(0, 12000) + "\n// ... truncated" : source;
    const response = await claudeText(componentAnalysisPrompt(truncated), {
      maxTokens: 2000,
      temperature: 0,
    });
    return parseJsonResponse<ComponentAnalysisResult>(response);
  } catch (error) {
    console.warn(`  Warning: Could not analyze ${filePath}: ${(error as Error).message}`);
    return {
      fields: [],
      apiCalls: [],
      permissions: [],
      modals: [],
      tableColumns: [],
      actions: [],
    };
  }
}

export async function runCodeAnalysis(repoUrl: string | null): Promise<CrawlPlan> {
  if (!repoUrl) {
    console.log("No repo URL provided, returning empty crawl plan.");
    return { framework: "unknown", routes: [] };
  }

  console.log(`Analyzing repo: ${repoUrl}`);

  // Step 1: Fetch repo tree
  const tree = await fetchRepoTree(repoUrl);
  console.log(`  Repo tree: ${tree.tree.length} items`);

  // Step 2: Find and parse package.json for framework detection
  let framework: CrawlPlan["framework"] = "unknown";
  try {
    const pkgContent = await fetchFileContent(repoUrl, "package.json");
    const pkg = JSON.parse(pkgContent);
    framework = detectFramework(pkg);
    console.log(`  Detected framework: ${framework}`);
  } catch {
    console.warn("  Could not read package.json, framework unknown.");
  }

  // Step 3: Extract routes based on framework
  let pages: { filePath: string; routePath: string }[] = [];

  if (framework === "nextjs-app") {
    // Check if it's actually app router or pages router
    const hasAppDir = tree.tree.some((item) => item.path.startsWith("app/") && item.path.includes("page."));
    const hasPagesDir = tree.tree.some((item) => item.path.startsWith("pages/") && !item.path.startsWith("pages/api/"));

    if (hasAppDir) {
      pages = findNextJsAppRouterPages(tree.tree);
      framework = "nextjs-app";
    } else if (hasPagesDir) {
      pages = findNextJsPagesRouterPages(tree.tree);
      framework = "nextjs-pages";
    }
  } else if (framework === "react-router") {
    // Find router config and send to Claude
    const routerFiles = tree.tree.filter(
      (item) =>
        item.path.match(/router|routes/i) &&
        /\.(tsx|ts|jsx|js)$/.test(item.path)
    );
    if (routerFiles.length > 0) {
      try {
        const source = await fetchFileContent(repoUrl, routerFiles[0].path);
        const response = await claudeText(
          `Analyze this React Router configuration and extract all routes.
Return as JSON array: [{ "path": "/example", "component": "ExamplePage.tsx", "type": "list|detail|create|settings|dashboard|other" }]

ROUTER CONFIG:
${source}

Return ONLY valid JSON. No markdown, no explanation, no backticks.`,
          { maxTokens: 2000, temperature: 0 }
        );
        const routes = parseJsonResponse<{ path: string; component: string; type: string }[]>(response);
        pages = routes.map((r) => ({ filePath: r.component, routePath: r.path }));
      } catch (error) {
        console.warn(`  Router extraction failed: ${(error as Error).message}`);
      }
    }
  }

  // Also check src/app/ pattern
  if (pages.length === 0) {
    const srcAppPages = tree.tree.filter((item) =>
      item.path.startsWith("src/app/") && /\/page\.(tsx|ts|jsx|js)$/.test(item.path) && !item.path.includes("/api/")
    );
    if (srcAppPages.length > 0) {
      framework = "nextjs-app";
      pages = srcAppPages.map((item) => ({
        filePath: item.path,
        routePath: appRouterPathToUrl(item.path.replace(/^src\//, "")),
      }));
    }
  }

  console.log(`  Found ${pages.length} page routes`);

  if (pages.length < 5) {
    console.log("  Less than 5 routes found, returning minimal plan (will use Stagehand fallback).");
    return {
      framework,
      routes: pages.map((p) => ({
        path: p.routePath,
        component: p.filePath.split("/").pop() || p.filePath,
        type: classifyRoute(p.routePath, p.filePath),
        fields: [],
        modals: [],
        permissions: [],
        apiCalls: [],
      })),
    };
  }

  // Step 4: Analyze each page component with Claude
  console.log("  Analyzing page components...");
  const routes: RouteInfo[] = [];

  for (const page of pages) {
    console.log(`    Analyzing: ${page.routePath} (${page.filePath})`);
    const analysis = await analyzeComponent(repoUrl, page.filePath);

    routes.push({
      path: page.routePath,
      component: page.filePath.split("/").pop() || page.filePath,
      type: classifyRoute(page.routePath, page.filePath),
      fields: analysis.fields,
      modals: analysis.modals.map((m) => ({
        trigger: m.trigger,
        component: m.component,
        fields: m.fields,
      })),
      permissions: analysis.permissions,
      apiCalls: analysis.apiCalls,
    });
  }

  console.log(`  Code analysis complete: ${routes.length} routes analyzed.`);
  return { framework, routes };
}
