import test from "node:test";
import assert from "node:assert/strict";
import { searchChunks, termsFor } from "./retrieval.mjs";

test("termsFor creates Chinese bigrams and English terms", () => {
  assert.deepEqual(termsFor("增量 BPE cache"), ["bpe", "cache", "增量"]);
});

test("searchChunks ranks matching evidence and applies the result limit", () => {
  const chunks = [
    { chunkId: "p1#p1.c1", page: 1, text: "缓存可以减少重复计算。" },
    { chunkId: "p2#p3.c1", page: 3, text: "BPE merges subword tokens." },
    { chunkId: "p3#p2.c1", page: 2, text: "增量 BPE 缓存复用 merge ranks。" },
  ];
  const found = searchChunks("增量 BPE 缓存", chunks, 2);
  assert.equal(found.length, 2);
  assert.equal(found[0].chunkId, "p3#p2.c1");
});
