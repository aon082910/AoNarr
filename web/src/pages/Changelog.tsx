import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client.js";

/** Inline `**bold**`, `*italic*` and `` `code` `` spans within one block's text — the changelog's
 * actual content uses all three constantly (bolded file/function names, backtick-quoted
 * identifiers), which the block-level parser below used to render as literal asterisks/backticks.
 * Returns an array of nodes rather than an HTML string so this still goes through JSX, not
 * dangerouslySetInnerHTML. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`|\*([^*\s`](?:[^*`]*?[^*\s`])?)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const key = `${keyPrefix}-${i++}`;
    if (match[1] !== undefined) nodes.push(<strong key={key}>{renderInline(match[1], key)}</strong>);
    else if (match[2] !== undefined) nodes.push(<code key={key}>{match[2]}</code>);
    else if (match[3] !== undefined) nodes.push(<em key={key}>{renderInline(match[3], key)}</em>);
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/** One top-level bullet: its own text, plus any indented sub-bullets or blank-line-separated
 * follow-up paragraphs, in source order. */
type ListItem = { kind: "p" | "li"; text: string }[];

/** Deliberately minimal — headings, (one level of nested) list items, and paragraphs (each with
 * inline bold/italic/code spans) are all this changelog ever uses, so a full markdown library
 * would be overkill. CHANGELOG.md is hard-wrapped: a bullet's continuation lines are indented and
 * a paragraph spans several lines, so lines are joined into their block before rendering (which
 * also lets a bold span cross a line break). Content is server-controlled (CHANGELOG.md in the
 * repo), never user input, but text still goes through JSX rather than dangerouslySetInnerHTML. */
function renderMarkdown(markdown: string) {
  const blocks: JSX.Element[] = [];
  let listItems: ListItem[] = [];
  let paragraph: string[] = [];
  let blankInList = false;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push(<p key={blocks.length}>{renderInline(paragraph.join(" "), `p-${blocks.length}`)}</p>);
    paragraph = [];
  }

  function renderItem(item: ListItem, prefix: string) {
    const nodes: ReactNode[] = [];
    let subItems: string[] = [];
    const flushSubItems = () => {
      if (subItems.length === 0) return;
      nodes.push(
        <ul key={nodes.length}>
          {subItems.map((text, idx) => (
            <li key={idx}>{renderInline(text, `${prefix}-${nodes.length}-${idx}`)}</li>
          ))}
        </ul>
      );
      subItems = [];
    };
    item.forEach((part, idx) => {
      if (part.kind === "li") {
        subItems.push(part.text);
        return;
      }
      flushSubItems();
      if (idx === 0) nodes.push(...renderInline(part.text, `${prefix}-${idx}`));
      else nodes.push(<p key={nodes.length}>{renderInline(part.text, `${prefix}-${idx}`)}</p>);
    });
    flushSubItems();
    return nodes;
  }

  function flushList() {
    blankInList = false;
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={blocks.length}>
        {listItems.map((item, idx) => (
          <li key={idx}>{renderItem(item, `li-${blocks.length}-${idx}`)}</li>
        ))}
      </ul>
    );
    listItems = [];
  }

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trimEnd();
    const text = line.trim();
    const heading = /^(#{1,4}) (.*)$/.exec(line);
    const currentItem = listItems[listItems.length - 1];

    if (text === "") {
      flushParagraph();
      if (listItems.length > 0) blankInList = true;
    } else if (heading) {
      flushParagraph();
      flushList();
      const Tag = (["h1", "h2", "h3", "h4"] as const)[heading[1].length - 1];
      blocks.push(<Tag key={blocks.length}>{renderInline(heading[2], `h-${blocks.length}`)}</Tag>);
    } else if (line.startsWith("- ")) {
      flushParagraph();
      listItems.push([{ kind: "p", text: line.slice(2) }]);
      blankInList = false;
    } else if (currentItem && /^\s/.test(line)) {
      // An indented line belongs to the current bullet: a sub-bullet, a new paragraph after a
      // blank line, or (most often) a hard-wrapped continuation of the last part.
      if (text.startsWith("- ")) currentItem.push({ kind: "li", text: text.slice(2) });
      else if (blankInList) currentItem.push({ kind: "p", text });
      else currentItem[currentItem.length - 1].text += ` ${text}`;
      blankInList = false;
    } else {
      flushList();
      paragraph.push(text);
    }
  }
  flushParagraph();
  flushList();

  return blocks;
}

export default function Changelog() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ markdown: string }>("/changelog").then(
      (r) => setMarkdown(r.markdown),
      (e) => setLoadError((e as Error).message)
    );
  }, []);

  if (!markdown) return <p className="empty">{loadError ?? "Loading..."}</p>;

  return <div>{renderMarkdown(markdown)}</div>;
}
