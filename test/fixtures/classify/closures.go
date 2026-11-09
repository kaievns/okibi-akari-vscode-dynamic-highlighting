package main

import (
	"sort"
	"strconv"
)

func order(names []string, ages []int) {
	sort.Slice(names, func(i, j int) bool {
		return names[i] < names[j]
	})
	sort.Slice(ages, func(i, j int) bool {
		return ages[i] < ages[j]
	})
}

func parse(s string) (int, error) {
	n, err := strconv.Atoi(s)
	return n + len(s), err
}

type Server struct{ hits int }

func (srv *Server) Handle(path string) int {
	srv.hits++
	return len(path) + srv.hits
}

func other() int {
	total := 1
	return total
}

func outer(items []int) int {
	total := 0
	add := func(n int) {
		total += n
	}
	for _, item := range items {
		add(item)
	}
	return total
}

func shadow(c int) int {
	double := func(c int) int {
		return c * 2
	}
	return double(c) + c
}
