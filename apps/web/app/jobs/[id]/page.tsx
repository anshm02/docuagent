"use client";

import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/GlassCard";
import {
  Loader2,
  CheckCircle2,
  Circle,
  Download,
  FileText,
  XCircle,
  Sparkles,
  Monitor,
  Route,
  ClipboardList,
} from "lucide-react";

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL!;

interface ProgressMessage {
  type: string;
  message: string;
  screenshot_url: string | null;
  created_at: string;
}

interface Feature {
  id: string;
  name: string;
  slug: string;
  description: string;
  route: string;
  hasForm: boolean;
  priority: number;
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
  journeys: Feature[] | null;
  result: {
    docs_url: string;
    zip_url: string;
    total_screens: number;
    avg_confidence: number;
    duration_seconds: number;
    features_documented: number;
    features_total: number;
    estimated_cost_cents: number;
    actual_cost_cents: number;
    additional_features?: { title: string; description: string }[];
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
  { key: "discovering", label: "Discovering Features" },
  { key: "planning_journeys", label: "Selecting Features" },
  { key: "crawling", label: "Documenting Features" },
  { key: "analyzing_screens", label: "Analyzing Screens" },
  { key: "generating_docs", label: "Generating Docs" },
  { key: "completed", label: "Completed" },
];

function getStatusIndex(status: string): number {
  const idx = STATUS_STEPS.findIndex((s) => s.key === status);
  return idx === -1 ? 0 : idx;
}

function getAppDisplayName(job: JobData): string {
  if (job.app_name) return job.app_name;
  try {
    const url = new URL(job.app_url);
    const hostname = url.hostname.replace(/^www\./, "");
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return url.host; // include port for localhost
    }
    return hostname;
  } catch {
    return job.app_url;
  }
}

export default function JobStatusPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<JobData | null>(null);
  const [latestMessage, setLatestMessage] = useState("");
  const [fetchError, setFetchError] = useState("");

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`${WORKER_URL}/api/jobs/${id}`);
      if (!res.ok) {
        setFetchError("Job not found");
        return;
      }
      const data: JobData = await res.json();
      setJob(data);

      // Get the latest message for the agent activity display
      // API returns messages ordered by created_at DESC, so index 0 is the newest
      if (data.progress_messages && data.progress_messages.length > 0) {
        const latest = data.progress_messages[0];
        console.log("[agent-activity] poll received", data.progress_messages.length, "messages. Latest:", latest?.message);
        if (latest) setLatestMessage(latest.message);
      }
    } catch {
      setFetchError("Failed to fetch job status");
    }
  }, [id]);

  // Poll for updates every 5 seconds
  useEffect(() => {
    fetchJob();
    const interval = setInterval(fetchJob, 5000);
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
          console.log("[agent-activity] realtime message:", msg.message);
          setLatestMessage(msg.message);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id]);

  if (fetchError) {
    return (
      <div className="min-h-screen bg-[#0a0b14] flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{fetchError}</p>
          <Link href="/new" className="text-blue-400 hover:text-blue-300 transition-colors">
            Back to Generate
          </Link>
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="min-h-screen bg-[#0a0b14] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
      </div>
    );
  }

  const statusIdx = getStatusIndex(job.status);
  const isFailed = job.status === "failed";
  const isCompleted = job.status === "completed";
  const isRunning = !isFailed && !isCompleted;
  const progressPercent = Math.round(
    ((statusIdx + (isCompleted ? 0 : 0.5)) / (STATUS_STEPS.length - 1)) * 100
  );

  return (
    <div className="min-h-screen bg-[#0a0b14] flex flex-col">
      <Navbar />

      <main className="flex-1 flex flex-col items-center px-4 py-12">
        <div className="w-full max-w-lg space-y-8">
          {/* Top section */}
          <div className="text-center">
            {isRunning && (
              <div className="w-14 h-14 rounded-full bg-blue-600/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
                <Loader2 className="w-7 h-7 text-blue-400 animate-spin-slow" />
              </div>
            )}
            {isCompleted && (
              <div className="w-14 h-14 rounded-full bg-emerald-600/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-7 h-7 text-emerald-400" />
              </div>
            )}
            {isFailed && (
              <div className="w-14 h-14 rounded-full bg-red-600/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
                <XCircle className="w-7 h-7 text-red-400" />
              </div>
            )}

            <h1 className="text-2xl font-bold text-white">
              {isCompleted
                ? "Documentation ready!"
                : isFailed
                  ? "Generation failed"
                  : "Generating documentation"}
            </h1>
            <p className="text-gray-400 text-sm mt-1">
              {isCompleted
                ? getAppDisplayName(job)
                : isFailed
                  ? job.error || "An error occurred during generation"
                  : "This will take a few minutes"}
            </p>
          </div>

          {/* Completed stats + actions */}
          {isCompleted && job.result && (
            <>
              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-3">
                <GlassCard className="p-4 text-center">
                  <Monitor className="w-4 h-4 text-blue-400 mx-auto mb-1" />
                  <p className="text-xl font-bold text-white">
                    {job.result.total_screens}
                  </p>
                  <p className="text-[10px] text-gray-500">Screens</p>
                </GlassCard>
                <GlassCard className="p-4 text-center">
                  <Route className="w-4 h-4 text-blue-400 mx-auto mb-1" />
                  <p className="text-xl font-bold text-white">
                    {job.result.features_documented ?? 0}/{job.result.features_total ?? 0}
                  </p>
                  <p className="text-[10px] text-gray-500">Features</p>
                </GlassCard>
              </div>

              {/* Action buttons */}
              <div className="flex gap-3">
                <Link
                  href={`/jobs/${id}/docs`}
                  className="btn-primary flex-1 text-sm"
                >
                  <FileText className="w-4 h-4" />
                  View Documentation
                </Link>
                {job.result.zip_url && (
                  <a
                    href={job.result.zip_url}
                    download
                    className="btn-ghost text-sm"
                  >
                    <Download className="w-4 h-4" />
                    Download .zip
                  </a>
                )}
              </div>

              {/* Additional features */}
              {job.result.additional_features &&
                job.result.additional_features.length > 0 && (
                  <GlassCard className="p-4">
                    <p className="text-sm text-gray-400 mb-3">
                      These features will also be documented in the full version:
                    </p>
                    <ul className="space-y-1.5">
                      {job.result.additional_features.map((f, i) => (
                        <li key={i} className="flex items-center gap-2 text-sm text-gray-500">
                          <ClipboardList className="w-3.5 h-3.5 flex-shrink-0" />
                          {f.title}
                        </li>
                      ))}
                    </ul>
                  </GlassCard>
                )}
            </>
          )}

          {/* Progress card */}
          {!isFailed && (
            <GlassCard className="p-6">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-gray-300">
                  Progress
                </span>
                <span className="text-sm text-gray-400">
                  {isCompleted ? 100 : progressPercent}%
                </span>
              </div>

              {/* Progress bar */}
              <div className="h-1.5 bg-white/5 rounded-full overflow-hidden mb-6">
                <div
                  className="h-full bg-blue-600 rounded-full transition-all duration-700"
                  style={{
                    width: `${isCompleted ? 100 : progressPercent}%`,
                  }}
                />
              </div>

              {/* Stage checklist */}
              <div className="space-y-1">
                {STATUS_STEPS.map((step, i) => {
                  const isCurrent = i === statusIdx && isRunning;
                  const isDone = i < statusIdx || isCompleted;
                  return (
                    <div
                      key={step.key}
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                        isCurrent ? "bg-blue-600/10" : ""
                      }`}
                    >
                      {isDone ? (
                        <CheckCircle2 className="w-4 h-4 text-blue-400 flex-shrink-0" />
                      ) : isCurrent ? (
                        <div className="w-4 h-4 rounded-full border-2 border-blue-400 flex items-center justify-center flex-shrink-0">
                          <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                        </div>
                      ) : (
                        <Circle className="w-4 h-4 text-gray-600 flex-shrink-0" />
                      )}
                      <span
                        className={`text-sm ${
                          isDone
                            ? "text-gray-300"
                            : isCurrent
                              ? "text-white font-medium"
                              : "text-gray-500"
                        }`}
                      >
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </GlassCard>
          )}

          {/* Feature list card - show after discovery */}
          {isRunning && job.journeys && job.journeys.length > 0 && (
            <GlassCard className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <ClipboardList className="w-4 h-4 text-blue-400" />
                <span className="text-sm font-medium text-gray-200">
                  Features to Document
                </span>
              </div>
              <div className="space-y-1.5">
                {job.journeys.map((feature) => {
                  const isDone = latestMessage.includes(`Completed feature: ${feature.name}`) ||
                    latestMessage.includes(`feature "${feature.name}" complete`) ||
                    (job.progress_messages ?? []).some(
                      (m) => m.message.includes(`Completed feature: ${feature.name}`) ||
                             m.message.includes(`feature "${feature.name}" complete`)
                    );
                  return (
                    <div key={feature.id} className="flex items-center gap-2 text-sm">
                      {isDone ? (
                        <span className="text-emerald-400 font-medium flex-shrink-0 w-4 text-center">&#10003;</span>
                      ) : (
                        <span className="text-gray-500 flex-shrink-0 w-4 text-center">&mdash;</span>
                      )}
                      <span className={isDone ? "text-gray-300" : "text-gray-400"}>
                        {feature.name}
                      </span>
                    </div>
                  );
                })}
              </div>
              {job.result?.additional_features && job.result.additional_features.length > 0 && (
                <div className="mt-3 pt-3 border-t border-white/5">
                  <p className="text-xs text-gray-500 mb-1.5">
                    These will also be documented in the full version:
                  </p>
                  {job.result.additional_features.map((f, i) => (
                    <p key={i} className="text-xs text-gray-600 ml-6">{f.title}</p>
                  ))}
                </div>
              )}
            </GlassCard>
          )}

          {/* Failed error display */}
          {isFailed && (
            <GlassCard className="p-6 border-red-500/20">
              <p className="text-sm text-red-400">{job.error || "Unknown error occurred"}</p>
              <Link
                href="/new"
                className="btn-primary text-sm mt-4 inline-flex"
              >
                Try Again
              </Link>
            </GlassCard>
          )}

          {/* Agent activity */}
          {isRunning && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-300">
                  Agent activity
                </span>
              </div>
              <div className="flex items-start gap-3">
                {/* Thinking dots */}
                <div className="flex gap-1 pt-1.5 flex-shrink-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-400 thinking-dot" />
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-400 thinking-dot" />
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-400 thinking-dot" />
                </div>
                <p className="text-sm text-gray-400 leading-relaxed">
                  {latestMessage || "Initializing documentation pipeline..."}
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
