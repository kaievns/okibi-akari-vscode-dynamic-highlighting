package main

import "fmt"

var counter = 0
var total int

type Config struct {
	Retries int
	Name    string
}

// counter = 5 in a comment
/* total = 1 */

func (c *Config) Bump(retries int) {
	c.Retries = retries
	c.Retries += 1
}

func sum(items []int) int {
	acc := 0
	for _, x := range items {
		acc += x
		total += x
	}
	counter++
	var label = fmt.Sprint(acc)
	a, b := 1, 2
	a, b = b, a
	cfg := Config{Retries: 1, Name: label}
	cfg.Retries = a
	s := `counter = 1`
	_ = s
	return acc + b
}

func params(retries int) int {
	retries = retries - 1
	if retries > 0 {
		retries--
	}
	f := func(n int) int { n = n + 1; return n + retries }
	return f(retries)
}

func main() {
	fmt.Println(sum([]int{1}), params(2))
}

func deref(p *int, m map[string]int) {
	*p = 1
	m["k"] = 2
	flags := 3
	flags &^= 1
	counter &^= 1
	_ = flags
}
