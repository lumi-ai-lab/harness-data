export function normalizeChinese(s) {
  let out = "";
  for (const r of s) {
    let code = r.codePointAt(0);
    if (code === 0x3000) continue;
    if (code >= 0xff01 && code <= 0xff5e) code -= 0xfee0;
    const ch = String.fromCodePoint(code).toLowerCase();
    if (/\p{Script=Han}|\p{L}|\p{N}/u.test(ch)) out += ch;
  }
  return out;
}

export function ngrams(s, n) {
  if (n <= 0) return [];
  const runes = [...s];
  if (runes.length < n) return [];
  const grams = [];
  for (let i = 0; i <= runes.length - n; i++) grams.push(runes.slice(i, i + n).join(""));
  return grams;
}

export function search(items, question, opts = {}) {
  const normalizedQuestion = normalizeChinese(question);
  if (!normalizedQuestion) return [];
  const queryBigrams = ngramSet(ngrams(normalizedQuestion, 2));
  const queryTrigrams = ngramSet(ngrams(normalizedQuestion, 3));
  const byTarget = new Map();
  for (const item of items) {
    const match = scoreItem(item, normalizedQuestion, queryBigrams, queryTrigrams);
    if (!match) continue;
    const existing = byTarget.get(match.targetPath);
    if (!existing || matchLess(match, existing)) byTarget.set(match.targetPath, match);
  }
  let matches = [...byTarget.values()];
  matches.sort((a, b) => (matchLess(a, b) ? -1 : matchLess(b, a) ? 1 : 0));
  matches = suppressContainedTerms(matches);
  const topN = opts.topN || 0;
  if (topN > 0 && matches.length > topN) matches = matches.slice(0, topN);
  return matches;
}

function scoreItem(item, normalizedQuestion, queryBigrams, queryTrigrams) {
  const normalizedTerm = normalizeChinese(item.term);
  if (!normalizedTerm || !item.targetPath) return null;
  const termRuneLen = [...normalizedTerm].length;
  const termBigrams = ngrams(normalizedTerm, 2);
  const termTrigrams = ngrams(normalizedTerm, 3);
  const [matchedBigrams, bigramCoverage] = coverage(termBigrams, queryBigrams);
  const [matchedTrigrams, trigramCoverage] = coverage(termTrigrams, queryTrigrams);
  const match = {
    term: item.term,
    targetPath: item.targetPath,
    normalizedTerm,
    termRuneLen,
    bigramCoverage,
    trigramCoverage,
    matchedBigramCount: matchedBigrams.length,
    matchedTrigramCount: matchedTrigrams.length,
    matchedBigrams,
    matchedTrigrams,
    exact: false,
    matchType: "",
    score: 0,
  };
  if (normalizedQuestion.includes(normalizedTerm)) {
    match.exact = true;
    match.matchType = "exact";
    match.score = 10000 + termRuneLen * 100;
    return match;
  }
  if (termRuneLen <= 2) return null;
  if (termRuneLen === 3) {
    if (bigramCoverage < 1.0) return null;
  } else if (matchedBigrams.length < 2 || bigramCoverage < 0.5) {
    return null;
  }
  match.matchType = "fuzzy";
  match.score =
    bigramCoverage * 100 +
    trigramCoverage * 80 +
    matchedBigrams.length * 5 +
    matchedTrigrams.length * 8 +
    termRuneLen;
  return match;
}

function coverage(grams, query) {
  const unique = uniqueOrdered(grams);
  if (unique.length === 0) return [[], 0];
  const matched = unique.filter((gram) => query.has(gram));
  return [matched, matched.length / unique.length];
}

function ngramSet(grams) {
  return new Set(grams);
}

function uniqueOrdered(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function suppressContainedTerms(matches) {
  const filtered = [];
  for (const match of matches) {
    let containedBySelected = false;
    for (const selected of filtered) {
      if (match.normalizedTerm === selected.normalizedTerm) continue;
      if (selected.normalizedTerm.includes(match.normalizedTerm)) containedBySelected = true;
      else if (selected.exact && !match.exact && match.normalizedTerm.includes(selected.normalizedTerm)) {
        containedBySelected = true;
      } else if (
        selected.exact &&
        !match.exact &&
        match.matchedBigrams.length > 0 &&
        containsAll(selected.matchedBigrams, match.matchedBigrams)
      ) {
        containedBySelected = true;
      }
      if (containedBySelected) break;
    }
    if (!containedBySelected) filtered.push(match);
  }
  return filtered;
}

function containsAll(values, subset) {
  const valueSet = new Set(values);
  return subset.every((value) => valueSet.has(value));
}

function matchLess(a, b) {
  if (a.exact !== b.exact) return a.exact;
  if (a.score !== b.score) return a.score > b.score;
  if (a.termRuneLen !== b.termRuneLen) return a.termRuneLen > b.termRuneLen;
  if (a.term !== b.term) return a.term < b.term;
  return a.targetPath < b.targetPath;
}
