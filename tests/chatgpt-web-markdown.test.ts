import { expect, test } from "bun:test";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

test("native plan delimiters survive rendered Markdown without escaping their protocol spelling", () => {
  expect(chatGptHtmlToMarkdown('<p>&lt;proposed_plan&gt;</p><h1>Plan</h1><p>Do the work.</p><p>&lt;/proposed_plan&gt;</p>'))
    .toBe('<proposed_plan>\n\n# Plan\n\nDo the work.\n\n</proposed_plan>');
  expect(chatGptHtmlToMarkdown('<p><code>&lt;proposed_plan&gt;</code> is an example.</p>'))
    .toBe('`<proposed_plan>` is an example.');
  expect(chatGptHtmlToMarkdown('<pre><code>&lt;proposed_plan&gt;\nExample\n&lt;/proposed_plan&gt;</code></pre>'))
    .toBe('```\n<proposed_plan>\nExample\n</proposed_plan>\n```');
  expect(chatGptHtmlToMarkdown('<p>Discuss &lt;proposed_plan&gt; in prose.</p>')).not.toMatch(/^<proposed_plan>/);
});

test("native Plan delimiters survive the modern grouped response container and streamed inline segments", () => {
  const grouped = '<div>&lt;proposed_plan&gt;\n# Synthetic plan\n\n<h2>Summary</h2><p>Reconcile the rows.</p>&lt;/proposed_plan&gt;</div>';
  expect(chatGptHtmlToMarkdown(grouped)).toBe('<proposed_plan>\n# Synthetic plan\n\n## Summary\n\nReconcile the rows.\n</proposed_plan>');
  expect(chatGptHtmlToMarkdown('<span>&lt;proposed_plan&gt;\n# Synthetic plan\n\n</span>'))
    .toBe('<proposed_plan>\n# Synthetic plan');
  expect(chatGptHtmlToMarkdown('<span>&lt;/proposed_plan&gt;</span>')).toBe('</proposed_plan>');
  expect(chatGptHtmlToMarkdown('<blockquote><span>&lt;proposed_plan&gt;\nExample</span></blockquote>'))
    .not.toMatch(/^<proposed_plan>/);
});

test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    {
      path: "output/path-format-probe/alpha-notes.md",
      target: "output/path-format-probe/alpha-notes.md",
    },
    {
      path: "output/path-format-probe/beta-report.json",
      target: "output/path-format-probe/beta-report.json",
    },
    {
      path: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
      target: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
    },
    {
      path: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
      target: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
    },
    {
      path: String.raw`C:\Users\Dev\Documents\Codex\path-format-probe\zeta-result.pdf`,
      target: "C:/Users/Dev/Documents/Codex/path-format-probe/zeta-result.pdf",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    expect(chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`))
      .toBe(`Created [${path}](<${target}>).`);
  }
});

test("preserves inline code that is not an unambiguous file path", () => {
  const html = [
    "<p>",
    "Run <code>bun test tests/example.test.ts</code>, inspect <code>FileChangeItem</code>, ",
    "and retain <code>turn/diff/updated</code>, <code>https://example.com/report.pdf</code>, ",
    "and <code>src/path without-extension</code>, <code>src/.</code>, and <code>src/..</code>.",
    "</p>",
    "<pre><code>src/example.ts</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Run `bun test tests/example.test.ts`, inspect `FileChangeItem`, and retain `turn/diff/updated`, `https://example.com/report.pdf`, and `src/path without-extension`, `src/.`, and `src/..`.",
    "",
    "```",
    "src/example.ts",
    "```",
  ].join("\n"));
});

test("does not nest a generated file link inside an existing link", () => {
  expect(chatGptHtmlToMarkdown(
    '<p>Open <a href="https://example.com/source"><code>src/example.ts</code></a>.</p>',
  )).toBe("Open [`src/example.ts`](https://example.com/source).");
});

test("converts Obsidian aliases and headings but preserves code examples and embeds", () => {
  const html = [
    "<p>Open [[Notes/weekly-review|review]] and [[Projects/sample#Status]].</p>",
    "<p>Keep <code>[[wiki/example]]</code> and ![[image.png]] literal.</p>",
    "<pre><code>\`\`\`not a closing fence\n[[wiki/fenced]]</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Open [review](<Notes/weekly-review.md>) and [Projects/sample#Status](<Projects/sample.md#Status>).",
    "",
    "Keep `[[wiki/example]]` and ![[image.png]] literal.",
    "",
    "````",
    "```not a closing fence",
    "[[wiki/fenced]]",
    "````",
  ].join("\n"));
});
