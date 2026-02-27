"use client";

import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, Lock } from "lucide-react";

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL!;

interface SidebarItem {
  title: string;
  slug: string;
}

interface TocItem {
  id: string;
  text: string;
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
    features_documented: number;
    features_total: number;
    additional_features?: { title: string; description: string }[];
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

function extractHeadings(markdown: string): TocItem[] {
  const headings: TocItem[] = [];
  const lines = markdown.split("\n");
  for (const line of lines) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      const text = match[1].trim();
      const id = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-");
      headings.push({ id, text });
    }
  }
  return headings;
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
  const [activeHeading, setActiveHeading] = useState("");
  const [imageBaseUrl, setImageBaseUrl] = useState("");

  // Memoize supabase client to avoid recreating on every render
  const supabase = useMemo(() => createClient(), []);

  // Extract h2 headings for "ON THIS PAGE" sidebar
  const tocItems = useMemo(() => extractHeadings(markdownContent), [markdownContent]);

  // Compute image base URL once
  useEffect(() => {
    const basePath = getStorageBasePath(id);
    const { data: storageUrl } = supabase.storage
      .from("documents")
      .getPublicUrl(`${basePath}/images/placeholder`);
    setImageBaseUrl(storageUrl.publicUrl.replace("/placeholder", ""));
  }, [id, supabase]);

  // Fetch a markdown file from Supabase Storage
  const fetchMarkdown = useCallback(
    async (slug: string) => {
      setLoading(true);
      setError("");
      try {
        const basePath = getStorageBasePath(id);
        const filePath = `${basePath}/${slug}.md`;

        const { data, error: downloadErr } = await supabase.storage
          .from("documents")
          .download(filePath);

        if (downloadErr || !data) {
          console.error("Download error:", downloadErr);
          // Try alternative path patterns
          const altPath = `${basePath}/${slug}`;
          const { data: altData, error: altErr } = await supabase.storage
            .from("documents")
            .download(altPath);

          if (altErr || !altData) {
            setMarkdownContent(`# Not Found\n\nCould not load \`${slug}.md\`. The file may not exist yet.`);
            setLoading(false);
            return;
          }

          let content = await altData.text();
          content = rewriteImagePaths(content);
          setMarkdownContent(content);
          setLoading(false);
          return;
        }

        let content = await data.text();
        content = rewriteImagePaths(content);
        setMarkdownContent(content);
      } catch (err) {
        console.error("Failed to fetch markdown:", err);
        setMarkdownContent("# Error\n\nFailed to load documentation.");
      }
      setLoading(false);
    },
    [id, supabase, imageBaseUrl],
  );

  function rewriteImagePaths(content: string): string {
    if (!imageBaseUrl) return content;
    return content.replace(
      /!\[([^\]]*)\]\(\.\/images\/([^)]+)\)/g,
      `![$1](${imageBaseUrl}/$2)`,
    );
  }

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

  // Load index.md for sidebar and initial content
  useEffect(() => {
    async function loadIndex() {
      try {
        const basePath = getStorageBasePath(id);

        // First try to list files to confirm docs exist
        const { data: fileList, error: listErr } = await supabase.storage
          .from("documents")
          .list(basePath);

        if (listErr) {
          console.error("List error:", listErr);
        }

        if (fileList) {
          console.log("Files found in storage:", fileList.map(f => f.name));
        }

        // Download index.md
        const { data, error: downloadErr } = await supabase.storage
          .from("documents")
          .download(`${basePath}/index.md`);

        if (downloadErr || !data) {
          console.error("Index download error:", downloadErr);

          // If index.md doesn't exist, try to find any .md files and build navigation
          if (fileList && fileList.length > 0) {
            const mdFiles = fileList.filter(f => f.name.endsWith(".md"));
            if (mdFiles.length > 0) {
              const items = mdFiles
                .filter(f => f.name !== "index.md")
                .map(f => ({
                  title: f.name.replace(".md", "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
                  slug: f.name.replace(".md", ""),
                }));
              setSidebarItems(items);

              // Load the first available file
              const firstFile = mdFiles[0];
              await fetchMarkdown(firstFile.name.replace(".md", ""));
              setActiveSlug(firstFile.name.replace(".md", ""));
              return;
            }
          }

          setError("Documentation not found. The job may still be processing.");
          setLoading(false);
          return;
        }

        const indexContent = await data.text();
        const items = parseIndexForSidebar(indexContent);
        setSidebarItems(items);

        // Load index content with image path rewriting
        let content = indexContent;
        if (imageBaseUrl) {
          content = content.replace(
            /!\[([^\]]*)\]\(\.\/images\/([^)]+)\)/g,
            `![$1](${imageBaseUrl}/$2)`,
          );
        }
        setMarkdownContent(content);
        setLoading(false);
      } catch (err) {
        console.error("Failed to load index:", err);
        setError("Failed to load documentation index.");
        setLoading(false);
      }
    }
    if (imageBaseUrl) {
      loadIndex();
    }
  }, [id, supabase, imageBaseUrl, fetchMarkdown]);

  // Handle sidebar navigation
  const handleNavClick = (slug: string) => {
    setActiveSlug(slug);
    if (slug === "index") {
      fetchMarkdown("index");
    } else {
      fetchMarkdown(slug);
    }
    // Scroll main content to top
    document.getElementById("docs-main")?.scrollTo(0, 0);
  };

  // Handle internal markdown links
  const handleLinkClick = (href: string) => {
    if (href.startsWith("./") && href.endsWith(".md")) {
      const slug = href.replace("./", "").replace(".md", "");
      setActiveSlug(slug);
      fetchMarkdown(slug);
    }
  };

  // Scroll to heading
  const scrollToHeading = (headingId: string) => {
    setActiveHeading(headingId);
    const el = document.getElementById(headingId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  if (error) {
    return (
      <div className="min-h-screen bg-[#0a0b14] flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <Link href={`/jobs/${id}`} className="text-blue-400 hover:text-blue-300 transition-colors">
            Back to Job Status
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0d0e1a] flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/5 bg-[#0d0e1a]/95 backdrop-blur-md">
        <div className="flex items-center justify-between px-6 h-14">
          <Link href="/" className="text-white font-bold text-lg tracking-tight">
            docuagent
          </Link>
          <div className="flex items-center gap-3">
            {job?.result?.zip_url && (
              <a
                href={job.result.zip_url}
                download
                className="btn-ghost text-xs py-2 px-4"
              >
                <Download className="w-3.5 h-3.5" />
                Download .zip
              </a>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar - navigation */}
        <aside className="w-52 flex-shrink-0 border-r border-white/5 overflow-y-auto h-[calc(100vh-56px)] sticky top-14 p-4">
          <nav className="space-y-0.5">
            <button
              onClick={() => handleNavClick("index")}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                activeSlug === "index"
                  ? "bg-blue-600/15 text-blue-400 font-medium"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
              }`}
            >
              Overview
            </button>

            {sidebarItems.map((item) => (
              <button
                key={item.slug}
                onClick={() => handleNavClick(item.slug)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeSlug === item.slug
                    ? "bg-blue-600/15 text-blue-400 font-medium"
                    : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                }`}
              >
                {item.title}
              </button>
            ))}
          </nav>

          {/* Additional features upsell */}
          {job?.result?.additional_features &&
            job.result.additional_features.length > 0 && (
              <div className="mt-6 pt-4 border-t border-white/5">
                <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider px-3 mb-2 flex items-center gap-1">
                  <Lock className="w-3 h-3" />
                  Also in full version
                </p>
                {job.result.additional_features.map((f, i) => (
                  <div
                    key={i}
                    className="px-3 py-2 text-sm text-gray-600 cursor-not-allowed"
                    title={f.description}
                  >
                    {f.title}
                  </div>
                ))}
              </div>
            )}
        </aside>

        {/* Main content */}
        <main
          id="docs-main"
          className="flex-1 overflow-y-auto h-[calc(100vh-56px)] px-12 py-8"
        >
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="flex gap-1">
                <div className="w-2 h-2 rounded-full bg-blue-400 thinking-dot" />
                <div className="w-2 h-2 rounded-full bg-blue-400 thinking-dot" />
                <div className="w-2 h-2 rounded-full bg-blue-400 thinking-dot" />
              </div>
            </div>
          ) : (
            <article className="dark-prose prose prose-invert max-w-3xl prose-headings:font-bold prose-h1:text-3xl prose-h2:text-2xl prose-h3:text-lg prose-p:leading-relaxed prose-a:no-underline hover:prose-a:underline prose-table:text-sm prose-li:text-gray-300">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h2: ({ children, ...props }) => {
                    const text = typeof children === "string"
                      ? children
                      : Array.isArray(children)
                        ? children.map(c => (typeof c === "string" ? c : "")).join("")
                        : "";
                    const headingId = text
                      .toLowerCase()
                      .replace(/[^\w\s-]/g, "")
                      .replace(/\s+/g, "-");
                    return (
                      <h2 id={headingId} {...props}>
                        {children}
                      </h2>
                    );
                  },
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
                          className="text-blue-400 hover:text-blue-300 cursor-pointer"
                        >
                          {children}
                        </a>
                      );
                    }
                    return (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300"
                        {...props}
                      >
                        {children}
                      </a>
                    );
                  },
                  img: ({ src, alt, ...props }) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={src}
                      alt={alt || "Screenshot"}
                      loading="lazy"
                      className="rounded-xl border border-white/10 my-6 w-full"
                      {...props}
                    />
                  ),
                  table: ({ children, ...props }) => (
                    <div className="overflow-x-auto my-4">
                      <table className="w-full" {...props}>
                        {children}
                      </table>
                    </div>
                  ),
                  blockquote: ({ children, ...props }) => (
                    <blockquote
                      className="border-l-2 border-blue-500 bg-blue-500/5 rounded-r-lg px-4 py-3 my-4 not-italic"
                      {...props}
                    >
                      {children}
                    </blockquote>
                  ),
                }}
              >
                {markdownContent}
              </ReactMarkdown>
            </article>
          )}
        </main>

        {/* Right sidebar - ON THIS PAGE */}
        {tocItems.length > 0 && (
          <aside className="w-44 flex-shrink-0 border-l border-white/5 overflow-y-auto h-[calc(100vh-56px)] sticky top-14 p-4">
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-3">
              On this page
            </p>
            <nav className="space-y-1">
              {tocItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => scrollToHeading(item.id)}
                  className={`block w-full text-left text-xs py-1 transition-colors ${
                    activeHeading === item.id
                      ? "text-white font-medium"
                      : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {item.text}
                </button>
              ))}
            </nav>
          </aside>
        )}
      </div>
    </div>
  );
}
