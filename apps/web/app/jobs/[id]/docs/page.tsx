"use client";

import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL!;

interface SidebarItem {
  title: string;
  slug: string;
}

interface JobData {
  id: string;
  app_name: string | null;
  app_url: string;
  result: {
    docs_url: string;
    zip_url: string;
    total_screens: number;
    avg_confidence: number;
    duration_seconds: number;
    journeys_completed: number;
    journeys_total: number;
    additional_journeys?: { title: string; description: string }[];
  } | null;
}

function parseIndexForSidebar(indexContent: string): SidebarItem[] {
  const items: SidebarItem[] = [];
  const linkRegex = /\[([^\]]+)\]\(\.\/([^)]+)\.md\)/g;
  let match;
  while ((match = linkRegex.exec(indexContent)) !== null) {
    items.push({ title: match[1], slug: match[2] });
  }
  return items;
}

function getStorageBasePath(jobId: string): string {
  return `docs/${jobId}`;
}

export default function DocsViewerPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<JobData | null>(null);
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);
  const [activeSlug, setActiveSlug] = useState("index");
  const [markdownContent, setMarkdownContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const supabase = createClient();

  // Fetch a markdown file from Supabase Storage
  const fetchMarkdown = useCallback(
    async (slug: string) => {
      setLoading(true);
      try {
        const basePath = getStorageBasePath(id);
        const filePath = `${basePath}/${slug}.md`;

        const { data, error: downloadErr } = await supabase.storage
          .from("documents")
          .download(filePath);

        if (downloadErr || !data) {
          setMarkdownContent(`# Not Found\n\nCould not load \`${slug}.md\`.`);
          setLoading(false);
          return;
        }

        let content = await data.text();

        // Rewrite relative image paths to Supabase Storage URLs
        const { data: storageUrl } = supabase.storage
          .from("documents")
          .getPublicUrl(`${basePath}/images/placeholder`);
        const imageBaseUrl = storageUrl.publicUrl.replace("/placeholder", "");

        content = content.replace(
          /!\[([^\]]*)\]\(\.\/images\/([^)]+)\)/g,
          `![$1](${imageBaseUrl}/$2)`,
        );

        setMarkdownContent(content);
      } catch {
        setMarkdownContent("# Error\n\nFailed to load documentation.");
      }
      setLoading(false);
    },
    [id, supabase],
  );

  // Fetch job data
  useEffect(() => {
    async function loadJob() {
      try {
        const res = await fetch(`${WORKER_URL}/api/jobs/${id}`);
        if (!res.ok) {
          setError("Job not found");
          return;
        }
        const data = await res.json();
        setJob(data);
      } catch {
        setError("Failed to load job");
      }
    }
    loadJob();
  }, [id]);

  // Load index.md for sidebar
  useEffect(() => {
    async function loadIndex() {
      try {
        const basePath = getStorageBasePath(id);
        const { data, error: downloadErr } = await supabase.storage
          .from("documents")
          .download(`${basePath}/index.md`);

        if (downloadErr || !data) {
          setError("Documentation not found. The job may still be processing.");
          return;
        }

        const indexContent = await data.text();
        const items = parseIndexForSidebar(indexContent);
        setSidebarItems(items);

        // Load index.md as initial content
        setMarkdownContent(indexContent);
        setLoading(false);
      } catch {
        setError("Failed to load documentation index.");
      }
    }
    loadIndex();
  }, [id, supabase]);

  // Handle sidebar navigation
  const handleNavClick = (slug: string) => {
    setActiveSlug(slug);
    if (slug === "index") {
      // Re-fetch index
      fetchMarkdown("index");
    } else {
      fetchMarkdown(slug);
    }
  };

  // Handle internal markdown links
  const handleLinkClick = (href: string) => {
    if (href.startsWith("./") && href.endsWith(".md")) {
      const slug = href.replace("./", "").replace(".md", "");
      setActiveSlug(slug);
      fetchMarkdown(slug);
    }
  };

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <Link href={`/jobs/${id}`} className="text-blue-600 hover:underline">
            Back to Job Status
          </Link>
        </div>
      </div>
    );
  }

  const appName = job?.app_name || "Documentation";

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href={`/jobs/${id}`}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <h1 className="text-lg font-semibold text-gray-900">
              {appName}
            </h1>
            <span className="text-sm text-gray-400">Documentation</span>
          </div>
          <div className="flex items-center gap-3">
            {job?.result?.zip_url && (
              <a
                href={job.result.zip_url}
                download
                className="inline-flex items-center gap-2 bg-gray-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-gray-800 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Download .zip
              </a>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1 max-w-7xl mx-auto w-full">
        {/* Sidebar */}
        <aside className="w-64 border-r border-gray-100 bg-gray-50/50 p-4 overflow-y-auto sticky top-[57px] h-[calc(100vh-57px)]">
          <nav className="space-y-1">
            <button
              onClick={() => handleNavClick("index")}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                activeSlug === "index"
                  ? "bg-gray-900 text-white font-medium"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              Overview
            </button>

            {sidebarItems.map((item) => (
              <button
                key={item.slug}
                onClick={() => handleNavClick(item.slug)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                  activeSlug === item.slug
                    ? "bg-gray-900 text-white font-medium"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                {item.title}
              </button>
            ))}
          </nav>

          {/* Additional journeys upsell */}
          {job?.result?.additional_journeys && job.result.additional_journeys.length > 0 && (
            <div className="mt-6 pt-4 border-t border-gray-200">
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wide px-3 mb-2">
                Available with upgrade
              </p>
              {job.result.additional_journeys.map((j, i) => (
                <div
                  key={i}
                  className="px-3 py-2 text-sm text-gray-400 cursor-not-allowed"
                  title={j.description}
                >
                  {j.title}
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* Main content */}
        <main className="flex-1 p-8 max-w-3xl">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="animate-pulse text-gray-400">Loading...</div>
            </div>
          ) : (
            <article className="prose prose-gray max-w-none prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-img:rounded-lg prose-img:border prose-img:border-gray-200 prose-img:shadow-sm prose-table:text-sm prose-th:bg-gray-50 prose-th:font-medium prose-td:border-gray-200 prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline prose-blockquote:border-blue-300 prose-blockquote:bg-blue-50/50 prose-blockquote:py-1 prose-blockquote:not-italic">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children, ...props }) => {
                    if (href && href.startsWith("./") && href.endsWith(".md")) {
                      return (
                        <a
                          {...props}
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            handleLinkClick(href);
                          }}
                          className="text-blue-600 hover:underline cursor-pointer"
                        >
                          {children}
                        </a>
                      );
                    }
                    return (
                      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                        {children}
                      </a>
                    );
                  },
                  img: ({ src, alt, ...props }) => {
                    return (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={src}
                        alt={alt || "Screenshot"}
                        loading="lazy"
                        className="rounded-lg border border-gray-200 shadow-sm my-4"
                        {...props}
                      />
                    );
                  },
                }}
              />
            </article>
          )}
        </main>
      </div>
    </div>
  );
}
