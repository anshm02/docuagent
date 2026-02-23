"use client";

import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, useRef, useCallback } from "react";

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL!;

interface ProgressMessage {
  type: string;
  message: string;
  screenshot_url: string | null;
  created_at: string;
}

interface JobData {
  id: string;
  status: string;
  app_url: string;
  app_name: string | null;
  progress: {
    screens_found?: number;
    screens_crawled?: number;
    current_step?: string;
  };
  quality_score: number | null;
  result: {
    doc_url: string;
    total_screens: number;
    avg_confidence: number;
    duration_seconds: number;
  } | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  progress_messages: ProgressMessage[];
}

const STATUS_STEPS = [
  { key: "queued", label: "Queued" },
  { key: "analyzing_code", label: "Analyzing Code" },
  { key: "analyzing_prd", label: "Analyzing PRD" },
  { key: "planning_journeys", label: "Planning Journeys" },
  { key: "crawling", label: "Crawling App" },
  { key: "analyzing_screens", label: "Analyzing Screens" },
  { key: "generating_doc", label: "Generating Document" },
  { key: "completed", label: "Completed" },
];

function getStatusIndex(status: string): number {
  const idx = STATUS_STEPS.findIndex((s) => s.key === status);
  return idx === -1 ? 0 : idx;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function JobStatusPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<JobData | null>(null);
  const [messages, setMessages] = useState<ProgressMessage[]>([]);
  const [fetchError, setFetchError] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`${WORKER_URL}/api/jobs/${id}`);
      if (!res.ok) {
        setFetchError("Job not found");
        return;
      }
      const data: JobData = await res.json();
      setJob(data);
      // Merge API messages with realtime messages (dedup by created_at)
      setMessages((prev) => {
        const all = [...data.progress_messages.reverse(), ...prev];
        const seen = new Set<string>();
        return all.filter((m) => {
          const key = `${m.created_at}-${m.message}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
    } catch {
      setFetchError("Failed to fetch job status");
    }
  }, [id]);

  // Poll for updates
  useEffect(() => {
    fetchJob();
    const interval = setInterval(() => {
      fetchJob();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchJob]);

  // Subscribe to realtime progress messages
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`progress-${id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "progress_messages",
          filter: `job_id=eq.${id}`,
        },
        (payload) => {
          const msg = payload.new as ProgressMessage;
          setMessages((prev) => {
            const key = `${msg.created_at}-${msg.message}`;
            if (prev.some((m) => `${m.created_at}-${m.message}` === key)) {
              return prev;
            }
            return [...prev, msg];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id]);

  // Auto-scroll feed
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages]);

  if (fetchError) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{fetchError}</p>
          <Link href="/dashboard" className="text-blue-600 hover:underline">
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-pulse text-gray-400">Loading...</div>
      </div>
    );
  }

  const statusIdx = getStatusIndex(job.status);
  const isFailed = job.status === "failed";
  const isCompleted = job.status === "completed";
  const isRunning = !isFailed && !isCompleted;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
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

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* Job info */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-xl font-bold text-gray-900">
                {job.app_name || new URL(job.app_url).hostname}
              </h1>
              <p className="text-sm text-gray-500 mt-1">{job.app_url}</p>
            </div>
            {isCompleted && job.result?.doc_url && (
              <a
                href={job.result.doc_url}
                target="_blank"
                rel="noopener noreferrer"
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
                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                Download .docx
              </a>
            )}
          </div>

          {/* Stats row for completed jobs */}
          {isCompleted && job.result && (
            <div className="mt-4 grid grid-cols-3 gap-4">
              <div className="bg-gray-50 rounded-md p-3 text-center">
                <p className="text-2xl font-bold text-gray-900">
                  {job.result.total_screens}
                </p>
                <p className="text-xs text-gray-500">Screens Documented</p>
              </div>
              <div className="bg-gray-50 rounded-md p-3 text-center">
                <p className="text-2xl font-bold text-gray-900">
                  {job.quality_score ?? "—"}%
                </p>
                <p className="text-xs text-gray-500">Quality Score</p>
              </div>
              <div className="bg-gray-50 rounded-md p-3 text-center">
                <p className="text-2xl font-bold text-gray-900">
                  {formatDuration(job.result.duration_seconds)}
                </p>
                <p className="text-xs text-gray-500">Duration</p>
              </div>
            </div>
          )}
        </div>

        {/* Progress bar */}
        {!isFailed && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-sm font-medium text-gray-700 mb-4">
              Pipeline Progress
            </h2>
            <div className="flex items-center gap-1">
              {STATUS_STEPS.map((step, i) => {
                const isActive = i === statusIdx && isRunning;
                const isDone = i < statusIdx || isCompleted;
                return (
                  <div key={step.key} className="flex-1">
                    <div
                      className={`h-2 rounded-full transition-colors ${
                        isDone
                          ? "bg-blue-600"
                          : isActive
                            ? "bg-blue-400 animate-pulse"
                            : "bg-gray-200"
                      }`}
                    />
                    <p
                      className={`text-xs mt-1 text-center truncate ${
                        isDone || isActive ? "text-blue-600 font-medium" : "text-gray-400"
                      }`}
                    >
                      {step.label}
                    </p>
                  </div>
                );
              })}
            </div>
            {isRunning && job.progress?.current_step && (
              <p className="text-sm text-gray-500 mt-3">
                {job.progress.current_step}
              </p>
            )}
          </div>
        )}

        {/* Error display */}
        {isFailed && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-6">
            <h2 className="text-red-800 font-medium mb-2">Job Failed</h2>
            <p className="text-sm text-red-700">{job.error || "Unknown error"}</p>
          </div>
        )}

        {/* Progress messages feed */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-sm font-medium text-gray-700">Activity Log</h2>
          </div>
          <div
            ref={feedRef}
            className="max-h-[500px] overflow-y-auto divide-y divide-gray-50"
          >
            {messages.length === 0 && (
              <div className="px-6 py-8 text-center text-sm text-gray-400">
                {isRunning
                  ? "Waiting for updates..."
                  : "No activity recorded."}
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className="px-6 py-3 flex gap-3">
                <div className="flex-shrink-0 mt-0.5">
                  {msg.type === "error" ? (
                    <span className="inline-block w-2 h-2 rounded-full bg-red-400" />
                  ) : msg.type === "screenshot" ? (
                    <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
                  ) : msg.type === "complete" ? (
                    <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
                  ) : (
                    <span className="inline-block w-2 h-2 rounded-full bg-gray-300" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700">{msg.message}</p>
                  {msg.screenshot_url && (
                    <img
                      src={msg.screenshot_url}
                      alt="Screenshot"
                      className="mt-2 rounded-md border border-gray-200 max-w-xs"
                      loading="lazy"
                    />
                  )}
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0">
                  {formatTime(msg.created_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
