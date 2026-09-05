import { escapeHtml } from "../lib/html";
import { renderShell } from "./layout";

// Bump this whenever PRIVACY.md changes materially.
const NOTICE_UPDATED = "2026-09-05";

/**
 * Serves PRIVACY.md at /privacy. The renderer handles exactly the constructs
 * this document uses (headings, paragraphs, bold/italic, links, lists) —
 * everything is escaped before inline formatting, so content cannot inject.
 */
export function privacyShell(markdown: string, footer: { abuseEmail: string | null; privacyEmail: string | null }): string {
  const body = renderMarkdown(markdown.replace("[DATE]", NOTICE_UPDATED));
  return renderShell({
    title: "Privacy notice — Find Me",
    metaDescription: "What Find Me stores, for how long, and who can see your location.",
    bodyClass: "shell-privacy",
    // Fully server-rendered — including the SPA bundle here would boot the
    // create page over the article.
    includeApp: false,
    content: `<article class="prose"><a class="button secondary small privacy-back" href="/">&larr; Back</a>${body}</article>`,
    footer,
  });
}

export function renderMarkdown(markdown: string): string {
  const out: string[] = [];
  let listOpen = false;
  // The source is hard-wrapped, so consecutive text lines are one paragraph.
  let paragraph: string[] = [];

  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      closeList();
      closeParagraph();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      closeParagraph();
      const level = heading[1].length + 1; // the document's h1 becomes the page h2
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      closeList();
      closeParagraph();
      out.push("<hr>");
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      closeParagraph();
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  closeList();
  closeParagraph();
  return out.join("\n");
}

function renderInline(text: string): string {
  return (
    escapeHtml(text)
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" rel="noopener noreferrer">$1</a>',
      )
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)_([^_]+)_(?=[\s.,:;)]|$)/g, "$1<em>$2</em>")
  );
}
