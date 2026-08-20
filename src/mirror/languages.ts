/** Language identification and per-language comment syntax. */

export type CommentStyle = "c" | "hash" | "html" | "sql" | "none";

export interface LanguageSpec {
  id: string;
  label: string;
  comment: CommentStyle;
  /** Extensions tried when resolving an extensionless relative import. */
  resolveExtensions: string[];
  /** Basenames tried when a relative import points at a directory. */
  indexFiles: string[];
}

const JS_RESOLVE = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".vue", ".svelte", ".astro", ".css"];
const JS_INDEX = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs", "index.vue"];

const SPECS: Record<string, LanguageSpec> = {
  typescript: { id: "typescript", label: "TypeScript", comment: "c", resolveExtensions: JS_RESOLVE, indexFiles: JS_INDEX },
  javascript: { id: "javascript", label: "JavaScript", comment: "c", resolveExtensions: JS_RESOLVE, indexFiles: JS_INDEX },
  python: { id: "python", label: "Python", comment: "hash", resolveExtensions: [".py", ".pyi"], indexFiles: ["__init__.py"] },
  go: { id: "go", label: "Go", comment: "c", resolveExtensions: [".go"], indexFiles: [] },
  rust: { id: "rust", label: "Rust", comment: "c", resolveExtensions: [".rs"], indexFiles: ["mod.rs"] },
  java: { id: "java", label: "Java", comment: "c", resolveExtensions: [".java"], indexFiles: [] },
  kotlin: { id: "kotlin", label: "Kotlin", comment: "c", resolveExtensions: [".kt", ".kts"], indexFiles: [] },
  swift: { id: "swift", label: "Swift", comment: "c", resolveExtensions: [".swift"], indexFiles: [] },
  ruby: { id: "ruby", label: "Ruby", comment: "hash", resolveExtensions: [".rb"], indexFiles: [] },
  php: { id: "php", label: "PHP", comment: "c", resolveExtensions: [".php"], indexFiles: ["index.php"] },
  c: { id: "c", label: "C/C++", comment: "c", resolveExtensions: [".h", ".hpp", ".c", ".cc", ".cpp"], indexFiles: [] },
  csharp: { id: "csharp", label: "C#", comment: "c", resolveExtensions: [".cs"], indexFiles: [] },
  scala: { id: "scala", label: "Scala", comment: "c", resolveExtensions: [".scala"], indexFiles: [] },
  elixir: { id: "elixir", label: "Elixir", comment: "hash", resolveExtensions: [".ex", ".exs"], indexFiles: [] },
  shell: { id: "shell", label: "Shell", comment: "hash", resolveExtensions: [".sh", ".bash", ".zsh"], indexFiles: [] },
  css: { id: "css", label: "CSS", comment: "c", resolveExtensions: [".css", ".scss", ".sass", ".less"], indexFiles: ["index.css", "_index.scss"] },
  vue: { id: "vue", label: "Vue", comment: "html", resolveExtensions: JS_RESOLVE, indexFiles: JS_INDEX },
  svelte: { id: "svelte", label: "Svelte", comment: "html", resolveExtensions: JS_RESOLVE, indexFiles: JS_INDEX },
  markdown: { id: "markdown", label: "Markdown", comment: "html", resolveExtensions: [".md", ".mdx"], indexFiles: ["README.md", "index.md"] },
  json: { id: "json", label: "JSON", comment: "none", resolveExtensions: [".json"], indexFiles: [] },
  yaml: { id: "yaml", label: "YAML", comment: "hash", resolveExtensions: [".yaml", ".yml"], indexFiles: [] },
  toml: { id: "toml", label: "TOML", comment: "hash", resolveExtensions: [".toml"], indexFiles: [] },
  sql: { id: "sql", label: "SQL", comment: "sql", resolveExtensions: [".sql"], indexFiles: [] },
  graphql: { id: "graphql", label: "GraphQL", comment: "hash", resolveExtensions: [".graphql", ".gql"], indexFiles: [] },
  proto: { id: "proto", label: "Protobuf", comment: "c", resolveExtensions: [".proto"], indexFiles: [] },
  text: { id: "text", label: "Text", comment: "none", resolveExtensions: [], indexFiles: [] },
};

const BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin", ".kts": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c", ".h": "c", ".cc": "c", ".cpp": "c", ".hpp": "c",
  ".cs": "csharp",
  ".scala": "scala",
  ".ex": "elixir", ".exs": "elixir",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".css": "css", ".scss": "css", ".sass": "css", ".less": "css",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "javascript",
  ".md": "markdown", ".mdx": "markdown",
  ".json": "json",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml",
  ".sql": "sql",
  ".graphql": "graphql", ".gql": "graphql",
  ".proto": "proto",
  ".txt": "text",
};

const BY_BASENAME: Record<string, string> = {
  dockerfile: "shell",
  makefile: "shell",
  procfile: "shell",
  justfile: "shell",
  license: "text",
  readme: "markdown",
};

export function detectLanguage(relPath: string, ext: string): LanguageSpec {
  const byExt = BY_EXTENSION[ext.toLowerCase()];
  if (byExt) return SPECS[byExt]!;
  const base = relPath.split("/").pop()?.toLowerCase() ?? "";
  const byBase = BY_BASENAME[base.replace(/\.[^.]*$/, "")] ?? BY_BASENAME[base];
  if (byBase) return SPECS[byBase]!;
  return SPECS.text!;
}

export function languageById(id: string): LanguageSpec {
  return SPECS[id] ?? SPECS.text!;
}

/**
 * Blank out comments so commented-out imports do not become graph edges.
 *
 * Replacing with spaces rather than deleting keeps line numbers intact, which
 * matters because symbol positions are reported to the user.
 */
export function stripComments(source: string, style: CommentStyle): string {
  if (style === "none") return source;
  const blank = (match: string) => match.replace(/[^\n]/g, " ");

  if (style === "c") {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, blank)
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, prefix: string) => prefix + blank(m.slice(prefix.length)));
  }
  if (style === "hash") {
    return source.replace(/(^|\s)#[^\n]*/g, (m, prefix: string) => prefix + blank(m.slice(prefix.length)));
  }
  if (style === "html") {
    return source.replace(/<!--[\s\S]*?-->/g, blank);
  }
  if (style === "sql") {
    return source.replace(/--[^\n]*/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
  }
  return source;
}
