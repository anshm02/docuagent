import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DocuAgent — SaaS Documentation Generator",
  description:
    "Autonomously crawl your SaaS app and generate professional end-user documentation.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        {children}
      </body>
    </html>
  );
}
