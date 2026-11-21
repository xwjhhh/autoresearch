import test from "node:test";
import assert from "node:assert/strict";
import { verifyEvidence } from "./evidence.mjs";

test("verifies an English quote despite case, punctuation, spacing, and line breaks", () => {
  assert.equal(
    verifyEvidence(
      { quote: "The STATE-OF-THE-ART model,\nreduces compute!" },
      "Results: the state of the art model reduces\ncompute in repeated runs.",
    ),
    true,
  );
});

test("joins words split by a PDF line-break hyphen", () => {
  assert.equal(
    verifyEvidence({ quote: "crosslingual model" }, "A cross-\nlingual model is evaluated."),
    true,
  );
});

test("verifies Chinese and English text while ignoring punctuation and case", () => {
  assert.equal(
    verifyEvidence(
      { quote: "研究发现 Transformer 模型（Transformer models）有效。" },
      "本研究发现：transformer模型 - TRANSFORMER MODELS，有效！",
    ),
    true,
  );
});

test("rejects a fabricated quote that is not a normalized substring", () => {
  assert.equal(
    verifyEvidence(
      { quote: "The model outperforms all prior methods by 42 percent" },
      "The model was compared with prior methods, but no performance result was reported.",
    ),
    false,
  );
});

test("rejects missing, empty, and non-string quotes", () => {
  assert.equal(verifyEvidence({}, "some source text"), false);
  assert.equal(verifyEvidence({ quote: "   ... — " }, "some source text"), false);
  assert.equal(verifyEvidence({ quote: 42 }, "42"), false);
  assert.equal(verifyEvidence({ quote: "some text" }, null), false);
});
