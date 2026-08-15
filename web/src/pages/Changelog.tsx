import { useEffect, useState } from "react";
import { api } from "../api/client.js";

/** Deliberately minimal — headers, list items, and paragraphs are all this changelog ever uses,
 * so a full markdown library would be overkill. Content is server-controlled (CHANGELOG.md in the
 * repo), never user input, but text still goes through JSX rather than dangerouslySetInnerHTML. */
function renderMarkdown(markdown: string) {
  const lines = markdown.split("\n");
  const blocks: JSX.Element[] = [];
  let listItems: string[] = [];

  function flushList() {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={blocks.length}>
        {listItems.map((item, idx) => (
          <li key={idx}>{item}</li>
        ))}
      </ul>
    );
    listItems = [];
  }

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushList();
      blocks.push(<h2 key={blocks.length}>{line.slice(3)}</h2>);
    } else if (line.startsWith("# ")) {
      flushList();
      blocks.push(<h1 key={blocks.length}>{line.slice(2)}</h1>);
    } else if (line.startsWith("- ")) {
      listItems.push(line.slice(2));
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={blocks.length}>{line}</p>);
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
