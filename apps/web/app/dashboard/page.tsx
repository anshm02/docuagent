"use client";

import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface JobRow {
  id: string;
  status: string;
  app_url: string;
  app_name: string | null;
  quality_score: number | null;
  result: {
    doc_url: string;
    total_screens: number;
  } | null;
  error: string | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  queued: "bg-gray-100 text-gray-700",
  analyzing_code: "bg-blue-100 text-blue-700",
  analyzing_prd: "bg-blue-100 text-blue-700",
  discovering: "bg-cyan-100 text-cyan-700",
  planning_journeys: "bg-blue-100 text-blue-700",
  crawling: "bg-yellow-100 text-yellow-700",
  analyzing_screens: "bg-purple-100 text-purple-700",
  generating_docs: "bg-indigo-100 text-indigo-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
};

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  analyzing_code: "Analyzing Code",
  analyzing_prd: "Analyzing PRD",
  discovering: "Discovering",
  planning_journeys: "Planning",
  crawling: "Crawling",
  analyzing_screens: "Analyzing",
  generating_docs: "Generating",
  completed: "Completed",
  failed: "Failed",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DashboardPage() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [userEmail, setUserEmail] = useState("");
  const router = useRouter();

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      setUserEmail(user.email ?? "");

      const { data: jobRows } = await supabase
        .from("jobs")
        .select(
          "id, status, app_url, app_name, quality_score, result, error, created_at"
        )
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      setJobs(jobRows ?? []);
      setLoading(false);
    }

    load();
  }, [router]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-lg font-bold text-gray-900">DocuAgent</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">{userEmail}</span>
            <button
              onClick={handleSignOut}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-gray-900">Your Jobs</h2>
          <Link
            href="/new"
            className="inline-flex items-center gap-2 bg-blue-600 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            New Documentation
          </Link>
        </div>

        {loading ? (
          <div className="text-center py-12 text-gray-400">Loading...</div>
        ) : jobs.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
            <div className="text-4xl mb-4">&#128196;</div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              No documentation jobs yet
            </h3>
            <p className="text-gray-500 mb-6">
              Generate your first documentation by providing your app URL and
              credentials.
            </p>
            <Link
              href="/new"
              className="inline-flex items-center gap-2 bg-blue-600 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              Get Started
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <Link
                key={job.id}
                href={`/jobs/${job.id}`}
                className="block bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <h3 className="text-sm font-medium text-gray-900 truncate">
                        {job.app_name ||
                          (() => {
                            try {
                              return new URL(job.app_url).hostname;
                            } catch {
                              return job.app_url;
                            }
                          })()}
                      </h3>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[job.status] ?? "bg-gray-100 text-gray-700"}`}
                      >
                        {STATUS_LABELS[job.status] ?? job.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      {formatDate(job.created_at)}
                      {job.result?.total_screens != null &&
                        ` · ${job.result.total_screens} screens`}
                      {job.quality_score != null &&
                        ` · ${job.quality_score}% quality`}
                    </p>
                  </div>

                  <div className="flex items-center gap-3 ml-4">
                    {job.status === "completed" && job.result?.doc_url && (
                      <a
                        href={job.result.doc_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 text-sm font-medium"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                        Download
                      </a>
                    )}
                    <svg
                      className="w-4 h-4 text-gray-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
