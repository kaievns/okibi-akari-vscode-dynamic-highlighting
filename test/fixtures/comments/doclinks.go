package main

import "strings"

// MaxRetries caps retries.
const MaxRetries = 3

// Retry retries count times; see [MaxRetries] and [strings.Repeat].
//
//	total := Retry(3)
func Retry(count int) int {
	// count is bumped; see [MaxRetries]
	_ = strings.Repeat
	return count + MaxRetries
}
