import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  // `npm run build` writes a static site to out/ that any file server can host.
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default withMDX(config);
