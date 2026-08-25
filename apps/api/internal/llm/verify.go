package llm

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"
)

// The verifier. This file is the reason the rest of the feature can be trusted.
//
// "The model never invents a number" is, in every other product that says it, a
// sentence in a prompt. A prompt is a request. This is a check:
//
//   * the prose must contain NO DIGIT, in any script
//   * every key in `order` must have been in the input
//   * nothing may be added
//
// Forbidding digits outright, rather than trying to validate the numbers the
// model wrote, is the whole trick. Validating would mean parsing prose,
// matching figures against a source, and deciding how close is close enough —
// an endless and unwinnable job. Forbidding is one predicate, total, and
// impossible to partially satisfy. The reader still sees every number, because
// the figures are rendered from the detector's own sentence underneath the
// prose.
//
// The cost is that the model cannot write "sales fell by a fifth". It can write
// "sales fell noticeably", and the line beneath it says by how much. That is a
// better division of labour anyway: the model is good at connecting two facts
// into a sentence and bad at arithmetic.

// RejectedError means the model answered but the answer was not usable. It
// carries the raw text so the caller can store it — a rejection is the one case
// where keeping a model's output is worth the row.
type RejectedError struct {
	Reason string
	Raw    string
}

func (e *RejectedError) Error() string { return "llm: rejected — " + e.Reason }

// IsRejected reports whether err was a verification failure rather than a
// transport or provider problem. The caller records these separately: a timeout
// is an outage, a rejection is the guard doing its job.
func IsRejected(err error) bool {
	var re *RejectedError
	return errors.As(err, &re)
}

// modelReply is the JSON contract. Deliberately three fields: any more and the
// model starts making decisions that belong in Go.
type modelReply struct {
	Order    []string `json:"order"`
	Headline string   `json:"headline"`
	Body     string   `json:"body"`
}

// MaxHeadlineLen / MaxBodyLen bound the prose. A wrap that runs long stops being
// read, and an unbounded string is an unbounded email.
const (
	MaxHeadlineLen = 90
	MaxBodyLen     = 900
)

// Verify parses and checks a model response.
//
// Exported and pure, with no client and no network, so every rule below is
// tested directly rather than through a mock provider.
func Verify(raw string, allowed []string) (Response, error) {
	var reply modelReply
	// Providers sometimes wrap JSON in a markdown fence even when asked for
	// application/json. Tolerating that is not laxity — it is the same
	// robustness menuImport.ts's parser has, and the strict checks below are
	// where the actual discipline lives.
	if err := json.Unmarshal([]byte(stripFence(raw)), &reply); err != nil {
		return Response{}, fmt.Errorf("unparseable JSON: %w", err)
	}

	if strings.TrimSpace(reply.Body) == "" {
		return Response{}, errors.New("empty body")
	}
	if len(reply.Headline) > MaxHeadlineLen {
		return Response{}, fmt.Errorf("headline is %d chars, max %d", len(reply.Headline), MaxHeadlineLen)
	}
	if len(reply.Body) > MaxBodyLen {
		return Response{}, fmt.Errorf("body is %d chars, max %d", len(reply.Body), MaxBodyLen)
	}

	// THE RULE. unicode.IsDigit rather than a '0'-'9' range, because Devanagari
	// digits (१२३) are digits too and this product runs in Nepal — an
	// ASCII-only check would let exactly the locale we serve through the gap.
	if d, ok := firstDigit(reply.Headline); ok {
		return Response{}, fmt.Errorf("headline contains the digit %q — every figure must come from the finding", d)
	}
	if d, ok := firstDigit(reply.Body); ok {
		return Response{}, fmt.Errorf("body contains the digit %q — every figure must come from the finding", d)
	}

	// The model may reorder and drop. It may not invent.
	permitted := make(map[string]bool, len(allowed))
	for _, k := range allowed {
		permitted[k] = true
	}
	seen := make(map[string]bool, len(reply.Order))
	for _, k := range reply.Order {
		if !permitted[k] {
			return Response{}, fmt.Errorf("order names %q, which was not in the input", k)
		}
		if seen[k] {
			return Response{}, fmt.Errorf("order repeats %q", k)
		}
		seen[k] = true
	}

	return Response{
		Order:    reply.Order,
		Headline: strings.TrimSpace(reply.Headline),
		Body:     strings.TrimSpace(reply.Body),
	}, nil
}

// firstDigit returns the first digit rune in s, in any script.
func firstDigit(s string) (string, bool) {
	for _, r := range s {
		if unicode.IsDigit(r) {
			return string(r), true
		}
	}
	return "", false
}

// stripFence removes a ```json … ``` wrapper if the provider added one.
func stripFence(s string) string {
	t := strings.TrimSpace(s)
	if !strings.HasPrefix(t, "```") {
		return t
	}
	if i := strings.Index(t, "\n"); i >= 0 {
		t = t[i+1:]
	}
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(t), "```"))
}
