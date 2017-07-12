"use strict";

function parse(text) {
  // TODO: use createError

  const unified = require("unified");
  const markdown = require("remark-parse");

  const remarkOptions = { footnotes: true };

  const processor = unified().use(markdown, remarkOptions);

  return processor.parse(text);
}

module.exports = parse;
