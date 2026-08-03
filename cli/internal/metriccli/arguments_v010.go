package metriccli

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// The definitions in this file mirror qdm-metric-cli v0.1.0. Updating the
// pinned real CLI requires an explicit compatibility review of these schemas.

type stringListFlagV010 []string

func (values *stringListFlagV010) String() string {
	return strings.Join(*values, ",")
}

func (values *stringListFlagV010) Set(value string) error {
	*values = append(*values, value)
	return nil
}

type analysisArgumentsV010 struct {
	Socket          string
	Timeout         time.Duration
	RequestID       string
	Payload         string
	PayloadJSON     string
	StartDate       string
	EndDate         string
	TimeGrain       string
	StatisticPolicy string
	SinglePage      bool
	OrderBy         string
	YOY             bool
	MOM             bool
	BizThreshold    bool
	ScopeJSON       string
	CurrPage        int
	PageSize        int
	Format          string
	Output          string
	Metrics         stringListFlagV010
	Dimensions      stringListFlagV010
	Filters         stringListFlagV010
	OtherFilters    stringListFlagV010
	MeasureFilters  stringListFlagV010
	Visited         map[string]bool
}

type wikisArgumentsV010 struct {
	Code      string
	RequestID string
	Socket    string
	Timeout   time.Duration
	Output    string
}

type dimensionSearchArgumentsV010 struct {
	Keyword   string
	Metric    string
	RequestID string
	Socket    string
	Timeout   time.Duration
	Exact     bool
	Limit     int
	Format    string
	Output    string
}

func parseAnalysisArgumentsV010(args []string) (analysisArgumentsV010, error) {
	flags := flag.NewFlagSet("analysis", flag.ContinueOnError)
	flags.SetOutput(io.Discard)

	result := analysisArgumentsV010{
		Timeout:         60 * time.Second,
		StatisticPolicy: "SUMMARY",
		Format:          "json",
		Output:          "data",
		Visited:         map[string]bool{},
	}
	flags.StringVar(&result.Socket, "socket", "", "")
	flags.DurationVar(&result.Timeout, "timeout", result.Timeout, "")
	flags.StringVar(&result.RequestID, "request-id", "", "")
	flags.StringVar(&result.Payload, "payload", "", "")
	flags.StringVar(&result.PayloadJSON, "payload-json", "", "")
	flags.StringVar(&result.StartDate, "start-date", "", "")
	flags.StringVar(&result.EndDate, "end-date", "", "")
	flags.StringVar(&result.TimeGrain, "time-grain", "", "")
	flags.StringVar(&result.StatisticPolicy, "statistic-policy", result.StatisticPolicy, "")
	flags.BoolVar(&result.SinglePage, "single-page", false, "")
	flags.StringVar(&result.OrderBy, "order-by", "", "")
	flags.BoolVar(&result.YOY, "yoy", false, "")
	flags.BoolVar(&result.MOM, "mom", false, "")
	flags.BoolVar(&result.BizThreshold, "biz-thresh", false, "")
	flags.StringVar(&result.ScopeJSON, "scope-json", "", "")
	flags.IntVar(&result.CurrPage, "curr-page", 0, "")
	flags.IntVar(&result.CurrPage, "page-no", 0, "")
	flags.IntVar(&result.PageSize, "page-size", 0, "")
	flags.StringVar(&result.Format, "format", result.Format, "")
	flags.StringVar(&result.Output, "output", result.Output, "")
	flags.Var(&result.Metrics, "metric", "")
	flags.Var(&result.Dimensions, "agg-dim", "")
	flags.Var(&result.Filters, "filter", "")
	flags.Var(&result.OtherFilters, "other-filter", "")
	flags.Var(&result.MeasureFilters, "measure-filter", "")

	if err := flags.Parse(args); err != nil {
		return analysisArgumentsV010{}, err
	}
	if flags.NArg() != 0 {
		return analysisArgumentsV010{}, fmt.Errorf(
			"unexpected arguments: %s",
			strings.Join(flags.Args(), " "),
		)
	}
	flags.Visit(func(item *flag.Flag) {
		result.Visited[item.Name] = true
	})
	return result, nil
}

func parseWikisArgumentsV010(args []string) (wikisArgumentsV010, error) {
	flags := flag.NewFlagSet("wikis", flag.ContinueOnError)
	flags.SetOutput(io.Discard)

	result := wikisArgumentsV010{Timeout: 60 * time.Second, Output: "data"}
	flags.StringVar(&result.Code, "code", "", "")
	flags.StringVar(&result.RequestID, "request-id", "", "")
	flags.StringVar(&result.Socket, "socket", "", "")
	flags.DurationVar(&result.Timeout, "timeout", result.Timeout, "")
	flags.StringVar(&result.Output, "output", result.Output, "")
	if err := flags.Parse(args); err != nil {
		return wikisArgumentsV010{}, err
	}
	if flags.NArg() != 0 {
		return wikisArgumentsV010{}, errors.New("wikis does not accept positional arguments")
	}
	return result, nil
}

func parseDimensionSearchArgumentsV010(args []string) (dimensionSearchArgumentsV010, error) {
	flags := flag.NewFlagSet("dim search", flag.ContinueOnError)
	flags.SetOutput(io.Discard)

	result := dimensionSearchArgumentsV010{
		Timeout: 60 * time.Second,
		Limit:   20,
		Format:  "json",
		Output:  "data",
	}
	flags.StringVar(&result.Keyword, "keyword", "", "")
	flags.StringVar(&result.Metric, "metric", "", "")
	flags.StringVar(&result.RequestID, "request-id", "", "")
	flags.StringVar(&result.Socket, "socket", "", "")
	flags.DurationVar(&result.Timeout, "timeout", result.Timeout, "")
	flags.BoolVar(&result.Exact, "exact", false, "")
	flags.IntVar(&result.Limit, "limit", result.Limit, "")
	flags.StringVar(&result.Format, "format", result.Format, "")
	flags.StringVar(&result.Output, "output", result.Output, "")
	if err := flags.Parse(args); err != nil {
		return dimensionSearchArgumentsV010{}, err
	}
	if flags.NArg() != 0 {
		return dimensionSearchArgumentsV010{}, errors.New("dim search does not accept positional arguments")
	}
	return result, nil
}

func appendStringFlagIfVisited(result []string, visited map[string]bool, name, value string) []string {
	if visited[name] {
		return append(result, "--"+name+"="+value)
	}
	return result
}

func appendDurationFlagIfVisited(result []string, visited map[string]bool, name string, value time.Duration) []string {
	if visited[name] {
		return append(result, "--"+name+"="+value.String())
	}
	return result
}

func appendBoolFlagIfVisited(result []string, visited map[string]bool, name string, value bool) []string {
	if visited[name] {
		return append(result, "--"+name+"="+strconv.FormatBool(value))
	}
	return result
}
