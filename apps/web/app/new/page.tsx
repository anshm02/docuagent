"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import Link from "next/link";

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL!;

export default function NewJobPage() {
  const [appUrl, setAppUrl] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [githubRepoUrl, setGithubRepoUrl] = useState("");
  const [productDescription, setProductDescription] = useState("");
  const [prdFile, setPrdFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const router = useRouter();

  const isLocalhost =
    appUrl.includes("localhost") || appUrl.includes("127.0.0.1");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUserId(data.user.id);
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // Validate URL
      try {
        new URL(appUrl);
      } catch {
        setError("Please enter a valid App URL");
        setLoading(false);
        return;
      }

      const body: Record<string, unknown> = {
        app_url: appUrl,
        user_id: userId,
      };

      if (loginUrl) body.login_url = loginUrl;
      if (username && password) {
        body.credentials = { username, password };
      }
      if (githubRepoUrl) body.github_repo_url = githubRepoUrl;
      if (productDescription) body.product_description = productDescription;

      // If PRD file, upload to Supabase Storage first
      if (prdFile) {
        const supabase = createClient();
        const filePath = `prd/${Date.now()}-${prdFile.name}`;
        const { error: uploadError } = await supabase.storage
          .from("documents")
          .upload(filePath, prdFile);

        if (uploadError) {
          setError(`Failed to upload PRD: ${uploadError.message}`);
          setLoading(false);
          return;
        }
        body.prd_file_path = filePath;
      }

      const res = await fetch(`${WORKER_URL}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to create job");
        setLoading(false);
        return;
      }

      router.push(`/jobs/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/dashboard" className="text-lg font-bold text-gray-900">
            DocuAgent
          </Link>
          <Link
            href="/dashboard"
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Back to Dashboard
          </Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          Generate Documentation
        </h1>
        <p className="text-gray-500 mb-8">
          Provide your app details and we&apos;ll generate professional
          documentation automatically.
        </p>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-6"
        >
          {error && (
            <div className="bg-red-50 text-red-700 text-sm rounded-md p-3">
              {error}
            </div>
          )}

          {/* App URL */}
          <div>
            <label
              htmlFor="appUrl"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              App URL <span className="text-red-500">*</span>
            </label>
            <input
              id="appUrl"
              type="url"
              required
              value={appUrl}
              onChange={(e) => setAppUrl(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="https://app.example.com"
            />
            {isLocalhost && (
              <div className="mt-2 bg-amber-50 border border-amber-200 rounded-md p-3">
                <p className="text-sm text-amber-800 font-medium">
                  Your app is running locally
                </p>
                <p className="text-sm text-amber-700 mt-1">
                  Run{" "}
                  <code className="bg-amber-100 px-1 rounded">
                    npx ngrok http{" "}
                    {appUrl.match(/:(\d+)/)?.[1] || "[port]"}
                  </code>{" "}
                  in your terminal and paste the https URL here instead.
                </p>
              </div>
            )}
          </div>

          {/* Login URL */}
          <div>
            <label
              htmlFor="loginUrl"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Login URL{" "}
              <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              id="loginUrl"
              type="url"
              value={loginUrl}
              onChange={(e) => setLoginUrl(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="https://app.example.com/login"
            />
            <p className="text-xs text-gray-400 mt-1">
              If different from the app URL. Leave blank if login is at the app
              URL.
            </p>
          </div>

          {/* Credentials */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="username"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Username / Email <span className="text-red-500">*</span>
              </label>
              <input
                id="username"
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="test@example.com"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Password <span className="text-red-500">*</span>
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="App password"
              />
            </div>
          </div>
          <p className="text-xs text-gray-400 -mt-4">
            Credentials are used only during crawling and deleted after the job
            completes.
          </p>

          <hr className="border-gray-100" />

          {/* GitHub Repo */}
          <div>
            <label
              htmlFor="githubRepoUrl"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              GitHub Repo URL{" "}
              <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              id="githubRepoUrl"
              type="url"
              value={githubRepoUrl}
              onChange={(e) => setGithubRepoUrl(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="https://github.com/org/repo"
            />
            <p className="text-xs text-gray-400 mt-1">
              Providing source code improves documentation quality with field
              types, validation rules, and API details.
            </p>
          </div>

          {/* PRD Upload */}
          <div>
            <label
              htmlFor="prdFile"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              PRD / Product Doc{" "}
              <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              id="prdFile"
              type="file"
              accept=".docx,.pdf,.txt,.md"
              onChange={(e) => setPrdFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
            />
            <p className="text-xs text-gray-400 mt-1">
              Upload a PRD, spec, or product doc (.docx, .pdf, .txt, .md) for
              richer context.
            </p>
          </div>

          {/* Product Description */}
          <div>
            <label
              htmlFor="productDescription"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Product Description{" "}
              <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <textarea
              id="productDescription"
              rows={3}
              value={productDescription}
              onChange={(e) => setProductDescription(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Brief description of your app, target users, key features..."
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white rounded-md py-2.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Creating job..." : "Generate Documentation"}
          </button>
        </form>
      </main>
    </div>
  );
}
