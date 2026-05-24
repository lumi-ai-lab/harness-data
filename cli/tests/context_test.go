package tests

import (
	"bytes"
	"encoding/json"
	"testing"

	dhcontext "harness-data/cli/internal/context"
)

func TestMemberRepurchaseContext(t *testing.T) {
	response, err := dhcontext.Build(root(t), "华东区最近会员复购为什么下降？")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{"spec/member/index.md", "spec/member/repurchase.md", "spec/member/report-contract.md", "routing/member-overview.md"} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
}

func TestStoreProfitDoesNotReturnMemberSpec(t *testing.T) {
	response, err := dhcontext.Build(root(t), "门店净利润最近表现")
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range response.ContextFiles {
		if ref.Path == "spec/member/index.md" || ref.Path == "spec/member/repurchase.md" {
			t.Fatalf("unexpected member spec: %#v", response.ContextFiles)
		}
	}
}

func TestMemberCategoryUnsupported(t *testing.T) {
	response, err := dhcontext.Build(root(t), "全品类用户报表")
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range response.ContextFiles {
		if ref.Path == "spec/member/category-unsupported.md" {
			return
		}
	}
	t.Fatalf("missing category unsupported rule: %#v", response.ContextFiles)
}

func TestMultiDomainContextRecall(t *testing.T) {
	response, err := dhcontext.Build(root(t), "会员复购和门店净利润最近为什么下降？")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"spec/member/repurchase.md",
		"spec/store/profit-efficiency.md",
		"routing/member-overview.md",
		"routing/store-overview.md",
		"playbooks/member/default-overview.md",
		"playbooks/store/default-overview.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
}

func TestClaudeHookFormatOmitsQueryType(t *testing.T) {
	payload := bytes.NewBufferString(`{"prompt":"会员复购为什么下降？"}`)
	ok, output, err := dhcontext.RunClaudeHook(root(t), payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := json.Marshal(output)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{"hookSpecificOutput", "UserPromptSubmit", "spec/member/repurchase.md"} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, text)
		}
	}
	if bytes.Contains(data, []byte("query_type=")) {
		t.Fatalf("unexpected query_type in %s", text)
	}
}
