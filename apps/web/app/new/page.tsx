"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useState, useEffect, useCallback, useRef } from "react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/GlassCard";
import {
  Globe,
  Lock,
  FileText,
  ArrowLeft,
  ArrowRight,
  Upload,
  Shield,
} from "lucide-react";

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL!;

const STEPS = [
  { label: "Where's your app?", icon: Globe },
  { label: "Access credentials", icon: Lock },
  { label: "Additional context", icon: FileText },
];

export default function NewJobPage() {
  const [step, setStep] = useState(1);
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
  const [credits, setCredits] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const router = useRouter();

  const isLocalhost =
    appUrl.includes("localhost") || appUrl.includes("127.0.0.1");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data }) => {
      if (data.user) {
        setUserId(data.user.id);
        const { data: profile } = await supabase
          .from("profiles")
          .select("credits")
          .eq("id", data.user.id)
          .single();
        if (profile) setCredits(profile.credits);
      }
    });
  }, []);

  const canContinue = useCallback(() => {
    if (step === 1) {
      try {
        new URL(appUrl);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }, [step, appUrl]);

  async function handleSubmit() {
    setError("");
    setLoading(true);

    try {
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

      // Upload PRD if provided
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

  function handleNext() {
    if (step < 3) {
      setStep(step + 1);
    } else {
      handleSubmit();
    }
  }

  function handleBack() {
    if (step > 1) {
      setStep(step - 1);
    } else {
      router.push("/");
    }
  }

  function handleSkip() {
    if (step < 3) {
      setStep(step + 1);
    } else {
      handleSubmit();
    }
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && /\.(pdf|docx|txt|md)$/i.test(file.name)) {
      setPrdFile(file);
    }
  }

  const percentage = Math.round((step / 3) * 100);
  const StepIcon = STEPS[step - 1].icon;

  return (
    <div className="min-h-screen bg-[#0a0b14] flex flex-col">
      <Navbar />

      <main className="flex-1 flex flex-col items-center px-4 pt-8 pb-24">
        {credits !== null && credits <= 0 ? (
          <div className="w-full max-w-lg flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-gray-600/10 border border-gray-500/20 flex items-center justify-center mx-auto mb-4">
                <FileText className="w-7 h-7 text-gray-400" />
              </div>
              <h1 className="text-2xl font-bold text-white mb-2">
                Free run used
              </h1>
              <p className="text-gray-400 text-sm max-w-xs mx-auto">
                You&apos;ve used your free documentation run. Contact us at{" "}
                <a href="mailto:hello@docuagent.dev" className="text-blue-400 hover:text-blue-300">
                  hello@docuagent.dev
                </a>{" "}
                for additional runs.
              </p>
            </div>
          </div>
        ) : (
        <div className="w-full max-w-lg">
          {/* Step indicator */}
          <div className="mb-8">
            <div className="flex items-center justify-between text-sm text-gray-400 mb-2">
              <span>Step {step} of 3</span>
              <span>{percentage}%</span>
            </div>
            <div className="h-1 bg-white/5 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 rounded-full transition-all duration-500"
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>

          {/* Step icon */}
          <div className="w-12 h-12 rounded-xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center mb-6">
            <StepIcon className="w-6 h-6 text-blue-400" />
          </div>

          {/* Step heading */}
          <h1 className="text-3xl font-bold text-white mb-2">
            {STEPS[step - 1].label}
          </h1>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg p-3 mb-4">
              {error}
            </div>
          )}

          {/* Step 1: App URL */}
          {step === 1 && (
            <div className="space-y-5">
              <p className="text-gray-400 text-sm">
                Enter the URL where your application is hosted
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  App URL
                </label>
                <input
                  type="url"
                  value={appUrl}
                  onChange={(e) => setAppUrl(e.target.value)}
                  className="glass-input text-sm"
                  placeholder="https://app.example.com"
                  autoFocus
                />
                {isLocalhost && (
                  <div className="mt-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3">
                    <p className="text-sm text-yellow-400 font-medium">
                      Your app is running locally
                    </p>
                    <p className="text-xs text-yellow-400/70 mt-1">
                      Run{" "}
                      <code className="bg-yellow-500/10 px-1 rounded">
                        npx ngrok http {appUrl.match(/:(\d+)/)?.[1] || "[port]"}
                      </code>{" "}
                      in your terminal and paste the https URL here.
                    </p>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Login URL{" "}
                  <span className="text-gray-500 font-normal">(optional)</span>
                </label>
                <input
                  type="url"
                  value={loginUrl}
                  onChange={(e) => setLoginUrl(e.target.value)}
                  className="glass-input text-sm"
                  placeholder="https://app.example.com/login"
                />
                <p className="text-xs text-gray-500 mt-1.5">
                  If different from the main URL
                </p>
              </div>
            </div>
          )}

          {/* Step 2: Credentials */}
          {step === 2 && (
            <div className="space-y-5">
              <p className="text-gray-400 text-sm">
                Credentials to access your application
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Username or Email
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="glass-input text-sm"
                  placeholder="test_username@gmail.com"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="glass-input text-sm"
                  placeholder="hellojs"
                />
              </div>

              {/* Security callout */}
              <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-4 flex gap-3">
                <Shield className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-emerald-400">
                    Encrypted & secure
                  </p>
                  <p className="text-xs text-emerald-400/60 mt-0.5">
                    Credentials are deleted immediately after generation
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Additional context */}
          {step === 3 && (
            <div className="space-y-5">
              <p className="text-gray-400 text-sm">
                Optional info to improve accuracy
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  <span className="inline-flex items-center gap-1.5">
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                    </svg>
                    GitHub Repository
                  </span>
                  <span className="text-gray-500 font-normal ml-1">(optional)</span>
                </label>
                <input
                  type="url"
                  value={githubRepoUrl}
                  onChange={(e) => setGithubRepoUrl(e.target.value)}
                  className="glass-input text-sm"
                  placeholder="https://github.com/org/repo"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Product Description{" "}
                  <span className="text-gray-500 font-normal">(optional)</span>
                </label>
                <textarea
                  value={productDescription}
                  onChange={(e) => setProductDescription(e.target.value)}
                  className="glass-input text-sm min-h-[80px] resize-y"
                  placeholder="Describe your product: what it does, who it's for, key features..."
                  rows={3}
                />
                <p className="text-xs text-gray-500 mt-1.5">
                  Adds business context, glossary terms, and workflow descriptions to docs
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Product Document{" "}
                  <span className="text-gray-500 font-normal">(optional)</span>
                </label>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleFileDrop}
                  className={`glass-card p-8 text-center cursor-pointer transition-colors ${
                    dragOver
                      ? "border-blue-500/50 bg-blue-500/5"
                      : "hover:border-white/20"
                  }`}
                >
                  <Upload className="w-8 h-8 text-gray-500 mx-auto mb-3" />
                  {prdFile ? (
                    <p className="text-sm text-white">{prdFile.name}</p>
                  ) : (
                    <>
                      <p className="text-sm text-gray-300">Upload document</p>
                      <p className="text-xs text-gray-500 mt-1">
                        PDF, DOCX, TXT, or MD
                      </p>
                    </>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.docx,.txt,.md"
                    onChange={(e) => setPrdFile(e.target.files?.[0] ?? null)}
                    className="hidden"
                  />
                </div>
              </div>

              {/* Credits display removed - simplified to "1 free run" model */}
            </div>
          )}
        </div>
        )}
      </main>

      {/* Bottom nav bar - hidden when credits exhausted */}
      {!(credits !== null && credits <= 0) && (
      <div className="fixed bottom-0 left-0 right-0 border-t border-white/5 bg-[#0a0b14]/95 backdrop-blur-md">
        <div className="max-w-lg mx-auto px-6 py-4 flex items-center justify-between">
          <button
            onClick={handleBack}
            className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>

          <div className="flex items-center gap-3">
            {step >= 2 && (
              <button
                onClick={handleSkip}
                className="text-sm text-gray-400 hover:text-white transition-colors"
              >
                Skip
              </button>
            )}
            <button
              onClick={handleNext}
              disabled={!canContinue() || loading}
              className="btn-primary text-sm px-5 py-2.5"
            >
              {loading ? (
                "Creating..."
              ) : step === 3 ? (
                <>
                  Generate
                  <ArrowRight className="w-4 h-4" />
                </>
              ) : (
                <>
                  Continue
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
