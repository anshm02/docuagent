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
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-[#0a0b14] text-gray-200 antialiased">
        {children}
      </body>
    </html>
  );
}
