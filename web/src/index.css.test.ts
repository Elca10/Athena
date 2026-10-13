import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.:]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no rule found for ${selector}`);
  return match[1];
}

describe("index.css button hover specificity", () => {
  // The generic `button:hover { background: var(--row-hover); }` rule has
  // higher specificity (type + pseudo-class) than a single modifier class
  // like `.btn-primary` on its own, so a hover rule that only sets `filter`
  // silently loses its background to the grey row-hover color on actual
  // mouse hover. Each variant's :hover rule must re-declare `background`
  // itself to win outright.
  it.each(["--accent", "--danger"])(
    "re-declares background in the matching variant's :hover rule (%s)",
    (token) => {
      const selector = token === "--accent" ? ".btn-primary:hover" : ".btn-danger:hover";
      expect(ruleBody(selector)).toMatch(new RegExp(`background:\\s*var\\(${token}\\)`));
    },
  );
});
