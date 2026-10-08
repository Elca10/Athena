// node:test custom reporter (node --test-reporter=./scripts/ci/githubTestReporter.mjs)
// that turns each failing test into a GitHub Actions `::error::` workflow
// command, so a failure is visible from the check-run's public annotations
// API even when nobody fetching results has the auth needed for full job
// logs (see athena-build/brief.md priority item 0 — Windows CI runs were
// failing with no way to see which test or why without that auth).
// Meant to run alongside, not instead of, a normal human-readable reporter
// (e.g. `--test-reporter=spec --test-reporter-destination=stdout
// --test-reporter=./scripts/ci/githubTestReporter.mjs
// --test-reporter-destination=stdout`).

function escapeData(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function firstLine(message) {
  return String(message ?? "failed").split("\n")[0];
}

export default async function* githubTestReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const { name, file, line, details } = event.data;
    const error = details?.error;
    const message = firstLine(error?.cause?.message ?? error?.message ?? error);

    const props = [];
    if (file) props.push(`file=${escapeProperty(file)}`);
    if (line) props.push(`line=${escapeProperty(line)}`);
    props.push(`title=${escapeProperty(name ?? "test failed")}`);

    yield `::error ${props.join(",")}::${escapeData(message)}\n`;
  }
}
