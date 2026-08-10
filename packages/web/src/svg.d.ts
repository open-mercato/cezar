// Vite serves `.svg` imports as a URL string (its default asset handling). Declared here so the
// TypeScript build knows the shape without pulling in the whole `vite/client` ambient set.
declare module '*.svg' {
  const src: string
  export default src
}
