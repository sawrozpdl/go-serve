package httpx

import "testing"

func TestLocalUploadsPrefix(t *testing.T) {
	for in, want := range map[string]string{
		"/uploads":                             "/uploads",
		"/uploads/":                            "/uploads",
		"https://api.example.com/uploads":      "/uploads",
		"https://api.example.com/uploads/":     "/uploads",
		"https://api.example.com/files/public": "/files/public",
		"":                                     "/uploads",
		"https://api.example.com":              "/uploads",
	} {
		if got := localUploadsPrefix(in); got != want {
			t.Errorf("localUploadsPrefix(%q) = %q, want %q", in, got, want)
		}
	}
}
