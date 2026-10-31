function normalizeEvidenceText(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s\p{Cf}]+/gu, "");
}

export function verifyEvidence(ref, chunkText) {
  if (typeof ref?.quote !== "string" || typeof chunkText !== "string") return false;

  const quote = normalizeEvidenceText(ref.quote);
  if (!quote) return false;

  return normalizeEvidenceText(chunkText).includes(quote);
}
