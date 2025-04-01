//  Takes pasted index content as one long string, parses into an array of row objects.
//  For Markdown: Recognizes headers from the first line, skips the divider.
//  Each row is mapped to a dictionary.

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
          console.log(`Defining: "${shorthand}" → "${replacement}"`);
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

// function to escape any special characters that broke... I mean, *might break*
// regex functions.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

      // step 1 - identify & replace !escaped terms with placeholders
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

      // step 2 - apply replacements to unescaped terms
      for (const [shorthand, replacement] of Object.entries(replacements)) {
        const regex = new RegExp(`\\b${escapeRegExp(shorthand)}\\b`, "gi");
        text = text.replace(regex, replacement);
      }

      // step 3 - restore escaped terms
      for (const [placeholder, original] of Object.entries(placeholders)) {
        const restoreRegex = new RegExp(escapeRegExp(placeholder), "g");
        text = text.replace(restoreRegex, original);
      }

      // set the field in the row back to whatever string we've built (or not,
      // if there were no matches)
      row[field] = text;
    });
  }
}

// An attempt at a rules engine... Each rule is kept separate to
// enable future tweaking/addition of rules. Or re-ordering, as
// the order trickles down.
function processData(rows) {
  const processed = [];
  let last = { term: "", subTerm: "", notes: "", book: 0, page: 0 };

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
    let page = hasPage ? parseInt(rawPage) : 0;

    // Rule 1 - Row only has `term`, all other fields blank:
    // Copy `book` and `page` from previous row
    if (
      hasTerm &&
      !hasSubTerm &&
      !hasNotes &&
      !hasBook &&
      !hasPage &&
      !rawTerm.endsWith("*")
    ) {
      term = rawTerm;
      subTerm = "";
      notes = "";
      book = last.book;
      page = last.page;
    }

    // Rule 2 - `term*` or `term *` (ends with asterisk), all others blank:
    // Copy sub-term, notes, book, page from previous row
    else if (
      hasTerm &&
      !hasSubTerm &&
      !hasNotes &&
      !hasBook &&
      !hasPage &&
      rawTerm.endsWith("*")
    ) {
      term = rawTerm.replace(/\*$/, "");
      subTerm = last.subTerm;
      notes = last.notes;
      book = last.book;
      page = last.page;
    }

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
      page = hasPage ? parseInt(rawPage) : last.page;
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
    const termCmp = a.term.localeCompare(b.term);
    if (termCmp !== 0) return termCmp;

    const subCmp = a.subTerm.localeCompare(b.subTerm);
    if (subCmp !== 0) return subCmp;

    return a.book - b.book;
  });

  return processed;
}

// Create and render an HTML table from the `processed` dict object
function renderToHTML(data) {
  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr><th>Term</th><th>Sub-term</th><th>Notes</th><th>Book</th><th>Page</th></tr>
    </thead>
    <tbody>
      ${data
        .map(
          (row) => `
        <tr>
          <td>${row.term}</td>
          <td>${row.subTerm}</td>
          <td>${row.notes}</td>
          <td>${row.book}</td>
          <td>${row.page}</td>
        </tr>
      `
        )
        .join("")}
    </tbody>
  `;

  document.getElementById("output").innerHTML = "";
  document.getElementById("output").appendChild(table);
}

// perform all the actions when `Create Index` button is pressed.
function runInBrowser() {
  document
    .getElementById("create_index_button")
    .addEventListener("click", () => {
      const markdown = document.getElementById("index_input").value;
      const rows = parseMarkdownTable(markdown);
      const replacements = extractReplacements(rows);
      stripDefinitions(rows);
      applyReplacements(rows, replacements);
      const processed = processData(rows);
      renderToHTML(processed);
    });
}

function runTests() {
  const test_markdown_input = `
    | term              | sub-term | notes                                  | book | page |
    |-------------------|----------|----------------------------------------|------|------|
    | vuln^vulnerability|          | Vuln is bad.                           | 1    | 10   |
    | vuln              |          | vuln is common.                        |      |      |
    | ttp^"tactics, techniques & procedures" |   | !ttp should not be replaced           | 1    | 11   |
    `;

  const expected_output = [
    {
      term: "tactics, techniques & procedures",
      subTerm: "",
      notes: "ttp should not be replaced",
      book: 1,
      page: 11,
    },
    {
      term: "vulnerability",
      subTerm: "",
      notes: "vulnerability is bad.",
      book: 1,
      page: 10,
    },
    {
      term: "vulnerability",
      subTerm: "",
      notes: "vulnerability is common.",
      book: 1,
      page: 10,
    },
  ];

  const rows = parseMarkdownTable(test_markdown_input);
  const replacements = extractReplacements(rows);
  stripDefinitions(rows);
  applyReplacements(rows, replacements);
  const processed = processData(rows);

  const passed = JSON.stringify(processed) === JSON.stringify(expected_output);

  if (passed) {
    console.log("✅ Test passed.");
    process.exit(0);
  } else {
    console.error("❌ Test failed.");
    console.error("Expected:", JSON.stringify(expected_output, null, 2));
    console.error("Received:", JSON.stringify(processed, null, 2));
    process.exit(1);
  }
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv.includes("-t")
) {
  runTests();
} else if (typeof document !== "undefined") {
  runInBrowser();
}
