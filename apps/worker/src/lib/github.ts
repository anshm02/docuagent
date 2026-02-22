interface GitHubTreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
  url: string;
}

export interface GitHubTree {
  sha: string;
  url: string;
  tree: GitHubTreeItem[];
  truncated: boolean;
}

function getHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN");
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "DocuAgent/1.0",
  };
}

export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const cleaned = repoUrl.replace(/\.git$/, "").replace(/\/$/, "");
  const match = cleaned.match(/(?:github\.com\/)?([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`Invalid GitHub repo URL: ${repoUrl}`);
  }
  return { owner: match[1], repo: match[2] };
}

export async function fetchRepoTree(repoUrl: string, branch = "main"): Promise<GitHubTree> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const headers = getHeaders();
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 404) {
      const masterUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/master?recursive=1`;
      const masterResponse = await fetch(masterUrl, { headers });
      if (!masterResponse.ok) {
        throw new Error(`GitHub API error: ${masterResponse.status} ${masterResponse.statusText}`);
      }
      return masterResponse.json() as Promise<GitHubTree>;
    }
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<GitHubTree>;
}

export async function fetchFileContent(repoUrl: string, filePath: string, branch = "main"): Promise<string> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const headers = getHeaders();
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 404 && branch === "main") {
      const masterUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=master`;
      const masterResponse = await fetch(masterUrl, { headers });
      if (!masterResponse.ok) {
        throw new Error(`File not found: ${filePath}`);
      }
      const data = (await masterResponse.json()) as { content: string; encoding: string };
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    throw new Error(`GitHub API error fetching ${filePath}: ${response.status}`);
  }
  const data = (await response.json()) as { content: string; encoding: string };
  return Buffer.from(data.content, "base64").toString("utf-8");
}
