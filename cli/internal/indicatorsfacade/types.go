package indicatorsfacade

import (
	"context"
	"io"
	"time"
)

const (
	protectedAreaCode     = "manageAreaId"
	protectedCategoryCode = "categoryLevel1Id"
)

type Limits struct {
	MaxDateRangeDays     int
	MaxIndicators        int
	MaxDimensions        int
	DefaultPageSize      int
	MaxPageSize          int
	DefaultMetadataLimit int
	MaxMetadataLimit     int
	Timeout              time.Duration
	MaxOutputBytes       int64
	PollInterval         time.Duration
}

func (l Limits) validate() error {
	if l.MaxDateRangeDays <= 0 || l.MaxIndicators <= 0 || l.MaxDimensions <= 0 ||
		l.DefaultPageSize <= 0 || l.MaxPageSize <= 0 || l.DefaultPageSize > l.MaxPageSize ||
		l.DefaultMetadataLimit <= 0 || l.MaxMetadataLimit <= 0 || l.DefaultMetadataLimit > l.MaxMetadataLimit ||
		l.Timeout <= 0 || l.MaxOutputBytes <= 0 || l.PollInterval <= 0 {
		return deny(CodeAuthzConfigInvalid, "授权部署限额无效", nil)
	}
	return nil
}

// AuthorizationContext is the minimum immutable snapshot required by the
// facade. Identity fields are used only for redacted audit correlation.
type AuthorizationContext struct {
	WorkspaceID       string
	AgentID           string
	SessionID         string
	RequestID         string
	BotID             string
	CanonicalUserID   string
	PolicyRevision    string
	EnvelopeSHA256    string
	CatalogSHA256     string
	ArtifactSHA256    string
	ManageAreaIDs     []string
	CategoryLevel1IDs []string
}

// Guard always reopens the authoritative control and Session files. A Guard
// instance is bound to exactly one decoded HarnessAuthzBinding.
type Guard interface {
	Initial(context.Context) (AuthorizationContext, error)
	Revalidate(context.Context) error
}

type RunnerConfig struct {
	RealCLIPath      string
	RealCLIConfigDir string
	WorkingDirectory string
	CatalogPath      string
	CatalogSHA256    string
	ArtifactSHA256   string
	Limits           Limits
	ExtraChildEnv    []string
}

type Dependencies struct {
	Guard      Guard
	VerifyFile func(path, expectedSHA256 string, executable bool) error
	Now        func() time.Time
	Audit      io.Writer
	DecisionID string
}

type Result struct {
	Stdout     []byte
	DecisionID string
}

type operationKind string

const (
	kindAnalysis           operationKind = "analysis.execute"
	kindIndicatorSearch    operationKind = "indicator.search"
	kindDimSearch          operationKind = "dim.search"
	kindDimValues          operationKind = "dim.values"
	kindWikis              operationKind = "wikis"
	kindDictionaryList     operationKind = "dictionary.list"
	kindDictionaryDetail   operationKind = "dictionary.detail"
	kindDictionaryVersions operationKind = "dictionary.versions"
	kindDictionaryChange   operationKind = "dictionary.change-log"
	kindDictionaryIDName   operationKind = "dictionary.id-by-name"
	kindDictionaryDict     operationKind = "dictionary.dict"
	kindDictionaryStatuses operationKind = "dictionary.statuses"
)

type filterValue struct {
	Code string
	IDs  []string
}

type measureFilter struct {
	Indicator string
	Operator  string
	Value     string
}

type operation struct {
	Kind operationKind

	StartDate        string
	EndDate          string
	Indicators       []string
	AggDims          []string
	ColumnAggDims    []string
	Filters          []filterValue
	OtherFilters     []filterValue
	MeasureFilters   []measureFilter
	IndicatorsGroup  int
	StoreCollectType int
	PageSize         int
	CurrentPage      int
	OrderByField     string
	OrderByDirection string
	AI               bool
	YOY              bool
	MOM              bool

	Keyword   string
	Code      string
	ID        string
	Name      string
	Limit     int
	Page      int
	QueryType int
	DictType  int

	ApprovedIndicator   string
	EffectiveAreas      []string
	EffectiveCategories []string
	CanonicalArgv       []string
}

func (o operation) metadata() bool { return o.Kind != kindAnalysis }
