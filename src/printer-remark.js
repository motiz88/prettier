"use strict";

const streak = require("longest-streak");
const docBuilders = require("./doc-builders");
const concat = docBuilders.concat;
const hardline = docBuilders.hardline;
const line = docBuilders.line;
const group = docBuilders.group;
const indent = docBuilders.indent;
const markerBlock = docBuilders.markerBlock;
const fill = docBuilders.fill;
const hardlinex2 = concat([hardline, hardline]);
const hardlinex3 = concat([hardline, hardline, hardline]);
const ifBreak = docBuilders.ifBreak;
const softline = docBuilders.softline;

const remarkOptions = {
  commonmark: false,
  emphasis: "*",
  strong: "*",
  fence: "`",
  fences: true,
  setext: false,
  closeAtx: false
};

const uri = require("remark-stringify/lib/util/enclose-uri");
const title = require("remark-stringify/lib/util/enclose-title");

const remarkCompiler = new (require("remark-stringify")).Compiler();
remarkCompiler.setOptions(remarkOptions);

// FIXME: implement remark-stringify's contextual rules that govern encoding and
// escaping (e.g. don't encode/escape text in certain links)
const encode = remarkCompiler.encode.bind(remarkCompiler);
const escape = remarkCompiler.escape.bind(remarkCompiler);

function genericPrint(path, options, print) {
  const n = path.getValue();
  if (!n) {
    return "";
  }

  if (typeof n === "string") {
    return n;
  }

  switch (n.type) {
    case "root": {
      return concat([printBlock(path, print), hardline]);
    }

    case "blockquote": {
      return printBlockWithLeftMarkers(path, print, "> ");
    }

    case "break": {
      /**
       * Stringify a hard break.
       *
       * In Commonmark mode, trailing backslash form is used in order
       * to preserve trailing whitespace that the line may end with,
       * and also for better visibility.
       */
      return remarkOptions.commonmark ? concat("\\", hardline) : hardline;
    }

    case "code": {
      /**
       * Stringify code.
       *
       * Creates indented code when:
       *
       * - No language tag exists;
       * - Not in `fences: true` mode;
       * - A non-empty value exists.
       *
       * Otherwise, GFM fenced code is created:
       *
       *     ```js
       *     foo();
       *     ```
       *
       * When in ``fence: `~` `` mode, uses tildes as fences:
       *
       *     ~~~js
       *     foo();
       *     ~~~
       *
       * Knows about internal fences (Note: GitHub/Kramdown does
       * not support this):
       *
       *     ````javascript
       *     ```markdown
       *     foo
       *     ```
       *     ````
       *
       * Supports named entities in the language flag with
       * `settings.encode` mode.
       */
      const FENCE = /([`~])\1{2}/;

      const parent = path.getParentNode();
      let value = n.value;
      const marker = remarkOptions.fence;
      const lang = encode(n.lang || "");
      if (!lang && !remarkOptions.fences && value) {
        /* Throw when pedantic, in a list item which
        * isn’t compiled using a tab. */
        if (
          parent &&
          parent.type === "listItem" &&
          remarkOptions.listItemIndent !== "tab" &&
          remarkOptions.pedantic
        ) {
          throw new Error(
            "Cannot indent code properly. See http://git.io/vgFvT"
          );
        }

        return indent(value);
      }
      let fence = streak(value, marker) + 1;

      /* Fix GFM / RedCarpet bug, where fence-like characters
      * inside fenced code can exit a code-block.
      * Yes, even when the outer fence uses different
      * characters, or is longer.
      * Thus, we can only pad the code to make it work. */
      if (FENCE.test(value)) {
        value = indent(value);
      }

      fence = marker.repeat(Math.max(fence, 3));

      return concat([fence, lang, hardline, value, hardline, fence]);
    }

    case "definition": {
      const id = n.identifier.toLowerCase();
      const idAndUrlParts = [...textToWords("[" + id + "]:"), line, uri(n.url)];

      return group(
        indent(
          concat(
            [
              fill(idAndUrlParts),
              n.title && line,
              n.title && fill(textToWords(title(n.title)))
            ].filter(Boolean)
          )
        )
      );
    }

    case "delete": {
      return printQuoted(path, print, "~~");
    }

    case "footnoteDefinition": {
      const id = n.identifier.toLowerCase();
      const idTagParts = textToWords("[^" + id + "]:");
      const content = printBlock(path, print);
      return group(
        concat([
          fill(idTagParts),
          ifBreak(softline, ""),
          indent(fill([line, content]))
        ])
      );
    }

    case "footnoteReference": {
      // footnote references don't wrap
      return remarkCompiler.visitors[n.type].call(remarkCompiler, n);
    }

    case "footnote": {
      const childDocs = path.map(print, "children");
      return concat(["[^", fill(flattenOnce(flattenOnce(childDocs))), "]"]);
    }

    case "heading": {
      // headings don't wrap
      return remarkCompiler.visitors[n.type].call(remarkCompiler, n);
    }

    case "html": {
      // remark doesn't parse html fragments
      // TODO: either somehow complete parsing these and fuse the result with
      // the main AST, or at the very least tokenise and wrap them correctly.
      return remarkCompiler.visitors[n.type].call(remarkCompiler, n);
    }

    case "imageReference": {
      return concat([
        "![",
        printWrappingText(n.alt, true /* encode */) || "",
        "]",
        printLabel(n)
      ]);
    }

    case "text": {
      return concat(textToWords(n.value, true /* encode */, true /* escape */));
    }

    case "paragraph": {
      if (n.children && n.children[0] && n.children[0].type === "text") {
        // HACK: mutate the first child to trim any starting whitespace.
        n.children[0].value = n.children[0].value.replace(/^\s+/, "");
      }
      const childDocs = intersperse(softline, path.map(print, "children"));
      return fill(flattenOnce(flattenOnce(childDocs)));
    }

    case "emphasis": {
      const marker = remarkOptions.emphasis;
      return printQuoted(path, print, marker);
    }

    case "strong": {
      const marker = remarkOptions.strong.repeat(2);
      return printQuoted(path, print, marker);
    }

    default:
      throw new Error("unknown remark type: " + n.type);
  }
}

/**
 * Stringify a block node with block children (e.g., `root`
 * or `blockquote`).
 *
 * Knows about code following a list, or adjacent lists
 * with similar bullets, and places an extra newline
 * between them.
 */
function printBlock(path, print) {
  const children = [];
  let prev;
  path.each(childPath => {
    const child = childPath.getValue();
    if (prev) {
      /* Duplicate nodes, such as a list
       * directly following another list,
       * often need multiple new lines.
       *
       * Additionally, code blocks following a list
       * might easily be mistaken for a paragraph
       * in the list itself. */
      if (child.type === prev.type && prev.type === "list") {
        children.push(prev.ordered === child.ordered ? hardlinex3 : hardlinex2);
      } else if (prev.type === "list" && child.type === "code" && !child.lang) {
        children.push(hardlinex3);
      } else {
        children.push(hardlinex2);
      }
    }
    children.push(childPath.call(print));
    prev = child;
  }, "children");
  return concat(children);
}

function printBlockWithLeftMarkers(path, print, marker) {
  return markerBlock(marker, printBlock(path, print));
}

function printQuoted(path, print, leftQuote, rightQuote = leftQuote) {
  return concat([leftQuote, ...path.map(print, "children"), rightQuote]);
}

/**
 * Stringify a reference label.
 *
 * Because link references are easily, mistakingly,
 * created (for example, `[foo]`), reference nodes have
 * an extra property depicting how it looked in the
 * original document, so stringification can cause minimal
 * changes.
 *
 * @param {Object} node - `linkReference` or
 *   `imageReference` node.
 * @return {string} - Markdown label reference.
 */
function printLabel(n) {
  const type = n.referenceType;
  const value = type === "full" ? printWrappingText(n.identifier) : "";

  return type === "shortcut" ? value : concat(["[", value, "]"]);
}

function intersperse(sep, itemsIn) {
  const items = [];
  for (const item of itemsIn) {
    if (items.length) {
      items.push(sep);
    }

    items.push(item);
  }
  return items;
}

function textToWords(text, shouldEncode = false, shouldEscape = false) {
  if (!text) {
    return "";
  }

  const words = (text || "").split(/\s+/g).map(word => {
    if (shouldEscape) {
      word = escape(word);
    }

    if (shouldEncode) {
      word = encode(word);
    }
    return word;
  });
  return intersperse(line, words);
}

function printWrappingText(text, shouldEncode = false, shouldEscape = false) {
  return fill(textToWords(text, shouldEncode, shouldEscape));
}

function canWrap(text) {
  return /\s+/g.test(text || "");
}

function flattenOnce(docs) {
  const res = [];
  for (const childDoc of docs) {
    if (childDoc.type === "concat") {
      for (let i = 0; i < childDoc.parts.length; ++i) {
        res.push(childDoc.parts[i]);
      }
    } else {
      res.push(childDoc);
    }
  }
  return res;
}
module.exports = genericPrint;
