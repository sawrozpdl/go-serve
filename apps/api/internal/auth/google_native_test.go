package auth

import "testing"

func TestNativeAudiences(t *testing.T) {
	tests := []struct {
		name string
		cfg  GoogleConfig
		want []string
	}{
		{"all three", GoogleConfig{ClientID: "web", ClientIDAndroid: "and", ClientIDIOS: "ios"}, []string{"web", "and", "ios"}},
		{"web only", GoogleConfig{ClientID: "web"}, []string{"web"}},
		{"skips empties", GoogleConfig{ClientID: "web", ClientIDIOS: "ios"}, []string{"web", "ios"}},
		{"none", GoogleConfig{}, []string{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.cfg.nativeAudiences()
			if len(got) != len(tt.want) {
				t.Fatalf("len = %d, want %d (%v)", len(got), len(tt.want), got)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestAudienceAllowed(t *testing.T) {
	allowed := []string{"web", "android", "ios"}
	tests := []struct {
		name string
		aud  []string
		want bool
	}{
		{"web audience", []string{"web"}, true},
		{"android audience", []string{"android"}, true},
		{"ios audience", []string{"ios"}, true},
		{"multiple, one matches", []string{"other", "ios"}, true},
		{"no match", []string{"attacker-client"}, false},
		{"empty", nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := audienceAllowed(tt.aud, allowed); got != tt.want {
				t.Fatalf("audienceAllowed(%v) = %v, want %v", tt.aud, got, tt.want)
			}
		})
	}
}
