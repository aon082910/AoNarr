import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client.js";

/** Inline `**bold**` and `` `code` `` spans within one line's text — the changelog's actual content
 * uses both constantly (bolded file/function names, backtick-quoted identifiers), which the
 * block-level parser below used to render as literal asterisks/backticks. Returns an array of
 * nodes rather than an HTML string so this still goes through JSX, not dangerouslySetInnerHTML. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) nodes.push(<strong key={`${keyPrefix}-${i++}`}>{match[1]}</strong>);
    else if (match[2] !== undefined) nodes.push(<code key={`${keyPrefix}-${i++}`}>{match[2]}</code>);
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/** Deliberately minimal — headers, list items, and paragraphs (each with inline bold/code spans)
 * are all this changelog ever uses, so a full markdown library would be overkill. Content is
 * server-controlled (CHANGELOG.md in the repo), never user input, but text still goes through JSX
 * rather than dangerouslySetInnerHTML. */
function renderMarkdown(markdown: string) {
  const lines = markdown.split("\n");
  const blocks: JSX.Element[] = [];
  let listItems: string[] = [];

  function flushList() {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={blocks.length}>
        {listItems.map((item, idx) => (
          <li key={idx}>{renderInline(item, `li-${blocks.length}-${idx}`)}</li>
        ))}
      </ul>
    );
    listItems = [];
  }

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushList();
      blocks.push(<h2 key={blocks.length}>{renderInline(line.slice(3), `h2-${blocks.length}`)}</h2>);
    } else if (line.startsWith("# ")) {
      flushList();
      blocks.push(<h1 key={blocks.length}>{renderInline(line.slice(2), `h1-${blocks.length}`)}</h1>);
    } else if (line.startsWith("- ")) {
      listItems.push(line.slice(2));
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={blocks.length}>{renderInline(line, `p-${blocks.length}`)}</p>);
    }
  }
  flushList();

  return blocks;
}

export default function Changelog() {
  const [markdown, setMarkdown] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ markdown: string }>("/changelog").then((r) => setMarkdown(r.markdown));
  }, []);

  if (!markdown) return <p className="empty">Loading...</p>;

  return <div>{renderMarkdown(markdown)}</div>;
}
