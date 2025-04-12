// Takes pasted index content as one long string, parses into an array of row objects.
// For Markdown: Recognises headers from the first line, skips the divider.
// Each row is mapped to a dictionary.
// Flags comment rows (starting with '?') with _ignore: true.
function parseMarkdownTable(markdown) {
  const lines = markdown
    .trim()
    .split("\n")
    .map((line) => line.trim());

  if (lines.length < 2) return [];

  const headers = lines[0]
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((h) => h.trim());
  const dataLines = lines.slice(2);

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
      if ((row[field] || "").trim() === "^^") {
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
// The output is sorted for HTML or export rendering.
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
      term = rawTerm || last.term;
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
  document.getElementById("export_csv_button").onclick = () =>
    exportToCSV(data);
  document.getElementById("export_excel_button").onclick = () =>
    exportToExcel(data);

  const table = document.createElement("table");
  const rows = [];

  if (isCollapsed) {
    // default view == collapsed mode — uses rowspan to reduce visual duplication
    // Exports to CSV/Excel with current view
    let i = 0;
    while (i < data.length) {
      const current = data[i];
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
    // expanded view — no rowspan, show all values. Exports to CSV/Excel with current view
    data.forEach((row) => {
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

  document.getElementById("output").innerHTML = "";
  document.getElementById("output").appendChild(table);
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

// actions to perform when `Create Index` pressed:
function runInBrowser() {
  // setup event handlers for export buttons
  document.getElementById("export_csv_button").onclick = () =>
    exportToCSV(currentRenderedData);
  document.getElementById("export_excel_button").onclick = () =>
    exportToExcel(currentRenderedData);

  // setup event handler for collapse/expand button
  document
    .getElementById("toggle_collapse_button")
    .addEventListener("click", () => {
      isCollapsed = !isCollapsed;
      document.getElementById("toggle_collapse_button").textContent =
        isCollapsed ? "Expand duplicate fields" : "Collapse duplicate fields";
      renderToHTML(currentRenderedData, isCollapsed);
    });

  // generate and render index
  document
    .getElementById("create_index_button")
    .addEventListener("click", () => {
      document.getElementById("export_csv_button").style.display =
        "inline-block";
      document.getElementById("export_excel_button").style.display =
        "inline-block";
      document.getElementById("toggle_collapse_button").style.display =
        "inline-block";

      const markdown = document.getElementById("index_input").value;
      const rows = parseMarkdownTable(markdown);
      const replacements = extractReplacements(rows);
      stripDefinitions(rows);
      applyReplacements(rows, replacements);
      applyFieldInheritance(rows);
      const flippedRows = expandFlippedRows(rows);
      const splitRows = expandSplitRows(flippedRows);
      const processed = processData(splitRows);

      currentRenderedData = processed;
      isCollapsed = true;
      renderToHTML(currentRenderedData, isCollapsed);
    });
}

// called by other export functions (below)
function getExportData(data, isCollapsed) {
  if (!isCollapsed) return data; // return full data for expanded mode

  const exportData = [];
  let lastTerm = null;
  let lastSubTerm = null;

  for (const row of data) {
    const term = row.term === lastTerm ? "" : row.term;
    const subTerm =
      row.term === lastTerm && row.subTerm === lastSubTerm ? "" : row.subTerm;

    exportData.push({
      term,
      subTerm,
      notes: row.notes,
      book: row.book,
      page: row.page,
    });

    lastTerm = row.term;
    lastSubTerm = row.subTerm;
  }

  return exportData;
}

// export to csv... not sure how useful this actually is
function exportToCSV(data) {
  const exportData = getExportData(data, isCollapsed);

  const rows = [
    ["Term", "Sub-term", "Notes", "Book", "Page"],
    ...exportData.map((row) => [
      stripMarkdown(row.term),
      stripMarkdown(row.subTerm),
      stripMarkdown(row.notes),
      row.book,
      row.page,
    ]),
  ];

  const csvContent = rows
    .map((r) =>
      r.map((field) => `"${String(field).replace(/"/g, '""')}"`).join(",")
    )
    .join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "index.csv";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// export to Excel using xlsx library
function exportToExcel(data) {
  const exportData = getExportData(data, isCollapsed);

  const rows = [
    ["Term", "Sub-term", "Notes", "Book", "Page"],
    ...exportData.map((row) => [
      stripMarkdown(row.term),
      stripMarkdown(row.subTerm),
      stripMarkdown(row.notes),
      row.book,
      row.page,
    ]),
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Index");

  XLSX.writeFile(workbook, "index.xlsx");
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
