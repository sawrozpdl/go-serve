// Package mcp exposes one café's data to the owner's OWN AI assistant.
//
// # THE PRODUCT DECISION THIS IMPLEMENTS
//
// We do not build a chatbot. An owner who wants to ask questions in prose
// already has ChatGPT or Claude open; what they lack is a way to point it at
// their café. So this package is a doorway, not a conversation — the same
// philosophy the bulk menu import ships with, where the prompt is ours and the
// model is theirs.
//
// TRANSPORT: STATELESS STREAMABLE HTTP, NO SSE
//
// One POST, one JSON response, no session ids, no long-lived stream. That is
// spec-legal, and it is also the ONLY shape that survives this deployment: the
// documented 60-second connection ceiling (docs/DEPLOY.md) would sever an SSE
// stream every minute. The legacy 2024-11-05 HTTP+SSE transport is deliberately
// not supported; a client that requires it will not work here, and pretending
// otherwise would mean shipping something that breaks in the first minute.
//
// # WHY JSON-RPC BY HAND
//
// The surface is five methods. The official Go SDK is pre-1.0 and pulls a tree,
// and go.mod has eight direct dependencies for a reason — internal/jobs makes
// the same call ("ONE goroutine, not a cron library"). This file is the whole
// protocol.
package mcp

import (
	"encoding/json"
	"fmt"
)

// protocolVersion is the MCP revision this server implements.
const protocolVersion = "2025-06-18"

// serverName / serverVersion identify us in the client's connector list.
const (
	serverName    = "goserve"
	serverVersion = "1.0.0"
)

// JSON-RPC 2.0 error codes. The reserved range is the spec's; the application
// codes below it are ours.
const (
	codeParse          = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternal       = -32603
)

// request is one JSON-RPC call.
//
// ID is json.RawMessage rather than any: the spec allows a string or a number,
// and it must be echoed back BYTE-IDENTICAL. Decoding into `any` turns a large
// integer id into a float and hands the client back something it did not send.
type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// isNotification reports whether this call wants no reply. A notification has no
// id, and answering one is a protocol violation that some clients treat as a
// hard error.
func (r request) isNotification() bool { return len(r.ID) == 0 }

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data,omitempty"`
}

func ok(id json.RawMessage, result any) response {
	return response{JSONRPC: "2.0", ID: id, Result: result}
}

func fail(id json.RawMessage, code int, msg string, detail ...string) response {
	e := &rpcError{Code: code, Message: msg}
	if len(detail) > 0 {
		e.Data = detail[0]
	}
	return response{JSONRPC: "2.0", ID: id, Error: e}
}

// --- initialize -----------------------------------------------------------

type initializeResult struct {
	ProtocolVersion string             `json:"protocolVersion"`
	Capabilities    serverCapabilities `json:"capabilities"`
	ServerInfo      serverInfo         `json:"serverInfo"`
	// Instructions is shown to the model as standing context. It is the only
	// place we get to shape how an assistant we do not control talks about this
	// café's numbers, so it is worth writing carefully.
	Instructions string `json:"instructions,omitempty"`
}

type serverCapabilities struct {
	// Tools only. No resources, no prompts, no sampling: every one of those is
	// another surface to secure for a café that asked for none of them.
	Tools struct {
		ListChanged bool `json:"listChanged"`
	} `json:"tools"`
}

type serverInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// instructions is the standing note to whichever assistant connects.
//
// It cannot be enforced — this is somebody else's model, and that is the whole
// point of the design. But an assistant told what the numbers mean gives better
// answers than one left to guess, and the last line is the one that matters
// most: our own weekly wrap is forbidden from inventing figures, and it would be
// strange not to ask the same of a guest.
const instructions = `This server exposes one cafe's own business data, read-only, to its owner.

Notes that will make your answers correct:
- All money is in paisa (1/100 of a Nepali rupee) unless a field name says otherwise. Rs 1,234.56 is 123456.
- "Net revenue" is what the cafe earned: takings minus VAT, including service charge, after discounts. It is the basis for profit. Do not use menu-item sales totals for profit — they ignore discounts and may include VAT.
- Revenue is attributed to when a bill was SETTLED, not when it was ordered. A tab opened at 2pm and paid at 6pm counts at 6pm, so hour-by-hour figures are settlement times.
- "Credit" (house tabs) is money billed but not yet collected. Collecting it later is not a new sale.
- Date ranges are resolved in the cafe's own timezone. Prefer the named range presets (7d, 30d, mtd, thisweek) over explicit dates.

Please quote figures as they are returned rather than recomputing them, and say when something is not in the data rather than estimating it.`

// --- tools/list -----------------------------------------------------------

type toolsListResult struct {
	Tools []toolDescriptor `json:"tools"`
}

type toolDescriptor struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// --- tools/call -----------------------------------------------------------

type toolCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

type toolCallResult struct {
	Content []contentBlock `json:"content"`
	// IsError reports a TOOL failure, as distinct from a protocol failure. The
	// difference matters: a protocol error tells the client we are broken, while
	// this tells the MODEL that its call did not work and it may try something
	// else. Returning the wrong one either hides a real fault or makes a
	// recoverable mistake look fatal.
	IsError bool `json:"isError,omitempty"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func textResult(s string) toolCallResult {
	return toolCallResult{Content: []contentBlock{{Type: "text", Text: s}}}
}

func errorResult(format string, args ...any) toolCallResult {
	return toolCallResult{
		Content: []contentBlock{{Type: "text", Text: fmt.Sprintf(format, args...)}},
		IsError: true,
	}
}
