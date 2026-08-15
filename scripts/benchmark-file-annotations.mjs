import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { heatmapBucket } = require("../dist/domain/fileAnnotations.js");
const { fileBlameAnnotationText } = require("../dist/ui/blame/blamePresentation.js");

const lineCount = 5_000;
const iterations = 10;
const now = Date.UTC(2026, 7, 15);
const lines = Array.from({ length: lineCount }, (_, index) => ({
  authorDate: now - (index % 500) * 86_400_000,
  authorName: `Author ${index % 20}`,
  isCommitted: index % 31 !== 0,
  path: "src/benchmark.ts",
  sha: (index % 100).toString(16).padStart(40, "0"),
  summary: `benchmark commit ${index % 100}`,
}));

let renderedCharacters = 0;
const prepareAnnotations = () => {
  for (const blame of lines) {
    renderedCharacters += fileBlameAnnotationText(blame, "Author 0", now, "detailed").length;
    heatmapBucket(blame.isCommitted ? blame.authorDate : null, now);
  }
};

prepareAnnotations();
prepareAnnotations();
const started = performance.now();
for (let iteration = 0; iteration < iterations; iteration += 1) {
  prepareAnnotations();
}
const elapsedMs = performance.now() - started;

assert.ok(renderedCharacters > 0);
assert.ok(
  elapsedMs < 2_000,
  `Annotation presentation exceeded the 2,000 ms guardrail: ${elapsedMs.toFixed(1)} ms`,
);
process.stdout.write(
  `Prepared ${(lineCount * iterations).toLocaleString("en-US")} blame/heatmap line presentations in ${elapsedMs.toFixed(1)} ms.\n`,
);
