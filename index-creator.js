let dividerRowsEnabled = false;
let isCollapsed = true;

// Takes pasted index content as one long string, parses into an array of row objects.
// For Markdown: Recognises headers from the first line, skips the divider.
// Each row is mapped to a dictionary.
// Flags comment rows (starting with '?') with _ignore: true.
function parseMarkdownTable(markdown, hasHeaders = true) {
  const lines = markdown
    .trim()
    .split("\n")
    .map((line) => line.trim());

  if (lines.length < 1) return [];

  let headers;
  let dataLines;

  if (hasHeaders) {
    // check first line (header row)
    // strip leading/trailing pipes and split by remaining pipe delimiters
    headers = lines[0]
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((h) => h.trim()); // trim each header

    // skip divider row (e.g. | --- | --- |)
    dataLines = lines.slice(2);
  } else {
    // assume default column order when headers are missing
    headers = ["term", "sub-term", "notes", "book", "page"];
    dataLines = lines;
  }

  const rows = dataLines.map((line) => {
    const cells = line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    const row = {};
    headers.forEach((header, i) => {
      row[header] = cells[i] || "";
    });
    return row;
  });

  // Flag rows starting with ? as comment rows (not included in output)
  // Replacements can be defined in comment rows.
  rows.forEach((row) => {
    const term = row.term?.trim() || "";
    if (term.startsWith("?")) {
      row._ignore = true;
      console.log(`Ignoring row: ${term}`);
    }
  });

  return rows;
}
// When typing notes, I find myself using shorthand terms (how many times
// can you type "vulnerability" before shortening it?) so I wanted to create
// a method for defining common replacements that would then be used
// throughout the index.
// So:
// This looks for caret(^) separated definitions in the term, sub-term, and notes fields.
// The definitions are saved to a dictionary before removing the definition and leaving
// the shorthand in place. The replacements are then applied to all fields in one pass.
// Single word shorthand terms and replacements are supported (without quotes).
// Multi word terms and replacements are supported (with single/double quotes).

function extractReplacements(rows) {
  const replacementMap = {};
  const replacementRegex =
    /(?:"([^"]+)"|'([^']+)'|([\w-]+))\^("([^"]+)"|'([^']+)'|([\w-]+))/gi;

  for (const row of rows) {
    for (const field of ["term", "sub-term", "notes"]) {
      const value = row[field] || "";
      let match;

      while ((match = replacementRegex.exec(value)) !== null) {
        const shorthand = (match[1] || match[2] || match[3] || "")
          .toLowerCase()
          .trim();

        let replacement = "";
        if (match[5])
          replacement = match[5].trim(); // double-quoted replacement
        else if (match[6])
          replacement = match[6].trim(); // single-quoted replacement
        else if (match[7]) replacement = match[7].trim(); // unquoted single word replacement

        if (shorthand && replacement) {
          console.log(`Defining: "${shorthand}" -> "${replacement}"`);
          replacementMap[shorthand] = replacement;
        }
      }
    }
  }

  return replacementMap;
}

// Removes the replacement definitions where found, but leaves
// the shorthand terms in place so that they can be replaced
// when all rows are processed. (Imagine the fun that might've
// been had if I thought it would save time doing this when defining
// the replacement, and say, part of the replacement term is
// the shorthand term... What partially-recursive fun!!!).
function stripDefinitions(rows) {
  const regex =
    /(?:"([^"]+)"|'([^']+)'|([\w-]+))\^("([^"]+)"|'([^']+)'|([\w-]+))/gi;

  for (const row of rows) {
    for (const field of ["term", "sub-term", "notes"]) {
      if (row[field]) {
        row[field] = row[field].replace(regex, (_, d1, s1, u1) => {
          return d1 || s1 || u1 || "";
        });
      }
    }
  }
}

// iterates through all rows, and the applicable text-fields in each row
// and uses regex to replace shorthand terms with the defined replacements.
// Special processing where there are terms we have defined to be replaced
// but we want to escape an instance to prevent it from being replaced.
// ! escapes this.
function applyReplacements(rows, replacements) {
  for (const row of rows) {
    ["term", "sub-term", "notes"].forEach((field) => {
      let text = row[field] || "";
      const placeholders = {};

      // Step 1 - temporarily replace !escaped terms
      for (const shorthand of Object.keys(replacements)) {
        const escapedRegex = new RegExp(
          `\\!\\b${escapeRegExp(shorthand)}\\b`,
          "gi"
        );
        text = text.replace(escapedRegex, (match) => {
          const placeholder = `temp_placeholder_${shorthand.toUpperCase()}`;
          placeholders[placeholder] = match.slice(1); // remove `!`
          return placeholder;
        });
      }

      // Step 2 - apply replacements with case-sensitive styling
      for (const [shorthand, replacement] of Object.entries(replacements)) {
        const regex = new RegExp(`\\b${escapeRegExp(shorthand)}\\b`, "gi");

        text = text.replace(regex, (matched) =>
          matchCapitalisation(matched, replacement)
        );
      }

      // Step 3 - restore escaped terms
      for (const [placeholder, original] of Object.entries(placeholders)) {
        const restoreRegex = new RegExp(escapeRegExp(placeholder), "g");
        text = text.replace(restoreRegex, original);
      }

      row[field] = text;
    });
  }
}

function expandFlippedRows(rows) {
  const expanded = [];

  for (const row of rows) {
    const term = (row.term || "").trim();
    const subTerm = (row["sub-term"] || "").trim();

    const hasFlip = term.includes("<>") || subTerm.includes("<>");

    if (!hasFlip) {
      expanded.push(row);
      continue;
    }

    // Remove `<>` markers from both fields
    const cleanTerm = term.replace(/<>/g, "").trim();
    const cleanSubTerm = subTerm.replace(/<>/g, "").trim();

    // Push original row with cleaned fields
    expanded.push({
      ...row,
      term: cleanTerm,
      "sub-term": cleanSubTerm,
      _ignore: row._ignore || false,
    });

    // Push flipped row (term and sub-term switched)
    expanded.push({
      ...row,
      term: cleanSubTerm,
      "sub-term": cleanTerm,
      _ignore: row._ignore || false,
    });
  }

  return expanded;
}

// Handles `&&` syntax in any field, generating multiple rows
// for each combination of values (e.g., `a && b` becomes `a` and `b`).
// Also combines with other field expansions (e.g.`<>`).
function expandSplitRows(rows) {
  const expanded = [];

  for (const row of rows) {
    const fields = ["term", "sub-term", "notes", "book", "page"];

    // Identify which fields have &&
    const splitFields = fields.map((field) => {
      const raw = row[field] || "";
      return raw.includes("&&")
        ? raw.split("&&").map((part) => part.trim())
        : [raw.trim()];
    });

    // collect all potential splits before processing
    const [terms, subTerms, notes, books, pages] = splitFields;

    // loop through all combinations of the split fields
    for (const term of terms) {
      for (const subTerm of subTerms) {
        for (const note of notes) {
          for (const book of books) {
            for (const page of pages) {
              expanded.push({
                term,
                "sub-term": subTerm,
                notes: note,
                book,
                page,
                _ignore: row._ignore || false,
              });
            }
          }
        }
      }
    }
  }

  return expanded;
}

// ^^ indicates a field above should be copied down. e.g. maybe you
// want the same notes field for a different term.
function applyFieldInheritance(rows) {
  let lastRow = {};

  rows.forEach((row, rowIndex) => {
    if (row._ignore) return;

    for (const field of ["term", "sub-term", "notes", "book", "page"]) {
      const value = (row[field] || "").trim();

      // treat blank `term` as ^^
      if ((field === "term" && value === "") || value === "^^") {
        row[field] = lastRow[field] || "";
        console.log(
          `Row ${rowIndex}: copying "${field}" from previous row -> "${row[field]}"`
        );
      }
    }

    // only update lastRow with actual data rows (not comments)
    lastRow = { ...row };
  });
}

// An attempt at a rules engine... Each rule is kept separate to
// enable future tweaking/addition of rules. Or re-ordering, as
// the order trickles down.
// - Applies row-level inheritance rules (like copying from previous row)
// - Normalises and sorts by term, sub-term, and first page number
// - Converts the page string into a consistent format
// - Handles special rules like `term*` and blank sub-terms. -- obsolete. `&&` supersedes
// The output is sorted for HTML rendering.
function processData(rows) {
  const processed = [];
  let last = { term: "", subTerm: "", notes: "", book: 0, page: "" };

  for (const row of rows) {
    if (row._ignore) continue;

    const rawTerm = (row.term || "").trim();
    const rawSubTerm = (row["sub-term"] || "").trim();
    const rawNotes = (row.notes || "").trim();
    const rawBook = (row.book || "").trim();
    const rawPage = (row.page || "").trim();

    const hasTerm = rawTerm !== "";
    const hasSubTerm = rawSubTerm !== "";
    const hasNotes = rawNotes !== "";
    const hasBook = rawBook !== "";
    const hasPage = rawPage !== "";

    let term = rawTerm;
    let subTerm = rawSubTerm;
    let notes = rawNotes;
    let book = hasBook ? parseInt(rawBook) : 0;
    let page = hasPage ? normalisePageOrder(rawPage) : last.page;

    // Rule 1 - Row only has `term`, all other fields blank:
    // Copy `book` and `page` from previous row
    if (
      hasTerm &&
      !hasSubTerm &&
      !hasNotes &&
      !hasBook &&
      !hasPage
      // !rawTerm.endsWith("*") - obsolete with &&
    ) {
      term = rawTerm;
      subTerm = "";
      notes = "";
      book = last.book;
      page = last.page;
    }

    // Rule 2 - `term*` or `term *` (ends with asterisk), all others blank:
    // Copy sub-term, notes, book, page from previous row
    // REMOVE THIS - now obsolete with &&

    // else if (
    //   hasTerm &&
    //   !hasSubTerm &&
    //   !hasNotes &&
    //   !hasBook &&
    //   !hasPage &&
    //   rawTerm.endsWith("*")
    // ) {
    //   term = rawTerm.replace(/\*$/, "");
    //   subTerm = last.subTerm;
    //   notes = last.notes;
    //   book = last.book;
    //   page = last.page;
    // }

    // Rule 3 - Row only contains sub-term:
    // Copy term, book, and page from previous row
    else if (!hasTerm && hasSubTerm && !hasNotes && !hasBook && !hasPage) {
      term = last.term;
      subTerm = rawSubTerm;
      notes = "";
      book = last.book;
      page = last.page;
    }

    // Default/fallback - use term, book and page from previous row
    else {
      term = rawTerm;
      subTerm = rawSubTerm;
      notes = rawNotes;
      book = hasBook ? parseInt(rawBook) : last.book;
      page = hasPage ? normalisePageOrder(rawPage) : last.page;
    }

    // add each row to the `processed` (dictionary) object
    // then set last to the current, for the next
    // iteration's 'lookback'
    const entry = { term, subTerm, notes, book, page };
    processed.push(entry);
    last = entry;
  }

  // Sort the `processed` object before rendering.
  // Alphabetically: first by term, then sub-term, then book number
  processed.sort((a, b) => {
    const termCmp = cleanStripMarkdown(a.term).localeCompare(
      cleanStripMarkdown(b.term)
    );
    if (termCmp !== 0) return termCmp;

    const subCmp = cleanStripMarkdown(a.subTerm).localeCompare(
      cleanStripMarkdown(b.subTerm)
    );
    if (subCmp !== 0) return subCmp;

    const pageA = extractPageStart(a.page);
    const pageB = extractPageStart(b.page);
    return pageA - pageB;
  });

  return processed;
}

// Create and render an HTML table from the `processed` dict object
// If `isCollapsed` is true, duplicate terms/sub-terms are collapsed
// using `rowspan`. Otherwise, all rows are shown.
// Markdown within fields is rendered as HTML using `parseInlineMarkdown`.
// Page numbers are wrapped in span tags for styling (allows CSS to prevent page
// number ranges being split across lines).
function renderToHTML(data, isCollapsed) {
  const table = document.createElement("table");
  const rows = [];

  if (isCollapsed) {
    // default view == collapsed mode — uses rowspan to reduce visual duplication
    let i = 0;
    while (i < data.length) {
      const current = data[i];

      if (current.divider) {
        rows.push(`
    <tr class="divider-row">
      <td colspan="5"><strong>${current.divider}</strong></td>
    </tr>
  `);
        i++;
        continue;
      }

      const termGroup = data
        .slice(i)
        .filter((row) => row.term === current.term);
      const termRowspan = termGroup.length;

      for (let j = 0; j < termRowspan; ) {
        const row = data[i + j];
        const subGroup = termGroup
          .slice(j)
          .filter((r) => r.subTerm === row.subTerm);
        const subRowspan = subGroup.length;

        const termCell =
          j === 0
            ? `<td rowspan="${termRowspan}">${parseInlineMarkdown(
                row.term
              )}</td>`
            : "";

        const subTermCell =
          subRowspan > 1
            ? `<td rowspan="${subRowspan}">${parseInlineMarkdown(
                row.subTerm
              )}</td>`
            : `<td>${parseInlineMarkdown(row.subTerm)}</td>`;

        rows.push(`
          <tr>
            ${termCell}
            ${subTermCell}
            <td>${parseInlineMarkdown(row.notes)}</td>
            <td>${row.book}</td>
            <td>${wrapPageSpans(parseInlineMarkdown(row.page))}</td>


          </tr>
        `);

        for (let k = 1; k < subRowspan; k++) {
          const nextRow = data[i + j + k];
          rows.push(`
            <tr>
              <td>${parseInlineMarkdown(nextRow.notes)}</td>
              <td>${nextRow.book}</td>
              <td>${nextRow.page}</td>
            </tr>
          `);
        }

        j += subRowspan;
      }

      i += termRowspan;
    }
  } else {
    // expanded view — no rowspan, show all values
    data.forEach((row) => {
      if (row.divider) {
        rows.push(`
      <tr class="divider-row">
        <td colspan="5"><strong>${row.divider}</strong></td>
      </tr>
    `);
        return; // skip rendering the rest of this row
      }

      rows.push(`
        <tr>
          <td>${parseInlineMarkdown(row.term)}</td>
          <td>${parseInlineMarkdown(row.subTerm)}</td>
          <td>${parseInlineMarkdown(row.notes)}</td>
          <td>${row.book}</td>
          <td>${wrapPageSpans(parseInlineMarkdown(row.page))}</td>


        </tr>
      `);
    });
  }

  // build and insert HTML table
  table.innerHTML = `
    <thead>
      <tr><th>Term</th><th>Sub-term</th><th>Notes</th><th>Book</th><th>Page</th></tr>
    </thead>
    <tbody>
      ${rows.join("")}
    </tbody>
  `;

  table.style.fontSize = `${getCurrentFontSize()}px`;

  document.getElementById("output").innerHTML = "";
  document.getElementById("output").appendChild(table);

  // don't think we actually need this here. Wasn't able to access
  // getCurrentFontSize() anyway. TODO: check and remove.
  // table.style.fontSize = `${getCurrentFontSize()}px`;
  // -- moved to above setting of output element a few lines above. TODO: clean this up

  showControls();
  updateControls();
}

// util functions

// Adjusts capitalisation of replacement string to match shorthand input
// Preserves internal acronyms (2+ defined uppercase characters)
// regardless of input capitalisation
function matchCapitalisation(source, replacement) {
  const isAllCaps = source === source.toUpperCase();
  const isCapitalised = source[0] === source[0].toUpperCase();

  const tokens = replacement.split(/\b/);

  let capitalisedFirst = false;

  return tokens
    .map((token) => {
      if (/[A-Z]{2,}/.test(token)) return token; // preserve acronyms

      if (isAllCaps) {
        return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
      } else if (isCapitalised && !capitalisedFirst && /[a-zA-Z]/.test(token)) {
        capitalisedFirst = true;
        return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
      } else {
        return token.toLowerCase();
      }
    })
    .join("");
}

// For HTML display only: wraps each comma-separated page entry
// in a <span> tag to allow styling (e.g. bolded spans, prevent
// hyphenated ranges from being split across lines).
// Used only in `renderToHTML` output.
function wrapPageSpans(text) {
  return text
    .split(",")
    .map((chunk) => `<span class="page-segment">${chunk.trim()}</span>`)
    .join(", ");
}

// Parse and re-order comma-separated page num strings so that
// the lowest page numbers appear first, even if mixed with
// markdown (i.e. `**10**` will still be ordered as 10).
// Ranges are sorted based on their starting number.
function normalisePageOrder(pageString) {
  if (!pageString) return "";

  return pageString
    .split(",")
    .map((chunk) => chunk.trim())
    .sort((a, b) => {
      const numA = extractPageStart(a);
      const numB = extractPageStart(b);
      return numA - numB;
    })
    .join(", ");
}

function cleanStripMarkdown(text) {
  if (!text) return "";

  return text
    .replace(/\\[`*]/g, "") // remove escaped formatting characters
    .replace(/`([^`]+?)`/g, "$1")
    .replace(/\*\*\*([^\*]+?)\*\*\*/g, "$1")
    .replace(/\*\*([^\*]+?)\*\*/g, "$1")
    .replace(/\*([^\*]+?)\*/g, "$1");
}

function extractPageStart(page) {
  const raw = stripMarkdown(String(page || ""));
  const matches = raw.match(/\d+/g);

  if (!matches) return Number.MAX_SAFE_INTEGER;

  const numbers = matches.map((n) => parseInt(n, 10));
  return Math.min(...numbers);
}

// function to escape any special characters that broke... I mean, *might break*
// regex functions.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replaces `something` with <code>something</code>
function parseInlineMarkdown(text) {
  if (!text) return "";

  // Temporarily escape \* and \` to prevent accidental formatting
  const ESC = {
    backtick: "__ESC_BACKTICK__",
    star: "__ESC_STAR__",
  };

  text = text.replace(/\\`/g, ESC.backtick).replace(/\\\*/g, ESC.star);

  // Apply formatting
  text = text
    .replace(/`([^`]+?)`/g, "<code>$1</code>")
    .replace(/\*\*\*([^\*]+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^\*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^\*]+?)\*/g, "<em>$1</em>");

  // Restore escaped characters
  text = text
    .replace(new RegExp(ESC.backtick, "g"), "`")
    .replace(new RegExp(ESC.star, "g"), "*");

  return text;
}

// Strips markdown formatting like backticks
function stripMarkdown(text) {
  if (!text) return "";

  const ESC = {
    backtick: "__ESC_BACKTICK__",
    star: "__ESC_STAR__",
  };

  text = text.replace(/\\`/g, ESC.backtick).replace(/\\\*/g, ESC.star);

  text = text
    .replace(/`([^`]+?)`/g, "$1")
    .replace(/\*\*\*([^\*]+?)\*\*\*/g, "$1")
    .replace(/\*\*([^\*]+?)\*\*/g, "$1")
    .replace(/\*([^\*]+?)\*/g, "$1");

  text = text
    .replace(new RegExp(ESC.backtick, "g"), "`")
    .replace(new RegExp(ESC.star, "g"), "*");

  return text;
}

// check whether input looks like Markdown table with headers
// assumes header row followed by a divider row like: | --- | --- |
function isProbMarkdownWithHeaders(lines) {
  const headerLine = lines[0] || "";
  const dividerLine = lines[1] || "";

  return (
    headerLine.includes("|") && // first line looks like column headers
    dividerLine.match(/^(\|?[\s-]+\|?)+$/) // second line is a divider
  );
}

// checks whether first line of CSV input looks like it contains headers
// compares to expected column names (case-insensitive)
function isProbCSVWithHeaders(firstLine) {
  const expectedHeaders = ["term", "sub-term", "notes", "book", "page"];

  // split first line into fields and normalise for comparison
  const fields = firstLine.split(",").map((f) => f.trim().toLowerCase());

  // check that every expected header is present somewhere in the fields
  return expectedHeaders.every((header) => fields.includes(header));
}

// parses CSV string, updates UI with the loaded index content,
// applies transform rules, renders content, and restores applicable
// metadata settings.
// plus: saves  original input for export and comparison.

function importCSVFromString(content) {
  const parsed = parseCSVTable(content, true);
  const { rows, meta } = parsed;
  console.log("Parsed rows:", rows);
  console.log("Parsed meta:", meta);

  // copy and store original parsed rows (globally), so exports and comparisons use unprocessed input content
  if (typeof globalThis !== "undefined") {
    globalThis.originalParsedRows = JSON.parse(JSON.stringify(rows));
  }
  // run full processing on CSV string (replacements, splits, sorting, etc.)
  const processed = processInputText(content, {
    format: "csv",
    hasHeaders: true,
  });

  if (typeof document !== "undefined") {
    // clear any previously rendered index data, divider state to prevent issues when rendering another file
    currentRenderedData = [];
    dividerRowsEnabled = false;

    document.getElementById("index_input").value = buildCSVText(rows); // update textarea with loaded content

    // conditionally re-add divider rows if previously toggled on
    currentRenderedData = dividerRowsEnabled
      ? insertLetterDividers(processed)
      : processed;

    // default to collapsed view after import (can be overridden later by metadata)
    // do we still need this?
    isCollapsed = true;

    // render processed data into the HTML table
    renderToHTML(currentRenderedData, isCollapsed);

    // apply saved metadata values (title, font size, collapse/divider settings + other future stuff)
    if (typeof populateMetadataForm === "function") {
      populateMetadataForm(meta || {});
    }
  }

  return processed;
}

// converts array of row objects into a CSV-formatted string.
// Escapes fields as req & joins with commas and newlines.
function buildCSVText(rows) {
  const headers = ["term", "sub-term", "notes", "book", "page"];
  const csvLines = [headers];

  // for each row, map fields to escaped values in the correct order
  for (const row of rows) {
    const line = headers.map((key) => escapeCSVField(row[key] || ""));
    csvLines.push(line);
  }

  // join rows into CSV string, first by commas (fields), then by newlines (rows)
  return csvLines.map((r) => r.join(",")).join("\n");
}

function escapeCSVField(value) {
  const str = String(value);
  // If field contains comma, quote, or newline, wrap in quotes and escape internal quotes
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// annoying, but move to global scope
function populateMetadataForm(meta = {}) {
  document.getElementById("meta_title").value = meta.title || "";
  document.getElementById("meta_css").value = meta.customCSS || "";

  // Set font size input and apply to table
  if (meta.fontSize && !isNaN(meta.fontSize)) {
    const fontInput = document.getElementById("print_font_size");
    if (fontInput) {
      fontInput.value = meta.fontSize;

      const table = document.querySelector("#output table");
      if (table) {
        table.style.fontSize = `${meta.fontSize}px`;
      }
    }
  }

  // Set collapse toggle button and state
  if (typeof meta.collapsed === "boolean") {
    isCollapsed = meta.collapsed;
    const collapseBtn = document.getElementById("toggle_collapse_button");
    if (collapseBtn) {
      collapseBtn.textContent = isCollapsed
        ? "Expand duplicate fields"
        : "Collapse Duplicate Fields";
    }
  }

  // Insert dividers if meta.hasDividers is true
  if (meta.hasDividers && Array.isArray(currentRenderedData)) {
    currentRenderedData = insertLetterDividers(currentRenderedData);
    dividerRowsEnabled = true; // ✅ ensure flag matches data
    const dividerBtn = document.getElementById("insert_dividers_button");
    if (dividerBtn) {
      dividerBtn.textContent = "Remove Letter Dividers";
    }
  } else {
    dividerRowsEnabled = false; // ✅ ensure clean state
  }

  // Re-render with current settings
  if (Array.isArray(currentRenderedData)) {
    renderToHTML(currentRenderedData, isCollapsed);
  }
}

// show hidden HTML elements
function showControls() {
  document.getElementById("save_to_csv_button").style.display = "inline-block";
  document.getElementById("toggle_collapse_button").style.display =
    "inline-block";
  document.getElementById("print_button").style.display = "inline-block";
  document.getElementById("font_selector").style.display = "inline-block";
  document.getElementById("insert_dividers_button").style.display =
    "inline-block";
}

// update control element show/state
function updateControls() {
  const dividerBtn = document.getElementById("insert_dividers_button");
  if (dividerBtn) {
    dividerBtn.textContent = dividerRowsEnabled
      ? "Remove Letter Dividers"
      : "Insert Letter Dividers";
  }

  const collapseBtn = document.getElementById("toggle_collapse_button");
  if (collapseBtn) {
    collapseBtn.textContent = isCollapsed
      ? "Expand Duplicate Fields"
      : "Collapse Duplicate Fields";
  }

  const fontInput = document.getElementById("print_font_size");
  const table = document.querySelector("#output table");
  if (fontInput && table) {
    table.style.fontSize = `${getCurrentFontSize()}px`;
  }
}

// Inserts alphabetical (well, first character) divider rows (e.g., A, B, C,
// numbers, special chars) before each new first character
function insertLetterDividers(data) {
  if (!Array.isArray(data)) return data;

  const result = [];
  let lastLetter = null;

  for (const row of data) {
    if (row._ignore || row.divider) {
      result.push(row);
      continue;
    }

    const letter = stripMarkdown(row.term).charAt(0).toUpperCase();
    if (letter !== lastLetter) {
      result.push({ divider: letter });
      lastLetter = letter;
    }
    result.push(row);
  }

  return result;
}

// helper function to get currently selected font size
function getCurrentFontSize() {
  const input = document.getElementById("print_font_size");
  const val = parseInt(input?.value, 10);
  return Math.max(1, Math.min(200, isNaN(val) ? 10 : val));
}

// actions to perform when `Create Index` pressed:
function runInBrowser() {
  // Serialises current index data & metadata into downloadable CSV file.
  // Includes meta row for title, font size, collapse/divider settings, etc.
  function saveToCSV(data) {
    const headers = ["Term", "Sub-term", "Notes", "Book", "Page"];

    // use original (unprocessed) parsed rows to preserve formatting and special syntax
    const rawRows =
      (typeof globalThis !== "undefined" && globalThis.originalParsedRows) ||
      [];

    // strip out ignored rows and convert remaining rows into flat field arrays
    const csvRows = rawRows
      .filter((row) => !row._ignore)
      .map((row) => [
        row.term || "",
        row["sub-term"] || "",
        row.notes || "",
        row.book || "",
        row.page || "",
      ]);

    // gather metadata from form fields (title, font size, etc.)
    const meta = getMetadataFromForm();

    // insert meta row directly after headers to preserve user settings in export
    const metaRow = [`?meta: ${JSON.stringify(meta)}`];

    // headers first, then meta row, then data...
    const csvArray = [headers, metaRow, ...csvRows];

    // escape all fields and convert into a CSV string with quoted values
    // update this... Doing something different on load/input, where we identify
    // what NEEDS quotes. Feels like we're doubling up effort here
    const csvContent = csvArray
      .map((r) =>
        r.map((field) => `"${String(field).replace(/"/g, '""')}"`).join(",")
      )
      .join("\n");

    // create  downloadable CSV file from content string
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;

    // Use title from meta (if any) for filename
    const safeTitle = (meta.title || "index").replace(/[^\w-]+/g, "_");
    a.download = `${safeTitle}.csv`;

    // trigger download by simulating a click on a temp anchor element
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function getMetadataFromForm() {
    return {
      title: document.getElementById("meta_title")?.value?.trim() || null,
      customCSS: document.getElementById("meta_css")?.value?.trim() || null,
      fontSize:
        parseInt(document.getElementById("print_font_size")?.value, 10) || null,
      collapsed: !!isCollapsed,
      hasDividers: currentRenderedData?.some((row) => row.divider) || false,
    };
  }

  function setupImportButtonHandler() {
    const input = document.getElementById("import_csv_file");
    if (!input) return;

    input.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result;
        importCSVFromString(content);

        // reset to blank, so file can be reloaded without browser thinking it's the same
        input.value = "";
      };
      reader.readAsText(file);
    });
  }

  setupImportButtonHandler();

  const importButton = document.getElementById("import_csv_button");
  const fileInput = document.getElementById("import_csv_file");

  if (importButton && fileInput) {
    importButton.addEventListener("click", () => {
      fileInput.click(); // show file picker
    });
  }

  const dividerBtn = document.getElementById("insert_dividers_button");
  dividerBtn?.addEventListener("click", () => {
    const hasDividers = currentRenderedData.some((row) => row.divider);
    dividerRowsEnabled = !hasDividers;

    if (dividerRowsEnabled) {
      currentRenderedData = insertLetterDividers(currentRenderedData);
      dividerBtn.textContent = "Remove Letter Dividers";
    } else {
      currentRenderedData = currentRenderedData.filter((row) => !row.divider);
      dividerBtn.textContent = "Insert Letter Dividers";
    }

    renderToHTML(currentRenderedData, isCollapsed);
  });

  // tried moving to global scope. TODO: clean this up
  // // Inserts alphabetical (well, first character) divider rows (e.g., A, B, C,
  // // numbers, special chars) before each new first character
  // function insertLetterDividers(data) {
  //   if (!Array.isArray(data)) return data;

  //   const result = [];
  //   let lastLetter = null;

  //   for (const row of data) {
  //     if (row._ignore || row.divider) {
  //       result.push(row);
  //       continue;
  //     }

  //     const letter = stripMarkdown(row.term).charAt(0).toUpperCase();
  //     if (letter !== lastLetter) {
  //       result.push({ divider: letter });
  //       lastLetter = letter;
  //     }
  //     result.push(row);
  //   }

  //   return result;
  // }

  // setup event handlers for export/save buttons
  document.getElementById("save_to_csv_button").onclick = () =>
    saveToCSV(currentRenderedData, isCollapsed);

  // setup event handler for collapse/expand button
  document
    .getElementById("toggle_collapse_button")
    .addEventListener("click", () => {
      isCollapsed = !isCollapsed;
      document.getElementById("toggle_collapse_button").textContent =
        isCollapsed ? "Expand duplicate fields" : "Collapse Duplicate Fields";
      renderToHTML(currentRenderedData, isCollapsed);
    });

  // setup print size functionality

  function setupFontSizeControls() {
    const input = document.getElementById("print_font_size");
    const incBtn = document.getElementById("increase_font");
    const decBtn = document.getElementById("decrease_font");
    const printBtn = document.getElementById("print_button");

    function updatePrintButtonFontSize(sizePx) {
      const sanitised = Math.max(1, Math.min(200, parseInt(sizePx, 10) || 10));
      input.value = sanitised;

      const styleStr = `table {font-size: ${sanitised}px;}`;
      printBtn.setAttribute(
        "onclick",
        `printJS({printable: 'output', type: 'html', scanStyles: false, css: 'print.css', style: '${styleStr}'})`
      );

      // update the rendered table's font size if it exists (live preview of selected font size)
      const table = document.querySelector("#output table");
      if (table) {
        table.style.fontSize = `${sanitised}px`;
      }
    }

    input.addEventListener("input", () =>
      updatePrintButtonFontSize(input.value)
    );
    incBtn.addEventListener("click", () =>
      updatePrintButtonFontSize(+input.value + 1)
    );
    decBtn.addEventListener("click", () =>
      updatePrintButtonFontSize(+input.value - 1)
    );

    updatePrintButtonFontSize(input.value); // set initial
  }

  setupFontSizeControls();

  // intercept Cmd/Ctrl + P and trigger custom print
  window.addEventListener("keydown", (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const isPrintShortcut = (isMac && e.metaKey) || (!isMac && e.ctrlKey);

    if (isPrintShortcut && e.key.toLowerCase() === "p") {
      e.preventDefault();

      const size = getCurrentFontSize();
      const styleStr = `table {font-size: ${size}px;}`;

      printJS({
        printable: "output",
        type: "html",
        scanStyles: false,
        css: "print.css",
        style: styleStr,
      });
    }
  });

  // generate and render index
  document
    .getElementById("create_index_button")
    .addEventListener("click", () => {
      // setup UI buttons
      // document.getElementById("save_to_csv_button").style.display =
      //   "inline-block";
      // document.getElementById("toggle_collapse_button").style.display =
      //   "inline-block";
      // document.getElementById("print_button").style.display = "inline-block";
      // document.getElementById("font_selector").style.display = "inline-block";
      // document.getElementById("insert_dividers_button").style.display =
      //   "inline-block";
      // showContols now handles these. Single call moved to renderToHTML
      // TODO: clean up

      // set button text back if 'create index' is pressed again
      document.getElementById("insert_dividers_button").textContent =
        "Insert Letter Dividers";
      document.getElementById("toggle_collapse_button").textContent =
        "Expand Duplicate Fields";

      // get user input and process
      const input = document.getElementById("index_input").value;
      const processed = processInputText(input);

      // currentRenderedData = processed; TODO: clean up

      // check for previously set enabling of letter divider/rows
      currentRenderedData = dividerRowsEnabled
        ? insertLetterDividers(processed)
        : processed;

      // isCollapsed = true; don't set this as default. Want behaviour to load from file/persist if `create index` clicked again. TODO: cleanup
      renderToHTML(currentRenderedData, isCollapsed);
    });
}

// Function to run test cases (defined in files in tests directory),
// using -t - compares testcase to the content in .expected.json file
// When also run with --update-expected=<testname>, the expected outcome is
// written to testname.expected.json (file needs to exist and contain [])
function runTests() {
  const fs = require("fs");
  const path = require("path");
  const updateArg = process.argv.find((arg) =>
    arg.startsWith("--update-expected=")
  );
  const updateTarget = updateArg ? updateArg.split("=")[1] : null;

  const testDir = path.join(__dirname, "tests");

  const allowedExtensions = [".md", ".txt", ".csv"];
  const testFiles = fs
    .readdirSync(testDir)
    .filter((f) => allowedExtensions.includes(path.extname(f)));

  // count test failures to report at the end
  let allPassed = true;
  let totalTests = testFiles.length;
  let failedCount = 0;

  for (const testFile of testFiles) {
    const base = path.basename(testFile, path.extname(testFile));
    const expectedFile = base + ".expected.json";

    const inputPath = path.join(testDir, testFile);
    const expectedPath = path.join(testDir, expectedFile);

    if (!fs.existsSync(expectedPath)) {
      console.warn(`⚠️ Skipping "${testFile}" — no matching expected output.`);
      continue;
    }

    console.log(`📋 Running ${base}${path.extname(testFile)}`);

    const markdown = fs.readFileSync(inputPath, "utf-8");
    const expected = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));

    // Run full processing on test cases
    const rows = parseMarkdownTable(markdown);
    const replacements = extractReplacements(rows);
    stripDefinitions(rows);
    applyReplacements(rows, replacements);
    applyFieldInheritance(rows);
    const flippedRows = expandFlippedRows(rows);
    const splitRows = expandSplitRows(flippedRows);
    const processed = processData(splitRows);

    const result = JSON.stringify(processed, null, 2);
    if (updateTarget === base) {
      fs.writeFileSync(expectedPath, result + "\n");
      console.log(`📝 Updated expected output for "${base}"`);
      continue;
    }

    const expectedJson = JSON.stringify(expected, null, 2);

    if (result === expectedJson) {
      console.log(`✅ ${base} passed`);
    } else {
      console.error(`❌ ${base} failed`);
      console.error("Expected:", expectedJson);
      console.error("Received:", result);
      allPassed = false;
      failedCount++;
    }
  }

  const passedCount = totalTests - failedCount;
  console.log(`\n✅ ${passedCount}/${totalTests} tests passed.`);
  process.exit(allPassed ? 0 : 1);
}

// parse single line of CSV into an array of values
// supports quoted fields and escaped quotes
function parseCSVLine(line) {
  const result = [];
  let current = ""; // track current cell being built
  let inQuotes = false; // track whether we're inside a quoted field
  let i = 0; // pos in input line

  while (i < line.length) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        // handle escaped quote ("") within a quoted field
        if (line[i + 1] === '"') {
          current += '"'; // add one literal quote
          i += 2; // skip both quotes
        } else {
          inQuotes = false; // close quote found
          i++;
        }
      } else {
        // regular character inside quotes
        current += char;
        i++;
      }
    } else {
      if (char === '"') {
        // start of quoted field
        inQuotes = true;
        i++;
      } else if (char === ",") {
        // normal comma delim
        result.push(current.trim());
        current = "";
        i++;
      } else {
        // regular char outside quotes
        current += char;
        i++;
      }
    }
  }

  result.push(current.trim());
  return result;
}

// parse CSV string into array of row objects
// handles headers (or assumes default column order), quoted fields, and ?comment rows
// handles ?meta row (specifically first row after header)
function parseCSVTable(csv, hasHeaders = true) {
  // split input into non-empty trimmed lines
  const lines = csv
    .trim()
    .split("\n")
    .map((line) => line.trim());

  if (lines.length < 1) return { rows: [], meta: null };

  let headers;
  let dataLines;
  let meta = null;

  if (hasHeaders) {
    headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
    dataLines = lines.slice(1); // remaining lines are data
  } else {
    // if no headers, assume default column names in fixed order
    headers = ["term", "sub-term", "notes", "book", "page"];
    dataLines = lines;
  }

  // check if first data line is a ?meta row
  if (dataLines.length > 0) {
    const firstLine = dataLines[0];
    const firstCell = parseCSVLine(firstLine)[0];
    if (firstCell && firstCell.startsWith("?meta:")) {
      try {
        const json = firstCell.replace(/^\?meta:\s*/, "");
        meta = JSON.parse(json);
      } catch (err) {
        console.warn("Invalid ?meta line in CSV:", err);
      }
      dataLines.shift(); // remove the ?meta row from further processing
    }
  }

  const rows = dataLines.map((line) => {
    const cells = parseCSVLine(line);
    const row = {};

    headers.forEach((header, i) => {
      row[header] = cells[i] || "";
    });

    // handle other comment rows: if term starts with "?", mark as ignored
    const term = row.term?.trim() || "";
    if (term.startsWith("?")) {
      row._ignore = true;
      console.log(`Ignoring row: ${term}`);
    }

    return row;
  });

  return { rows, meta };
}

// processes raw pasted or loaded index input (CSV or Markdown)
// detects format and header presence if not explicitly provided
// applies the full transformation pipeline and returns processed row objects
function processInputText(text, options = {}) {
  const trimmed = text.trim(); // remove leading/trailing whitespace
  const lines = trimmed.split("\n"); // split into lines

  // auto-detect format unless explicitly provided...
  //// CSV if there are commas and no pipe characters
  //// default to Markdown otherwise
  const format =
    options.format ||
    (trimmed.includes(",") && !trimmed.includes("|") ? "csv" : "markdown");

  // auto-detect whether headers are present if not explicitly given
  const hasHeaders =
    "hasHeaders" in options
      ? options.hasHeaders
      : format === "markdown"
      ? isProbMarkdownWithHeaders(lines) // check for header + divider line
      : isProbCSVWithHeaders(lines[0]); // check if first line matches expected headers

  // parse raw input into row objects based on format
  let rows;
  if (format === "markdown") {
    rows = parseMarkdownTable(trimmed, hasHeaders);
  } else if (format === "csv") {
    const parsed = parseCSVTable(trimmed, hasHeaders);
    rows = parsed.rows;
    meta = parsed.meta;
  }

  // save original input data before transforms
  if (typeof globalThis !== "undefined") {
    globalThis.originalParsedRows = JSON.parse(JSON.stringify(rows)); // clone
  }

  // full transform pipeline:
  // 1. extract and store ^replacements
  // 2. strip definitions but keep shorthand tokens
  // 3. replace shorthand terms across fields
  // 4. apply ^^ inheritance (copy-down)
  // 5. expand any flipped or multi-value fields
  // 6. apply rule logic, sort, and normalise pages
  const replacements = extractReplacements(rows);
  stripDefinitions(rows);
  applyReplacements(rows, replacements);
  applyFieldInheritance(rows);
  const flipped = expandFlippedRows(rows);
  const split = expandSplitRows(flipped);

  // final normalised, sorted, de-duped output
  return processData(split);
}

if (
  (typeof INCLUDE_TESTS === "undefined" || INCLUDE_TESTS) &&
  typeof process !== "undefined" &&
  typeof require !== "undefined" &&
  process.argv &&
  process.argv.includes("-t")
) {
  runTests();
} else if (typeof document !== "undefined") {
  runInBrowser();
}
