import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Navigation */}
      <header className="border-b border-gray-100">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <span className="text-lg font-bold text-gray-900">DocuAgent</span>
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="bg-blue-600 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-3xl mx-auto px-4 py-24 text-center">
        <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 leading-tight">
          Documentation for your SaaS,
          <br />
          <span className="text-blue-600">generated in minutes</span>
        </h1>
        <p className="mt-6 text-lg text-gray-500 max-w-xl mx-auto">
          DocuAgent autonomously crawls your web application, captures every
          screen, and produces professional end-user documentation — complete
          with screenshots, field descriptions, and workflow guides.
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <Link
            href="/signup"
            className="bg-blue-600 text-white rounded-md px-6 py-3 text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Start for Free
          </Link>
          <Link
            href="#how-it-works"
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            See how it works &darr;
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="bg-gray-50 py-20">
        <div className="max-w-4xl mx-auto px-4">
          <h2 className="text-2xl font-bold text-gray-900 text-center mb-12">
            How it works
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
              <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 text-lg font-bold">
                1
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">
                Provide your app
              </h3>
              <p className="text-sm text-gray-500">
                Enter your app URL, login credentials, and optionally link your
                GitHub repo or upload a PRD for richer documentation.
              </p>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
              <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 text-lg font-bold">
                2
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">
                Agent crawls &amp; analyzes
              </h3>
              <p className="text-sm text-gray-500">
                Our AI agent logs in, navigates every screen, captures
                screenshots, and analyzes each page with vision AI and source
                code context.
              </p>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
              <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 text-lg font-bold">
                3
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">
                Download your docs
              </h3>
              <p className="text-sm text-gray-500">
                Get a professional .docx document with a cover page, table of
                contents, workflow guides, field references, and a glossary.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 text-center text-sm text-gray-400 border-t border-gray-100">
        DocuAgent &mdash; Autonomous SaaS Documentation Generator
      </footer>
    </div>
  );
}
