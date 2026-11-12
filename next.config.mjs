/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep Turbopack and output tracing scoped to this checkout, even when it
  // lives beside another app with its own lockfile.
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  images: { remotePatterns: [{ protocol: "https", hostname: "i.ytimg.com" }] },
};

export default nextConfig;
