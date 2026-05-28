package retrieval

import (
	"math"
	"strings"
	"testing"
)

func TestNormalizeChinese(t *testing.T) {
	got := NormalizeChinese(" 会员，复购率！ＡＢＣ１２３ abc-_%　")
	want := "会员复购率abc123abc"
	if got != want {
		t.Fatalf("NormalizeChinese = %q, want %q", got, want)
	}
}

func TestNgrams(t *testing.T) {
	got := strings.Join(Ngrams("会员复购率", 2), ",")
	want := "会员,员复,复购,购率"
	if got != want {
		t.Fatalf("bigrams = %q, want %q", got, want)
	}
	got = strings.Join(Ngrams("会员复购率", 3), ",")
	want = "会员复,员复购,复购率"
	if got != want {
		t.Fatalf("trigrams = %q, want %q", got, want)
	}
}

func TestSearchFuzzyMatchesMemberRepurchaseRate(t *testing.T) {
	matches := Search([]Item{{Term: "会员复购率", TargetPath: "spec/member-repurchase-rate.md"}}, "会员复购为什么下降", Options{})
	if len(matches) != 1 {
		t.Fatalf("matches = %+v", matches)
	}
	match := matches[0]
	if match.Exact || match.MatchType != "fuzzy" {
		t.Fatalf("match type = exact:%v type:%s", match.Exact, match.MatchType)
	}
	if math.Abs(match.BigramCoverage-0.75) > 0.0001 {
		t.Fatalf("bigram coverage = %f", match.BigramCoverage)
	}
	if strings.Join(match.MatchedBigrams, ",") != "会员,员复,复购" {
		t.Fatalf("matched bigrams = %+v", match.MatchedBigrams)
	}
}

func TestSearchPrefersLongExactTermAndSuppressesShortTerm(t *testing.T) {
	matches := Search([]Item{
		{Term: "会员复购率", TargetPath: "spec/member-repurchase-rate.md"},
		{Term: "19点前滚动7天会员复购率", TargetPath: "spec/bf19-member-repurchase-rate.md"},
	}, "19点前滚动7天会员复购率", Options{})
	if len(matches) != 1 {
		t.Fatalf("matches = %+v", matches)
	}
	if matches[0].Term != "19点前滚动7天会员复购率" || !matches[0].Exact {
		t.Fatalf("unexpected top match: %+v", matches[0])
	}
}

func TestSearchShortTermsDoNotFuzzyExpand(t *testing.T) {
	matches := Search([]Item{
		{Term: "销", TargetPath: "spec/one-rune.md"},
		{Term: "销售", TargetPath: "spec/two-rune.md"},
		{Term: "销售额", TargetPath: "spec/three-rune.md"},
	}, "销售为什么下降", Options{})
	if len(matches) != 1 || matches[0].Term != "销售" || !matches[0].Exact {
		t.Fatalf("matches = %+v", matches)
	}

	matches = Search([]Item{
		{Term: "销售额", TargetPath: "spec/three-rune.md"},
	}, "销售为什么下降", Options{})
	if len(matches) != 0 {
		t.Fatalf("three-rune term should require full bigram coverage, got %+v", matches)
	}

	matches = Search([]Item{
		{Term: "销售", TargetPath: "spec/two-rune.md"},
	}, "销额为什么下降", Options{})
	if len(matches) != 0 {
		t.Fatalf("two-rune term should not fuzzy match, got %+v", matches)
	}
}

func TestSearchSuppressesFuzzyExpansionOfExactTerm(t *testing.T) {
	matches := Search([]Item{
		{Term: "销售额", TargetPath: "spec/sale-amt.md"},
		{Term: "线上销售额", TargetPath: "spec/online-sale-amt.md"},
		{Term: "客单价", TargetPath: "spec/per-cust-amt.md"},
	}, "销售额和客单价最近怎么样", Options{})
	if len(matches) != 2 {
		t.Fatalf("matches = %+v", matches)
	}
	for _, match := range matches {
		if !match.Exact {
			t.Fatalf("unexpected fuzzy match after exact suppression: %+v", match)
		}
		if match.Term == "线上销售额" {
			t.Fatalf("fuzzy expansion should be suppressed: %+v", matches)
		}
	}
}

func TestSearchExactLongAliasSuppressesSiblingFuzzyTerms(t *testing.T) {
	matches := Search([]Item{
		{Term: "会员复购为什么下降", TargetPath: "spec/member-repurchase-rate.md"},
		{Term: "会员复购次数", TargetPath: "spec/member-repurchase-times.md"},
		{Term: "复购会员数", TargetPath: "spec/repurchase-member-num.md"},
	}, "会员复购为什么下降", Options{})
	if len(matches) != 1 {
		t.Fatalf("matches = %+v", matches)
	}
	if matches[0].Term != "会员复购为什么下降" || !matches[0].Exact {
		t.Fatalf("unexpected match: %+v", matches[0])
	}
}

func TestSearchKeepsHighestScorePerTargetPath(t *testing.T) {
	matches := Search([]Item{
		{Term: "会员复购率", TargetPath: "spec/member-repurchase-rate.md"},
		{Term: "会员复购", TargetPath: "spec/member-repurchase-rate.md"},
	}, "会员复购为什么下降", Options{})
	if len(matches) != 1 {
		t.Fatalf("matches = %+v", matches)
	}
	if matches[0].Term != "会员复购" || !matches[0].Exact {
		t.Fatalf("expected exact same-target item, got %+v", matches[0])
	}
}
