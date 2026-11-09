package loader

import (
	"fmt"
	"strings"
)

// MaxRetries bounds [Load]; see [strings.Repeat].
const MaxRetries = 3

func Load(path string) (int, error) {
	total := 0
	for i := 0; i < MaxRetries; i++ {
		if len(path) > 10 {
			total += len(path) * 2
		}
	}
	add := func(x int) int { return x + total }
	fmt.Println(strings.Repeat(path, add(1)))
	return total, nil
}
