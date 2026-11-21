const normalize = (text) => text.normalize("NFKC").toLocaleLowerCase();

export function termsFor(query) {
  const normalized = normalize(query);
  const words = normalized.match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
  const cjk = normalized.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) words.push(run);
    for (let i = 0; i < run.length - 1; i += 1) words.push(run.slice(i, i + 2));
  }
  return [...new Set(words.filter((word) => word.length > 1 || /[\u3400-\u9fff]/.test(word)))];
}

export function searchChunks(query, chunks, limit = 8) {
  const terms = termsFor(query);
  if (!terms.length) return [];
  return chunks
    .map((chunk) => {
      const body = normalize(`${chunk.section ?? ""} ${chunk.text}`);
      const score = terms.reduce((total, term) => total + (body.includes(term) ? 1 + Math.min(2, body.split(term).length - 2) * 0.15 : 0), 0);
      return { chunk, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.page - b.chunk.page || a.chunk.chunkId.localeCompare(b.chunk.chunkId))
    .slice(0, limit)
    .map(({ chunk }) => chunk);
}
