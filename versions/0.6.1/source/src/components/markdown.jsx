import { Fragment } from "react";

// 轻量 Markdown：标题、段落、加粗、行内代码、引用、分隔线、列表、表格、代码块。
// 内容可能来自模型或实验仓库，不渲染链接和 HTML，只当作文本显示。
// Idea 池、实验复现、研究讨论和论文讲解稿共用。
// 传入 renderCitation 时，正文里的 [paper_001 p.7] 或 [p.7] 会交给它渲染（例如做成能跳到原文的小标签）。
const citationToken = /\[(?:(paper_\d{3,})[\s,，]*)?p\.\s?(\d+)\]/;

function inline(text, keyPrefix, cite) {
  const parts = [];
  const pattern = cite
    ? /(\*\*[^*]+\*\*|`[^`]+`|\[(?:paper_\d{3,}[\s,，]*)?p\.\s?\d+\])/g
    : /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("**")) parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    else {
      const [, paperId, page] = citationToken.exec(token);
      parts.push(<Fragment key={key}>{cite(paperId ?? null, Number(page), token)}</Fragment>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function lines(textLines, key, cite) {
  return textLines.map((line, index) => <Fragment key={index}>{index > 0 && <br />}{inline(line, `${key}-${index}`, cite)}</Fragment>);
}

const fence = /^\s*```/;
const heading = /^\s*(#{1,6})\s+(.*)$/;
const rule = /^\s*(?:-{3,}|\*{3,})\s*$/;
const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/;
const tableRow = /^\s*\|.*\|\s*$/;
const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const isTableStart = (all, index) => tableRow.test(all[index] ?? "") && tableRule.test(all[index + 1] ?? "");
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const startsBlock = (all, index) => {
  const line = all[index];
  return fence.test(line) || heading.test(line) || rule.test(line) || listItem.test(line) || line.trim().startsWith(">") || isTableStart(all, index);
};

export function parseBlocks(source) {
  const all = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < all.length) {
    const line = all[index];
    if (!line.trim()) { index += 1; continue; }
    if (fence.test(line)) {
      const body = [];
      index += 1;
      while (index < all.length && !fence.test(all[index])) body.push(all[index++]);
      index += 1;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const title = heading.exec(line);
    if (title) { blocks.push({ type: "heading", level: Math.min(title[1].length, 4), text: title[2] }); index += 1; continue; }
    if (rule.test(line)) { blocks.push({ type: "rule" }); index += 1; continue; }
    if (isTableStart(all, index)) {
      const head = cells(line);
      const rows = [];
      index += 2;
      while (index < all.length && tableRow.test(all[index])) rows.push(cells(all[index++]));
      blocks.push({ type: "table", head, rows });
      continue;
    }
    if (line.trim().startsWith(">")) {
      const body = [];
      while (index < all.length && all[index].trim().startsWith(">")) body.push(all[index++].trim().replace(/^>\s?/, ""));
      blocks.push({ type: "quote", lines: body });
      continue;
    }
    if (listItem.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (index < all.length) {
        const current = all[index];
        if (listItem.test(current)) items.push([current.replace(listItem, "")]);
        else if (current.trim() && /^\s{2,}/.test(current) && items.length) items[items.length - 1].push(current.trim());
        else break;
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const body = [line];
    index += 1;
    while (index < all.length && all[index].trim() && !startsBlock(all, index)) body.push(all[index++]);
    blocks.push({ type: "paragraph", lines: body });
  }
  return blocks;
}

export function Markdown({ source, renderCitation }) {
  const cite = typeof renderCitation === "function" ? renderCitation : undefined;
  return (
    <>
      {parseBlocks(source).map((block, index) => {
        const key = `b${index}`;
        if (block.type === "rule") return <hr key={key} />;
        if (block.type === "heading") {
          const Tag = `h${block.level}`;
          return <Tag key={key}>{inline(block.text, key, cite)}</Tag>;
        }
        if (block.type === "code") return <pre key={key}><code>{block.text}</code></pre>;
        if (block.type === "quote") return <blockquote key={key}>{block.lines.map((line, i) => <p key={i}>{inline(line, `${key}-${i}`, cite)}</p>)}</blockquote>;
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return <List key={key}>{block.items.map((item, i) => <li key={i}>{lines(item, `${key}-${i}`, cite)}</li>)}</List>;
        }
        if (block.type === "table") {
          return (
            <div key={key} className="md-table">
              <table>
                <thead><tr>{block.head.map((cell, i) => <th key={i}>{inline(cell, `${key}-h${i}`, cite)}</th>)}</tr></thead>
                <tbody>{block.rows.map((row, r) => <tr key={r}>{block.head.map((_, c) => <td key={c}>{inline(row[c] ?? "", `${key}-${r}-${c}`, cite)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        return <p key={key}>{lines(block.lines, key, cite)}</p>;
      })}
    </>
  );
}
