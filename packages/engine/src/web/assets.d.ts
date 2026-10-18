// Vite's `?url` imports: the asset's public URL (vite/client declares the same).
declare module '*?url' {
  const url: string;
  export default url;
}
