"use client";

import Link from "next/link";
import { Camera, FileText, Map, Code, Sparkles, Mail } from "lucide-react";
import { useState } from "react";

const features = [
  {
    icon: Camera,
    title: "Automated Screenshots",
    description:
      "DocuAgent navigates your application and captures high-quality screenshots at key moments in user journeys. No manual work required\u2014just provide your app URL and watch the magic happen.",
  },
  {
    icon: FileText,
    title: "AI Documentation",
    description:
      "Our AI analyzes your codebase and PRD to generate clear, comprehensive documentation. Each guide is tailored to your app\u2019s specific workflows and features, ensuring accuracy and relevance.",
  },
  {
    icon: Map,
    title: "User Journey Mapping",
    description:
      "The agent understands your application structure and automatically identifies the most important user flows. From authentication to core features, every critical path is documented.",
  },
  {
    icon: Code,
    title: "MDX Export",
    description:
      "Generated documentation is structured as clean MDX files, ready to integrate into your existing docs site. Includes images, formatted text, and proper hierarchy\u2014no conversion needed.",
  },
];

export default function LandingPage() {
  const [email, setEmail] = useState("");

  return (
    <div className="min-h-screen bg-[#0a0b14]">
      {/* Navbar */}
      <header className="sticky top-0 z-50 border-b border-white/5 bg-[#0a0b14]/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="text-white font-bold text-lg tracking-tight">
            docuagent
          </Link>
          <Link
            href="/login"
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            Sign in
          </Link>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden">
        {/* Gradient glow behind hero */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-[600px] h-[400px] bg-blue-600/10 rounded-full blur-[120px]" />
        </div>

        <div className="relative max-w-4xl mx-auto px-6 pt-24 pb-16 text-center">
          {/* Beta badge */}
          <div className="inline-flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-full px-3 py-1 text-xs text-gray-400 mb-8">
            <Sparkles className="w-3 h-3 text-blue-400" />
            Beta
          </div>

          <h1 className="text-5xl sm:text-6xl font-extrabold text-white leading-tight tracking-tight">
            Documentation that
            <br />
            writes itself
          </h1>

          <p className="mt-6 text-lg text-gray-400 max-w-xl mx-auto leading-relaxed">
            Generate user documentation with screenshots automatically.
            Provide your app URL and let AI handle the rest.
          </p>

          <div className="mt-8 flex items-center justify-center gap-4">
            <Link href="/login" className="btn-primary text-sm">
              Try for free
              <span aria-hidden="true">&rarr;</span>
            </Link>
            <Link href="#how-it-works" className="btn-ghost text-sm">
              Contact us
            </Link>
          </div>
        </div>

        {/* Docs mockup preview */}
        <div className="max-w-4xl mx-auto px-6 pb-24">
          <div className="relative">
            {/* Browser chrome */}
            <div className="bg-[#111827] rounded-xl border border-white/10 overflow-hidden shadow-2xl shadow-blue-900/10">
              {/* Title bar */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-500/80" />
                  <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                  <div className="w-3 h-3 rounded-full bg-green-500/80" />
                </div>
                <div className="flex-1 flex justify-center">
                  <div className="bg-white/5 rounded-md px-4 py-1 text-xs text-gray-500">
                    docs.yourapp.com
                  </div>
                </div>
              </div>

              {/* Content mock */}
              <div className="flex min-h-[320px]">
                {/* Left sidebar */}
                <div className="w-44 border-r border-white/5 p-4 flex-shrink-0">
                  <p className="text-xs font-bold text-gray-500 mb-3">docuagent</p>
                  <div className="space-y-1">
                    {["Overview", "Quick Start", "User Journeys", "Authentication", "Creating Projects", "Screenshots", "Export & Share"].map(
                      (item, i) => (
                        <div
                          key={item}
                          className={`px-2 py-1.5 rounded-md text-xs ${
                            i === 2
                              ? "bg-blue-600/20 text-blue-400 font-medium"
                              : "text-gray-500"
                          }`}
                        >
                          {item}
                        </div>
                      )
                    )}
                  </div>
                </div>

                {/* Main content */}
                <div className="flex-1 p-6">
                  <h2 className="text-xl font-bold text-white mb-2">
                    Getting Started
                  </h2>
                  <p className="text-sm text-gray-400 mb-4 leading-relaxed">
                    Learn how to create your first documentation with automated
                    screenshots and AI-generated content.
                  </p>
                  <h3 className="text-sm font-semibold text-white mb-2">
                    Overview
                  </h3>
                  <p className="text-xs text-gray-500 mb-4 leading-relaxed">
                    DocuAgent analyzes your application and automatically generates
                    comprehensive documentation. Simply provide your app URL, and let
                    our AI agent navigate through key user journeys, capturing
                    screenshots and creating detailed guides.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-white/5 rounded-lg p-4 flex flex-col items-center justify-center h-20">
                      <div className="text-gray-600 text-xs mb-1">---</div>
                      <p className="text-[10px] text-gray-500">Login Flow</p>
                    </div>
                    <div className="bg-white/5 rounded-lg p-4 flex flex-col items-center justify-center h-20">
                      <div className="text-gray-600 text-xs mb-1">---</div>
                      <p className="text-[10px] text-gray-500">Dashboard View</p>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mt-4 leading-relaxed">
                    The agent intelligently determines the most important features and
                    workflows based on your codebase context and product requirements.
                  </p>
                </div>

                {/* Right sidebar - ON THIS PAGE */}
                <div className="w-36 border-l border-white/5 p-4 flex-shrink-0">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-3">
                    On this page
                  </p>
                  <div className="space-y-1.5">
                    {["Overview", "Prerequisites", "Installation", "Configuration"].map(
                      (item, i) => (
                        <p
                          key={item}
                          className={`text-xs ${
                            i === 0 ? "text-white font-medium" : "text-gray-500"
                          }`}
                        >
                          {item}
                        </p>
                      )
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="py-24">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-white">How it works</h2>
            <p className="mt-3 text-gray-400">
              AI-powered documentation generation that understands your application
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {features.map(({ icon: Icon, title, description }) => (
              <div
                key={title}
                className="glass-card p-6 hover:border-white/20 transition-colors"
              >
                <div className="w-10 h-10 rounded-lg bg-blue-600/10 border border-blue-500/20 flex items-center justify-center mb-4">
                  <Icon className="w-5 h-5 text-blue-400" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-2">
                  {title}
                </h3>
                <p className="text-sm text-gray-400 leading-relaxed">
                  {description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Stay in the loop */}
      <section className="py-24 border-t border-white/5">
        <div className="max-w-md mx-auto px-6 text-center">
          <h2 className="text-2xl font-bold text-white mb-3">
            Stay in the loop
          </h2>
          <p className="text-gray-400 text-sm mb-6">
            Get updates on new features and improvements.
          </p>
          <form
            onSubmit={(e) => e.preventDefault()}
            className="flex gap-3"
          >
            <div className="flex-1 relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="glass-input pl-10 text-sm"
              />
            </div>
            <button type="submit" className="btn-primary text-sm px-5">
              Subscribe
            </button>
          </form>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 text-center text-xs text-gray-600 border-t border-white/5">
        DocuAgent &mdash; Autonomous SaaS Documentation Generator
      </footer>
    </div>
  );
}
