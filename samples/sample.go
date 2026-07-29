// Sample Go file for exercising the Okibi dynamic focus layer.
// Move the caret into different { } blocks and watch the ember bar + fill.
// Type to flip Survey 構 → Focus 流 → Edit 異 (status bar, bottom-right).
//
// What to look for:
//   Focus 流 — data identities tint (locals, params, receivers). Struct FIELDS,
//     type names, funcs/methods, and package names stay band-1.
//   Edit 異 — start typing: numbers go clay, escaping writes get a dashed
//     underline; relaxes back to Focus after ~2s.
//   Identity stability — a variable keeps ONE hue across every sub-block of its
//     function, including closures.

package main

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// ── types (names + fields are band-1, not data) ────────────────────────────

// Config is a plain struct — its brace-block is one focus scope.
type Config struct {
	Name    string
	Retries int
	Tags    map[string]string
	timeout int // unexported field
}

// Status is an enum-ish set of constants.
type Status int

const (
	StatusPending Status = iota
	StatusActive
	StatusClosed
)

// Handler is a function type — a transformer identity.
type Handler func(ctx *Context, in []byte) ([]byte, error)

// Context threads request-scoped data through handlers.
type Context struct {
	Deadline int64
	values   map[string]any
	mu       sync.Mutex
}

var ErrNotFound = errors.New("not found")

// ── free functions ─────────────────────────────────────────────────────────

func loadConfig(name string) Config {
	cfg := Config{
		Name:    name,
		Retries: 3,
		Tags:    map[string]string{"env": "dev"},
		timeout: 30,
	}

	// A brace in a string literal must NOT open a block: "}{ not real {"
	label := "range {0..9} placeholder"
	_ = label

	if cfg.Retries > 0 {
		for i := 0; i < cfg.Retries; i++ {
			// deepest block — caret here should focus THIS for-body.
			// cfg + i are borrowed-in data; keep one hue each.
			backoff := 1 << uint(i)
			fmt.Printf("attempt %d for %s (backoff=%dms)\n", i, cfg.Name, backoff)
		}
	}

	return cfg
}

// summarize shows closures: c and acc keep stable hues across .Sort/append.
func summarize(cfgs []Config) string {
	var b strings.Builder
	names := make([]string, 0, len(cfgs))

	for _, c := range cfgs {
		if c.Name == "" {
			continue
		}
		names = append(names, c.Name)
	}

	stuff := make(map[string]string)

	if _, ok := stuff["blah"]; !ok {
		return ErrNotFound.Error()
	}

	sort.Slice(names, func(i, j int) bool {
		return names[i] < names[j]
	})

	for idx, n := range names {
		b.WriteString(fmt.Sprintf("%d:%s x%d; ", idx, n, len(n)))
	}
	return b.String()
}

// ── methods (receivers ARE data; method names are band-1) ───────────────────

func (c *Context) Set(key string, value any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.values == nil {
		c.values = make(map[string]any)
	}
	c.values[key] = value
}

func (c *Context) Get(key string) (any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.values[key]
	if !ok {
		return nil, ErrNotFound
	}
	return v, nil
}

// process demonstrates async (goroutine + channel), error handling, and a
// mutation that escapes the block (writing the outer `total`).
func process(ctx *Context, cfgs []Config, h Handler) (int, error) {
	total := 0
	results := make(chan int, len(cfgs))
	var wg sync.WaitGroup

	for _, c := range cfgs {
		wg.Add(1)
		go func(cfg Config) {
			defer wg.Done()
			out, err := h(ctx, []byte(cfg.Name))
			if err != nil {
				results <- 0
				return
			}
			results <- len(out)
		}(c)
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	for n := range results {
		total += n // escapes the for-body — writes the function-level total
	}

	if total == 0 {
		return 0, fmt.Errorf("no results from %d configs: %w", len(cfgs), ErrNotFound)
	}
	return total, nil
}

func main() {
	cfgs := []Config{
		loadConfig("alpha"),
		loadConfig("beta"),
		loadConfig("gamma"),
	}

	echo := func(ctx *Context, in []byte) ([]byte, error) {
		return in, nil
	}

	total, err := process(&Context{Deadline: 1000}, cfgs, echo)
	if err != nil {
		fmt.Println("error:", err)
		return
	}

	fmt.Println(summarize(cfgs))
	fmt.Printf("processed %d bytes across %d configs\n", total, len(cfgs))
}
