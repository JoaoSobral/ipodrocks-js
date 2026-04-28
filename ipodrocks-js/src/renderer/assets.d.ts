// Asset module declarations for Vite ?url and plain imports.
// Must be a script file (no imports) so declarations are globally ambient.
declare module "@assets/*.png" {
  const src: string;
  export default src;
}
declare module "@assets/*.png?url" {
  const src: string;
  export default src;
}
declare module "@assets/*.svg" {
  const src: string;
  export default src;
}
declare module "@assets/*.svg?url" {
  const src: string;
  export default src;
}
