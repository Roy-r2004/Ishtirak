package storage

import (
	"math"
	"testing"
	"time"
)

func TestReadingBounds(t *testing.T) {
	valid := Reading{ReadingID: "r", BuildingID: "b", MeterID: "m", Amps: 5.5, ObservedAt: time.Now()}
	if err := ValidateReadings([]Reading{valid}); err != nil {
		t.Fatal(err)
	}
	if ValidateReadings(nil) == nil || ValidateReadings(make([]Reading, 501)) == nil {
		t.Fatal("batch bounds missing")
	}
	valid.Amps = math.Inf(1)
	if ValidateReadings([]Reading{valid}) == nil {
		t.Fatal("accepted infinite reading")
	}
}
