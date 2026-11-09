package main

import "strconv"

func parse(s string) (int, error) {
	if s != "" {
		n, err := strconv.Atoi(s)
		if err != nil {
			err = nil
			return 0, err
		}
		return n, nil
	}
	return 0, nil
}

func check(s string) error {
	_, err := strconv.Atoi(s)
	return err
}

func count(xs []int) int {
	total := 0
	for i := 0; i < len(xs); i++ {
		total += xs[i]
	}
	for i := range xs {
		if xs[i] > 0 {
			total++
		}
	}
	return total
}

func main() { parse("1"); check("2"); count(nil) }
