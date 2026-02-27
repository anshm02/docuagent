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
  Award,
  DollarSign,
} from "lucide-react";

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
  { key: "discovering", label: "Discovering Pages" },
  { key: "planning_journeys", label: "Selecting Features" },
  { key: "crawling", label: "Crawling App" },
  { key: "analyzing_screens", label: "Analyzing Screens" },
  { key: "generating_docs", label: "Generating Docs" },
  { key: "completed", label: "Completed" },
];

function getStatusIndex(status: string): number {
  const idx = STATUS_STEPS.findIndex((s) => s.key === status);
  return idx === -1 ? 0 : idx;
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
      if (data.progress_messages && data.progress_messages.length > 0) {
        const msgs = [...data.progress_messages];
        const latest = msgs[msgs.length - 1];
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
                ? `${job.app_name || new URL(job.app_url).hostname}`
                : isFailed
                  ? job.error || "An error occurred during generation"
                  : "This will take a few minutes"}
            </p>
          </div>

          {/* Completed stats + actions */}
          {isCompleted && job.result && (
            <>
              {/* Stats grid */}
              <div className="grid grid-cols-4 gap-3">
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
                    {job.result.features_documented}/{job.result.features_total}
                  </p>
                  <p className="text-[10px] text-gray-500">Features</p>
                </GlassCard>
                <GlassCard className="p-4 text-center">
                  <Award className="w-4 h-4 text-blue-400 mx-auto mb-1" />
                  <p className="text-xl font-bold text-white">
                    {job.quality_score ?? "\u2014"}%
                  </p>
                  <p className="text-[10px] text-gray-500">Quality</p>
                </GlassCard>
                <GlassCard className="p-4 text-center">
                  <DollarSign className="w-4 h-4 text-blue-400 mx-auto mb-1" />
                  <p className="text-xl font-bold text-white">
                    ${((job.result.actual_cost_cents ?? 0) / 100).toFixed(2)}
                  </p>
                  <p className="text-[10px] text-gray-500">Cost</p>
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

              {/* Additional features upsell */}
              {job.result.additional_features &&
                job.result.additional_features.length > 0 && (
                  <GlassCard className="p-4">
                    <p className="text-sm text-gray-400">
                      {job.result.additional_features.length} more features
                      available \u2014 upgrade for full documentation
                    </p>
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
