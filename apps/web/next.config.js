/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@docuagent/shared"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
};

module.exports = nextConfig;
