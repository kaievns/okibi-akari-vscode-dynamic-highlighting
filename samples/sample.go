// Sample Go file for exercising the Okibi dynamic focus layer.
// Move the caret into different { } blocks and watch the ember bar + fill.
// Type to flip Survey 構 → Focus 流 → Edit 異 (status bar, bottom-right).

package main

import (
	"fmt"
	"strings"
)

// Config is a plain struct — its brace-block is one focus scope.
type Config struct {
	Name    string
	Retries int
	Tags    map[string]string
}

func loadConfig(name string) Config {
	cfg := Config{
		Name:    name,
		Retries: 3,
		Tags:    map[string]string{"env": "dev"},
	}

	// A brace in a string literal must NOT open a block: "}{ not real {"
	label := "range {0..9} placeholder"
	_ = label

	if cfg.Retries > 0 {
		for i := 0; i < cfg.Retries; i++ {
			// deepest block — caret here should focus THIS for-body
			fmt.Printf("attempt %d for %s\n", i, cfg.Name)
		}
	}

	return cfg
}

func summarize(cfgs []Config) string {
	var b strings.Builder
	for _, c := range cfgs {
		if c.Name == "" {
			continue
		}
		b.WriteString(fmt.Sprintf("%s x%d; ", c.Name, c.Retries))
	}
	return b.String()
}

func main() {
	cfgs := []Config{
		loadConfig("alpha"),
		loadConfig("beta"),
	}
	fmt.Println(summarize(cfgs))
}
