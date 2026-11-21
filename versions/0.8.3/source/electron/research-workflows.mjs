const referenceSection = /^(?:(?:\d+(?:\.\d+)*\.?\s*)?(?:references|bibliography|works cited)\b|参考文献)/i;
const appendixSection = /^(?:(?:appendix|appendices|supplementary)\b|附录)/i;
const letteredAppendixSection = /^(?:[A-H]|[a-h])(?:\.\d+)*\.?\s+[A-Za-z](?![A-Z])/;
const isAppendixSection = (section) => appendixSection.test(section) || letteredAppendixSection.test(section);
const namedHeading = /^(?:(?:\d+(?:\.\d+)*|[A-H](?:\.\d+)*)\.?\s+)?(?:abstract|introduction|related work|background|preliminar(?:y|ies)|problem (?:setup|formulation|statement)|methods?|methodology|approach|experiments?(?: and results)?|experimental setup|evaluation|results?|analysis|discussion|conclusions?|limitations?|future work|references|bibliography|acknowledge?ments?|appendix(?: [A-Z0-9]+)?|appendices|supplementary(?: material)?|摘要|引言|相关工作|背景|方法|实验|结果|分析|讨论|结论|局限|参考文献|附录)\s*:?$/i;
const numberedHeading = /^(?:\d+(?:\.\d+){0,3}|[A-H](?:\.\d+){0,3})\.?\s+[A-Z][A-Za-z0-9\-–:,&()/' ]{2,80}$/;

export function isSectionHeading(line) {
  const value = String(line ?? "").trim();
  if (value.length < 3 || value.length > 90 || /^(?:figure|fig\.|table|algorithm|eq\.|equation)\b/i.test(value)) return false;
  return namedHeading.test(value) || numberedHeading.test(value);
}

function sectionLabel(chunk) {
  const explicit = typeof chunk.section === "string" ? chunk.section.trim() : "";
  return isSectionHeading(explicit) ? explicit.slice(0, 120) : "";
}

export function makePaperBatches(chunks, maxChars = 16_000) {
  const skippedSections = new Set();
  const sectionsRead = [];
  const body = [];
  const appendix = [];
  let activeSection = "正文";
  let inReferences = false;
  let inAppendix = false;
  for (const chunk of chunks) {
    const detected = sectionLabel(chunk);
    if (detected && referenceSection.test(detected)) inReferences = true;
    else if (detected && isAppendixSection(detected)) { inReferences = false; inAppendix = true; }
    if (inReferences) {
      skippedSections.add(detected || "参考文献");
      continue;
    }
    if (detected) activeSection = detected;
    if (!sectionsRead.includes(activeSection)) sectionsRead.push(activeSection);
    (inAppendix ? appendix : body).push({ chunk, section: activeSection });
  }

  const batches = [];
  for (const part of [body, appendix]) {
    let batch = null;
    for (const { chunk, section } of part) {
      const cost = String(chunk.text ?? "").length + String(chunk.chunkId ?? "").length + 32;
      if (!batch || (batch.chars + cost > maxChars && batch.chunks.length)) {
        batch = { sections: [], chunks: [], chars: 0 };
        batches.push(batch);
      }
      batch.chunks.push({ ...chunk, section });
      batch.chars += cost;
      if (!batch.sections.includes(section)) batch.sections.push(section);
    }
  }
  const label = (sections) => sections.length <= 2 ? sections.join(" · ") : `${sections[0]} … ${sections.at(-1)}`;
  return {
    batches: batches.map(({ sections, chunks: batchChunks }) => ({ section: label(sections), sections, chunks: batchChunks })),
    sectionsRead,
    skippedSections: [...skippedSections],
  };
}

export function cleanTextForModel(text) {
  return String(text ?? "")
    .replace(/([A-Za-z])\s+-\s+([A-Za-z])/g, "$1-$2")
    .replace(/(\d)\s+,\s+(\d{3}\b)/g, "$1,$2")
    .replace(/(\d)\s+\.\s+(\d)/g, "$1.$2")
    .replace(/(?:\s*[→←↑↓⇒⇐↔]\s*){2,}/g, " ")
    .replace(/\[\s+(\d)/g, "[$1").replace(/(\d)\s+\]/g, "$1]")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"];
export function cappedEffort(setting, cap = "medium") {
  const index = EFFORT_ORDER.indexOf(setting);
  if (index < 0) return cap;
  return EFFORT_ORDER[Math.min(index, EFFORT_ORDER.indexOf(cap))];
}

export function preparePaperText(chunks, { charLimit = 150_000 } = {}) {
  const layout = makePaperBatches(chunks, Number.POSITIVE_INFINITY);
  const appendixBatches = layout.batches.filter((batch) => batch.sections.some(isAppendixSection));
  const bodyBatches = layout.batches.filter((batch) => !batch.sections.some(isAppendixSection));
  const bodyChunks = bodyBatches.flatMap((batch) => batch.chunks);
  const appendixChunks = appendixBatches.flatMap((batch) => batch.chunks);
  const size = (items) => items.reduce((sum, chunk) => sum + String(chunk.text ?? "").length, 0);
  const bodyChars = size(bodyChunks);
  const appendixChars = size(appendixChunks);
  const appendixOmitted = appendixChunks.length > 0 && (bodyChars > charLimit || bodyChars + appendixChars > charLimit);
  const includedAppendixSections = appendixOmitted ? [] : appendixBatches.flatMap((batch) => batch.sections);
  const sectionsRead = [...bodyBatches.flatMap((batch) => batch.sections), ...includedAppendixSections];
  const skippedSections = [...new Set([
    ...layout.skippedSections,
    ...(appendixOmitted ? ["附录（单次阅读长度优先保留正文）"] : []),
  ])];
  return {
    mode: "full",
    chunks: appendixOmitted ? bodyChunks : [...bodyChunks, ...appendixChunks],
    sectionsRead: [...new Set(sectionsRead)],
    skippedSections,
    bodyChars,
    appendixChars,
    appendixOmitted,
    bodyExceedsCharLimit: bodyChars > charLimit,
  };
}

export function mergeFullTextParts(partA = {}, partB = {}) {
  const analysisScript = [partA.analysisScript, partB.analysisScript]
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean)
    .join("\n\n");
  return { analysisScript };
}

export function getResumableFullTextAnalysis(checkpoint, sourceSha256, depth, parts) {
  if (!Array.isArray(parts) || !parts.length) return null;
  if (!checkpoint || checkpoint.readMode !== "full-text" || checkpoint.analysisFormat !== "guided-script-v1" || checkpoint.sourceSha256 !== sourceSha256 || checkpoint.depth !== depth) return null;
  if (!Array.isArray(checkpoint.expectedParts) || checkpoint.expectedParts.length !== parts.length || checkpoint.expectedParts.some((part, index) => part !== parts[index])) return null;
  if (!checkpoint.fullTextParts || typeof checkpoint.fullTextParts !== "object" || Array.isArray(checkpoint.fullTextParts)) return null;
  const fullTextParts = {};
  let completed = 0;
  for (const part of parts) {
    const output = checkpoint.fullTextParts[part];
    if (!output || typeof output !== "object" || Array.isArray(output) || typeof output.analysisScript !== "string" || !output.analysisScript.trim()) break;
    fullTextParts[part] = { analysisScript: output.analysisScript.trim() };
    completed += 1;
  }
  return { fullTextParts, completed };
}

export function getResumableAnalysis(checkpoint, sourceSha256, depth, batchCount) {
  if (!Number.isInteger(batchCount) || batchCount < 1) return null;
  if (!checkpoint || checkpoint.sourceSha256 !== sourceSha256 || checkpoint.depth !== depth || checkpoint.batchCount !== batchCount) return null;
  if (!checkpoint.batches || typeof checkpoint.batches !== "object" || Array.isArray(checkpoint.batches)) return null;
  const batches = {};
  const notes = [];
  let completed = 0;
  for (; completed < batchCount; completed += 1) {
    const key = String(completed);
    const value = checkpoint.batches[key];
    if (typeof value !== "string" && !Array.isArray(value)) break;
    batches[key] = value;
    notes.push(...(Array.isArray(value) ? value : [value]));
  }
  return { batches, notes, completed };
}

export function parseModelJson(value) {
  const text = String(value ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  if (start < 0) throw new Error("模型输出中没有 JSON 对象。");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start, index + 1));
  }
  throw new Error("模型输出中的 JSON 不完整。");
}

export function papersNeedingAnalysis(papers) {
  return (Array.isArray(papers) ? papers : []).filter((paper) => {
    if (paper?.status !== "parsed") return false;
    const hasScript = typeof paper.analysisScript === "string" && Boolean(paper.analysisScript.trim());
    return !hasScript || paper.analysisStatus !== "complete" || paper.analysisSourceSha256 !== paper.sourceSha256;
  });
}

export function makeIdeaId(project) {
  let number = project.ideas.reduce((max, idea) => {
    const match = /^idea_(\d+)$/.exec(idea.id);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0) + 1;
  return `idea_${String(number).padStart(3, "0")}`;
}
