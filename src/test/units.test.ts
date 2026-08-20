import { test, describe, after } from "node:test";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import assert from "node:assert/strict";
import { IgnoreSet, parseIgnoreFile } from "../util/ignore.js";
import {
  applyManagedBody,
  extractLinks,
  extractTags,
  parseNote,
  stringifyNote,
  stripManagedBody,
  wikilink,
} from "../util/markdown.js";
import { pathToNoteName, sanitizeName, tagSegment } from "../util/slug.js";
import { analyze } from "../mirror/analyzer.js";
import { resolveImport, packageNameOf, isNodeBuiltin } from "../mirror/resolver.js";
import { languageById } from "../mirror/languages.js";
import { computeMetrics, localGraph } from "../graph/metrics.js";
import type { GraphEdge, GraphNode } from "../graph/build.js";
import { Vault } from "../vault/vault.js";
import { loadConfig } from "../config.js";

describe("gitignore matching", () => {
  const set = (patterns: string) => {
    const s = new IgnoreSet();
    s.add(parseIgnoreFile(patterns));
    return s;
  };

  test("matches a bare name at any depth", () => {
    const s = set("node_modules\n");
    assert.equal(s.ignores("node_modules", true), true);
    assert.equal(s.ignores("packages/app/node_modules", true), true);
    assert.equal(s.ignores("src/index.ts", false), false);
  });

  test("anchors patterns that start with a slash", () => {
    const s = set("/dist\n");
    assert.equal(s.ignores("dist", true), true);
    assert.equal(s.ignores("packages/dist", true), false);
  });

  test("directory-only rules do not match files", () => {
    const s = set("build/\n");
    assert.equal(s.ignores("build", true), true);
    assert.equal(s.ignores("build", false), false);
  });

  test("negation re-includes a previously ignored path", () => {
    const s = set("*.log\n!important.log\n");
    assert.equal(s.ignores("debug.log", false), true);
    assert.equal(s.ignores("important.log", false), false);
  });

  test("ignoring a directory covers everything beneath it", () => {
    const s = set("coverage\n");
    assert.equal(s.ignores("coverage/lcov/index.html", false), true);
  });

  test("double-star crosses directories and also matches zero of them", () => {
    const s = set("a/**/b\n");
    assert.equal(s.ignores("a/b", false), true);
    assert.equal(s.ignores("a/x/y/b", false), true);
    assert.equal(s.ignores("a/x/y/c", false), false);
  });

  test("comments and blank lines are skipped", () => {
    const s = set("# a comment\n\n*.tmp\n");
    assert.equal(s.ignores("x.tmp", false), true);
    assert.equal(s.ignores("a comment", false), false);
  });

  test("nested ignore files only apply beneath their own directory", () => {
    const s = new IgnoreSet();
    s.add(parseIgnoreFile("secret.txt\n", "packages/api"));
    assert.equal(s.ignores("packages/api/secret.txt", false), true);
    assert.equal(s.ignores("packages/web/secret.txt", false), false);
  });
});

describe("frontmatter and managed regions", () => {
  test("round-trips frontmatter without losing unknown keys", () => {
    const raw = "---\ntitle: Hello\ncustom: 42\n---\n\nBody text\n";
    const parsed = parseNote(raw);
    assert.equal(parsed.frontmatter.title, "Hello");
    assert.equal(parsed.frontmatter.custom, 42);
    const out = stringifyNote(parsed.frontmatter, parsed.body);
    assert.match(out, /custom: 42/);
    assert.match(out, /Body text/);
  });

  test("a note with no frontmatter is left intact", () => {
    const parsed = parseNote("# Just a heading\n");
    assert.equal(parsed.hadFrontmatter, false);
    assert.equal(parsed.body, "# Just a heading\n");
  });

  test("malformed YAML does not lose the body", () => {
    const parsed = parseNote("---\n: : : bad\n\tmore: [\n---\n\nSurvives\n");
    assert.match(parsed.body, /Survives/);
  });

  test("replacing the managed block preserves surrounding prose", () => {
    const first = applyManagedBody(null, "generated v1");
    const withProse = `${first}\n## My notes\n\nHand written.\n`;
    const second = applyManagedBody(withProse, "generated v2");
    assert.match(second, /generated v2/);
    assert.doesNotMatch(second, /generated v1/);
    assert.match(second, /Hand written\./);
  });

  test("prose written before the managed block also survives", () => {
    const body = `Intro paragraph.\n\n<!-- sbv:begin -->\nold\n<!-- sbv:end -->\n\nOutro.\n`;
    const next = applyManagedBody(body, "new");
    assert.match(next, /Intro paragraph\./);
    assert.match(next, /Outro\./);
    assert.match(next, /new/);
  });

  test("stripManagedBody returns only the human's writing", () => {
    const body = applyManagedBody(null, "generated") + "\nMine.\n";
    assert.equal(stripManagedBody(body), "Mine.");
  });
});

describe("link and tag extraction", () => {
  test("finds wikilinks, aliases, and markdown links", () => {
    const links = extractLinks("See [[Foo/Bar|Bar]] and [other](./other.md) and ![[Img]]");
    const targets = links.map((l) => l.target);
    assert.ok(targets.includes("Foo/Bar"));
    assert.ok(targets.includes("./other"));
    assert.ok(targets.includes("Img"));
  });

  test("ignores links inside code fences and inline code", () => {
    const links = extractLinks("```\n[[NotALink]]\n```\nand `[[AlsoNot]]` here");
    assert.equal(links.length, 0);
  });

  test("skips external URLs", () => {
    const links = extractLinks("[site](https://example.com)");
    assert.equal(links.length, 0);
  });

  test("collects tags from frontmatter and body", () => {
    const tags = extractTags("Some #inline/tag here", { tags: ["from-fm"] });
    assert.ok(tags.includes("from-fm"));
    assert.ok(tags.includes("inline/tag"));
  });

  test("wikilink escapes characters that would break the link", () => {
    assert.equal(wikilink("A|B", "Alias"), "[[AB|Alias]]");
    assert.equal(wikilink("Same", "Same"), "[[Same]]");
  });
});

describe("note naming", () => {
  test("flattens a path into a unique basename", () => {
    assert.equal(pathToNoteName("src/mirror/scanner.ts"), "src.mirror.scanner.ts");
  });

  test("strips characters Obsidian forbids", () => {
    assert.equal(sanitizeName('a:b*c?d"e<f>g|h'), "a-b-c-d-e-f-g-h");
  });

  test("tag segments drop illegal characters", () => {
    assert.equal(tagSegment("src/My Module!"), "src/my-module");
  });
});

describe("source analysis", () => {
  test("extracts TypeScript imports of every form", () => {
    const source = [
      "import a from './a.js';",
      "import { b } from '../b';",
      "export { c } from './c';",
      "const d = require('pkg-d');",
      "const e = await import('pkg-e');",
      "import 'side-effect';",
    ].join("\n");
    const result = analyze("src/x.ts", ".ts", source);
    const specs = result.imports.map((i) => i.specifier);
    for (const expected of ["./a.js", "../b", "./c", "pkg-d", "pkg-e", "side-effect"]) {
      assert.ok(specs.includes(expected), `missing ${expected}`);
    }
  });

  test("ignores imports that are commented out", () => {
    const result = analyze("src/x.ts", ".ts", "// import x from 'ghost';\nimport y from 'real';");
    const specs = result.imports.map((i) => i.specifier);
    assert.ok(specs.includes("real"));
    assert.ok(!specs.includes("ghost"));
  });

  test("ignores imports inside block comments", () => {
    const result = analyze("src/x.ts", ".ts", "/*\nimport x from 'ghost';\n*/\nimport y from 'real';");
    assert.ok(!result.imports.some((i) => i.specifier === "ghost"));
  });

  test("finds exported symbols and marks visibility", () => {
    const source = "export function alpha() {}\nfunction beta() {}\nexport class Gamma {}";
    const result = analyze("src/x.ts", ".ts", source);
    const alpha = result.symbols.find((s) => s.name === "alpha");
    const beta = result.symbols.find((s) => s.name === "beta");
    assert.equal(alpha?.exported, true);
    assert.equal(beta?.exported, false);
    assert.ok(result.symbols.some((s) => s.name === "Gamma" && s.kind === "class"));
  });

  test("handles Python imports and top-level definitions", () => {
    const source = "from .local import thing\nimport os, sys\n\ndef run():\n    pass\n\nclass Thing:\n    def method(self):\n        pass\n";
    const result = analyze("app/main.py", ".py", source);
    const specs = result.imports.map((i) => i.specifier);
    assert.ok(specs.includes(".local"));
    assert.ok(specs.includes("os"));
    assert.ok(specs.includes("sys"));
    assert.ok(result.symbols.some((s) => s.name === "run" && s.kind === "function"));
    assert.ok(result.symbols.some((s) => s.name === "method" && s.kind === "method"));
  });

  test("reads dependencies out of package.json", () => {
    const source = JSON.stringify({ dependencies: { left: "1" }, devDependencies: { right: "2" } });
    const result = analyze("package.json", ".json", source);
    assert.deepEqual(result.declaredDependencies.sort(), ["left", "right"]);
  });

  test("collects TODO markers with line numbers", () => {
    const result = analyze("src/x.ts", ".ts", "const a = 1;\n// TODO: fix this later\n");
    assert.equal(result.todos.length, 1);
    assert.equal(result.todos[0]?.line, 2);
    assert.match(result.todos[0]?.text ?? "", /fix this later/);
  });

  test("captures a leading docblock as the summary", () => {
    const result = analyze("src/x.ts", ".ts", "/**\n * Does a thing.\n */\nexport const x = 1;");
    assert.match(result.summary ?? "", /Does a thing/);
  });
});

describe("import resolution", () => {
  const ctx = {
    knownFiles: new Set([
      "src/a.ts",
      "src/b/index.ts",
      "src/c.tsx",
      "styles/_vars.scss",
      "app/pkg/mod.py",
      "app/pkg/__init__.py",
    ]),
    knownDirs: new Set(["src", "src/b", "styles", "app", "app/pkg"]),
  };
  const ts = languageById("typescript");

  const imp = (specifier: string) => ({ specifier, kind: specifier.startsWith(".") ? ("relative" as const) : ("package" as const), line: 1 });

  test("resolves a relative import with an implied extension", () => {
    const result = resolveImport(imp("./a"), "src/entry.ts", ts, ctx);
    assert.equal(result.kind, "internal");
    assert.equal(result.kind === "internal" && result.target, "src/a.ts");
  });

  test("maps a NodeNext .js specifier back to its .ts source", () => {
    const result = resolveImport(imp("./a.js"), "src/entry.ts", ts, ctx);
    assert.equal(result.kind === "internal" && result.target, "src/a.ts");
  });

  test("resolves a directory import to its index file", () => {
    const result = resolveImport(imp("./b"), "src/entry.ts", ts, ctx);
    assert.equal(result.kind === "internal" && result.target, "src/b/index.ts");
  });

  test("treats an unknown bare specifier as an external package", () => {
    const result = resolveImport(imp("react"), "src/entry.ts", ts, ctx);
    assert.equal(result.kind, "package");
  });

  test("resolves sass partials written without the underscore", () => {
    const css = languageById("css");
    const result = resolveImport(imp("./vars"), "styles/main.scss", css, ctx);
    assert.equal(result.kind === "internal" && result.target, "styles/_vars.scss");
  });

  test("resolves relative Python imports through the package", () => {
    const py = languageById("python");
    const result = resolveImport(
      { specifier: ".mod", kind: "relative", line: 1 },
      "app/pkg/main.py",
      py,
      ctx,
    );
    assert.equal(result.kind === "internal" && result.target, "app/pkg/mod.py");
  });

  test("identifies scoped package names and node builtins", () => {
    assert.equal(packageNameOf("@scope/pkg/deep"), "@scope/pkg");
    assert.equal(packageNameOf("lodash/get"), "lodash");
    assert.equal(isNodeBuiltin("node:fs"), true);
    assert.equal(isNodeBuiltin("path"), true);
    assert.equal(isNodeBuiltin("express"), false);
  });
});

describe("graph metrics", () => {
  const node = (id: string, inDeg = 0, outDeg = 0): GraphNode => ({
    id,
    name: id,
    label: id,
    kind: "note",
    tags: [],
    folder: "",
    userBytes: 0,
    size: 0,
    mtimeMs: 0,
    outDegree: outDeg,
    inDegree: inDeg,
    phantom: false,
  });
  const edge = (source: string, target: string): GraphEdge => ({
    source,
    target,
    resolved: true,
    embed: false,
  });

  test("counts components and finds orphans", () => {
    const nodes = [node("a", 0, 1), node("b", 1, 0), node("island")];
    const edges = [edge("a", "b")];
    const metrics = computeMetrics(nodes, edges);
    assert.equal(metrics.componentCount, 2);
    assert.equal(metrics.largestComponent, 2);
    assert.deepEqual(metrics.orphans, ["island"]);
  });

  test("ranks a hub above a leaf", () => {
    const nodes = [node("hub", 3, 0), node("x", 0, 1), node("y", 0, 1), node("z", 0, 1)];
    const edges = [edge("x", "hub"), edge("y", "hub"), edge("z", "hub")];
    const metrics = computeMetrics(nodes, edges);
    assert.equal(metrics.hubs[0]?.id, "hub");
    assert.ok((metrics.pagerank.hub ?? 0) > (metrics.pagerank.x ?? 0));
  });

  test("local graph respects the requested depth", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];
    const depth1 = localGraph(nodes, edges, "a", 1);
    assert.deepEqual(depth1.nodes.map((n) => n.id).sort(), ["a", "b"]);
    const depth2 = localGraph(nodes, edges, "a", 2);
    assert.deepEqual(depth2.nodes.map((n) => n.id).sort(), ["a", "b", "c"]);
  });

  test("an empty graph does not throw", () => {
    const metrics = computeMetrics([], []);
    assert.equal(metrics.nodeCount, 0);
    assert.equal(metrics.averageDegree, 0);
  });
});

describe("vault note ids", () => {
  const tmpVault = path.join(os.tmpdir(), `sbv-test-${process.pid}`);

  const makeVault = async () => {
    const config = await loadConfig({ cwd: tmpVault, overrides: { vault: { path: tmpVault } } });
    return new Vault(config);
  };

  after(async () => {
    await fs.rm(tmpVault, { recursive: true, force: true });
  });

  test("a note whose name ends in .md round-trips between id and path", async () => {
    const vault = await makeVault();
    await vault.ensure({ writeObsidian: false });

    // Mirroring a repository README produces exactly this shape, and getting it
    // wrong makes each sync create the note and the next one prune it.
    const result = await vault.upsertManaged({
      folder: "Codebase/Files",
      name: "README.md",
      kind: "file",
      managedBody: "# README.md",
    });
    assert.equal(result.status, "created");
    assert.equal(result.ref.id, "Codebase/Files/README.md");

    const listed = await vault.listNotes("Codebase/Files");
    const ids = listed.map((n) => n.id);
    assert.ok(ids.includes("Codebase/Files/README.md"), `ids were ${ids.join(", ")}`);

    const read = await vault.read("Codebase/Files/README.md");
    assert.ok(read, "note should be readable by the id it was created with");

    // The second pass must be a no-op, not a delete-and-recreate.
    const again = await vault.upsertManaged({
      folder: "Codebase/Files",
      name: "README.md",
      kind: "file",
      managedBody: "# README.md",
    });
    assert.equal(again.status, "unchanged");

    const managed = await vault.managedNotesIn("Codebase/Files", "file");
    assert.ok(managed.has("Codebase/Files/README.md"));
  });

  test("paths outside the vault are refused", async () => {
    const vault = await makeVault();
    assert.throws(() => vault.absPathFor("../../etc/passwd"));
  });
});
