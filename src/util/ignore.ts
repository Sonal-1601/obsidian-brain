/**
 * A small, dependency-free .gitignore matcher.
 *
 * Supports the subset of gitignore syntax that actually shows up in real
 * projects: comments, negation (`!`), anchoring (leading or embedded `/`),
 * directory-only rules (trailing `/`), `*`, `?`, `**`, and character classes.
 * Rules are scoped to the directory of the .gitignore that declared them, so
 * nested ignore files behave correctly.
 *
 * Last matching rule wins, matching git's own precedence.
 */

export interface IgnoreRule {
  /** Directory (project-relative, posix, "" for root) the rule is scoped to. */
  base: string;
  regex: RegExp;
  negated: boolean;
  directoryOnly: boolean;
  source: string;
}

function escapeLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Translate one gitignore glob into an anchored regular expression. */
function globToRegex(pattern: string, anchored: boolean): RegExp {
  let out = anchored ? "^" : "^(?:.*/)?";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === "*") {
      const isDouble = pattern[i + 1] === "*";
      if (isDouble) {
        const nextIsSlash = pattern[i + 2] === "/";
        if (nextIsSlash) {
          // `a/**/b` should also match `a/b`
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
        i += 1;
        continue;
      }
      let cls = pattern.slice(i, close + 1);
      cls = cls.replace(/^\[!/, "[^");
      out += cls;
      i = close + 1;
      continue;
    }
    if (char === "\\" && i + 1 < pattern.length) {
      out += escapeLiteral(pattern[i + 1]!);
      i += 2;
      continue;
    }
    out += escapeLiteral(char);
    i += 1;
  }
  // A rule matches the path itself and everything beneath it.
  out += "(?:/.*)?$";
  return new RegExp(out);
}

/** Parse the contents of one .gitignore file into rules scoped to `base`. */
export function parseIgnoreFile(contents: string, base = ""): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const rule = parseIgnoreLine(rawLine, base);
    if (rule) rules.push(rule);
  }
  return rules;
}

export function parseIgnoreLine(rawLine: string, base = ""): IgnoreRule | null {
  let line = rawLine;
  if (!line.trim() || line.trimStart().startsWith("#")) return null;
  // Trailing whitespace is insignificant unless escaped.
  line = line.replace(/(?<!\\)\s+$/, "");
  if (!line) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!")) {
    line = line.slice(1);
  }

  let directoryOnly = false;
  if (line.endsWith("/")) {
    directoryOnly = true;
    line = line.slice(0, -1);
  }

  let anchored = false;
  if (line.startsWith("/")) {
    anchored = true;
    line = line.slice(1);
  } else if (line.slice(0, -1).includes("/")) {
    // An embedded slash anchors the pattern to the ignore file's directory.
    anchored = true;
  }
  if (!line) return null;

  return {
    base,
    regex: globToRegex(line, anchored),
    negated,
    directoryOnly,
    source: rawLine,
  };
}

/**
 * An ordered collection of rules from one or more ignore files, plus any
 * extra patterns supplied by configuration.
 */
export class IgnoreSet {
  private rules: IgnoreRule[] = [];

  add(rules: IgnoreRule[]): void {
    this.rules.push(...rules);
  }

  addPatterns(patterns: string[], base = ""): void {
    for (const pattern of patterns) {
      const rule = parseIgnoreLine(pattern, base);
      if (rule) this.rules.push(rule);
    }
  }

  get size(): number {
    return this.rules.length;
  }

  /**
   * @param relPath project-relative posix path
   * @param isDirectory whether the path is a directory
   */
  ignores(relPath: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      // Rules only apply at or below the directory that declared them.
      let candidate = relPath;
      if (rule.base) {
        const prefix = `${rule.base}/`;
        if (!relPath.startsWith(prefix)) continue;
        candidate = relPath.slice(prefix.length);
      }
      if (rule.regex.test(candidate)) ignored = !rule.negated;
    }
    return ignored;
  }

  /** A child set that inherits current rules — used when descending a tree. */
  clone(): IgnoreSet {
    const next = new IgnoreSet();
    next.rules = [...this.rules];
    return next;
  }
}
