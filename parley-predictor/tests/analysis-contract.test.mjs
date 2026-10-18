import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { test } from "node:test";
import typescript from "typescript";

const sourcePath = path.resolve("tests/../src/lib/analysis-contract.ts");
const source = readFileSync(sourcePath, "utf8");
const compiled = typescript.transpileModule(source, {
  compilerOptions: {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2020,
  },
}).outputText;
const contractModule = new Module(sourcePath);
contractModule.filename = sourcePath;
contractModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
contractModule._compile(compiled, sourcePath);

const { parseNormalizedData } = contractModule.exports;

test("normalization removes excluded metrics from objects and arrays", () => {
  const result = parseNormalizedData({
    normalizedData: {
      "saques de banda": 4,
      "goal kicks": 2,
      offsides: 3,
      "passes in own half": 12,
      "goals by foot": 1,
      "shots hit the post": 1,
      corners: 8,
      metrics: { name: "Offside", count: 2 },
      events: [
        { metric: "saques de meta", count: 2 },
        { name: "foot goals", count: 1 },
        { label: "corners", count: 7 },
      ],
    },
  });

  assert.deepEqual(result, {
    corners: 8,
    events: [{ label: "corners", count: 7 }],
  });
});
