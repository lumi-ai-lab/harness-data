package wikis

import "testing"

func TestMetricDuplicateCrossSystemUsesIndicatorsDomain(t *testing.T) {
	if !metricDuplicateCrossSystem([]MetricDuplicateFileItem{
		{Domain: "cmr"},
		{Domain: "indicators"},
	}) {
		t.Fatal("cmr + indicators should be cross-system")
	}
	if metricDuplicateCrossSystem([]MetricDuplicateFileItem{
		{Domain: "cmr"},
		{Domain: "idx"},
	}) {
		t.Fatal("cmr + idx should not be treated as cross-system")
	}
}
