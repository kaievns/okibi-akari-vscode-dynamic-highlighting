package main

func swap(xs []int) (int, int) {
	a, b := 1, 2
	for range xs {
		a, b = b, a
	}
	return a, b
}
