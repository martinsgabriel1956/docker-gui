// o esbuild carrega .css como texto (build.py: --loader:.css=text)
declare module '*.css' {
  const css: string;
  export default css;
}
