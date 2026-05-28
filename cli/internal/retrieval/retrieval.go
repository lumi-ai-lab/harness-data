package retrieval

import (
	"sort"
	"strings"
	"unicode"
)

type Item struct {
	Term       string `json:"term"`
	TargetPath string `json:"targetPath"`
}

type Options struct {
	TopN int
}

type Match struct {
	Term                string   `json:"term"`
	TargetPath          string   `json:"targetPath"`
	NormalizedTerm      string   `json:"normalizedTerm"`
	Score               float64  `json:"score"`
	Exact               bool     `json:"exact"`
	MatchType           string   `json:"matchType"`
	TermRuneLen         int      `json:"termRuneLen"`
	BigramCoverage      float64  `json:"bigramCoverage"`
	TrigramCoverage     float64  `json:"trigramCoverage"`
	MatchedBigramCount  int      `json:"matchedBigramCount"`
	MatchedTrigramCount int      `json:"matchedTrigramCount"`
	MatchedBigrams      []string `json:"matchedBigrams"`
	MatchedTrigrams     []string `json:"matchedTrigrams"`
}

func NormalizeChinese(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\u3000':
			continue
		case r >= '\uff01' && r <= '\uff5e':
			r -= '\ufee0'
		}
		r = unicode.ToLower(r)
		if unicode.Is(unicode.Han, r) || unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func Ngrams(s string, n int) []string {
	if n <= 0 {
		return []string{}
	}
	runes := []rune(s)
	if len(runes) < n {
		return []string{}
	}
	grams := make([]string, 0, len(runes)-n+1)
	for i := 0; i <= len(runes)-n; i++ {
		grams = append(grams, string(runes[i:i+n]))
	}
	return grams
}

func Search(items []Item, question string, opts Options) []Match {
	normalizedQuestion := NormalizeChinese(question)
	if normalizedQuestion == "" {
		return []Match{}
	}
	queryBigrams := ngramSet(Ngrams(normalizedQuestion, 2))
	queryTrigrams := ngramSet(Ngrams(normalizedQuestion, 3))
	byTarget := map[string]Match{}
	for _, item := range items {
		match, ok := scoreItem(item, normalizedQuestion, queryBigrams, queryTrigrams)
		if !ok {
			continue
		}
		if existing, ok := byTarget[match.TargetPath]; !ok || matchLess(match, existing) {
			byTarget[match.TargetPath] = match
		}
	}
	matches := make([]Match, 0, len(byTarget))
	for _, match := range byTarget {
		matches = append(matches, match)
	}
	sort.SliceStable(matches, func(i, j int) bool {
		return matchLess(matches[i], matches[j])
	})
	matches = suppressContainedTerms(matches)
	if opts.TopN > 0 && len(matches) > opts.TopN {
		matches = matches[:opts.TopN]
	}
	return matches
}

func scoreItem(item Item, normalizedQuestion string, queryBigrams, queryTrigrams map[string]bool) (Match, bool) {
	normalizedTerm := NormalizeChinese(item.Term)
	if normalizedTerm == "" || item.TargetPath == "" {
		return Match{}, false
	}
	termRuneLen := len([]rune(normalizedTerm))
	termBigrams := Ngrams(normalizedTerm, 2)
	termTrigrams := Ngrams(normalizedTerm, 3)
	matchedBigrams, bigramCoverage := coverage(termBigrams, queryBigrams)
	matchedTrigrams, trigramCoverage := coverage(termTrigrams, queryTrigrams)
	match := Match{
		Term:                item.Term,
		TargetPath:          item.TargetPath,
		NormalizedTerm:      normalizedTerm,
		TermRuneLen:         termRuneLen,
		BigramCoverage:      bigramCoverage,
		TrigramCoverage:     trigramCoverage,
		MatchedBigramCount:  len(matchedBigrams),
		MatchedTrigramCount: len(matchedTrigrams),
		MatchedBigrams:      matchedBigrams,
		MatchedTrigrams:     matchedTrigrams,
	}
	if strings.Contains(normalizedQuestion, normalizedTerm) {
		match.Exact = true
		match.MatchType = "exact"
		match.Score = 10000 + float64(termRuneLen*100)
		return match, true
	}
	if termRuneLen <= 2 {
		return Match{}, false
	}
	switch {
	case termRuneLen == 3:
		if bigramCoverage < 1.0 {
			return Match{}, false
		}
	default:
		if len(matchedBigrams) < 2 || bigramCoverage < 0.5 {
			return Match{}, false
		}
	}
	match.MatchType = "fuzzy"
	match.Score = bigramCoverage*100 + trigramCoverage*80 + float64(len(matchedBigrams))*5 + float64(len(matchedTrigrams))*8 + float64(termRuneLen)
	return match, true
}

func coverage(grams []string, query map[string]bool) ([]string, float64) {
	unique := uniqueOrdered(grams)
	if len(unique) == 0 {
		return []string{}, 0
	}
	matched := make([]string, 0, len(unique))
	for _, gram := range unique {
		if query[gram] {
			matched = append(matched, gram)
		}
	}
	return matched, float64(len(matched)) / float64(len(unique))
}

func ngramSet(grams []string) map[string]bool {
	set := make(map[string]bool, len(grams))
	for _, gram := range grams {
		set[gram] = true
	}
	return set
}

func uniqueOrdered(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func suppressContainedTerms(matches []Match) []Match {
	filtered := make([]Match, 0, len(matches))
	for _, match := range matches {
		containedBySelected := false
		for _, selected := range filtered {
			switch {
			case match.NormalizedTerm == selected.NormalizedTerm:
			case strings.Contains(selected.NormalizedTerm, match.NormalizedTerm):
				containedBySelected = true
			case selected.Exact && !match.Exact && strings.Contains(match.NormalizedTerm, selected.NormalizedTerm):
				containedBySelected = true
			case selected.Exact && !match.Exact && len(match.MatchedBigrams) > 0 && containsAll(selected.MatchedBigrams, match.MatchedBigrams):
				containedBySelected = true
			}
			if containedBySelected {
				break
			}
		}
		if containedBySelected {
			continue
		}
		filtered = append(filtered, match)
	}
	return filtered
}

func containsAll(values, subset []string) bool {
	valueSet := map[string]bool{}
	for _, value := range values {
		valueSet[value] = true
	}
	for _, value := range subset {
		if !valueSet[value] {
			return false
		}
	}
	return true
}

func matchLess(a, b Match) bool {
	if a.Exact != b.Exact {
		return a.Exact
	}
	if a.Score != b.Score {
		return a.Score > b.Score
	}
	if a.TermRuneLen != b.TermRuneLen {
		return a.TermRuneLen > b.TermRuneLen
	}
	if a.Term != b.Term {
		return a.Term < b.Term
	}
	return a.TargetPath < b.TargetPath
}
