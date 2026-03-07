"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, Suspense } from "react";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const supabase = createClient();

    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    // If there's an explicit redirect, use it
    if (redirect) {
      router.push(redirect);
      router.refresh();
      return;
    }

    // Check if returning user has completed jobs
    if (data.user) {
      const { data: jobs } = await supabase
        .from("jobs")
        .select("id, status")
        .eq("user_id", data.user.id)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(1);

      if (jobs && jobs.length > 0) {
        router.push(`/jobs/${jobs[0].id}`);
        router.refresh();
        return;
      }
    }

    router.push("/new");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-[#0a0b14] flex flex-col">
      {/* Back link */}
      <div className="p-6">
        <button
          onClick={() => { window.location.href = "/"; }}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      </div>

      {/* Centered form */}
      <div className="flex-1 flex items-center justify-center px-4 -mt-16">
        <div className="w-full max-w-sm">
          <div className="glass-card p-8">
            <div className="text-center mb-6">
              <h1 className="text-2xl font-bold text-white">
                Welcome back
              </h1>
              <p className="text-gray-400 text-sm mt-1">
                Sign in to your account
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg p-3">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="glass-input text-sm"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="glass-input text-sm pr-10"
                    placeholder="Enter your password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full text-sm"
              >
                {loading ? "Signing in..." : "Sign in"}
              </button>
            </form>

          </div>

          <p className="text-center text-sm text-gray-500 mt-6">
            Don&apos;t have an account?{" "}
            <a
              href="/signup"
              className="text-blue-400 hover:text-blue-300 transition-colors"
            >
              Create one for free
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
