package main

import (
	"fmt"
	"log"
	"net/url"
	str "strings"
	_ "embed"
	. "math"
	yaml "gopkg.in/yaml.v3"
	"example.com/go-thing/v2"
)

type server struct {
	log *log.Logger
	url string
}

func shadowParam(url string) string {
	return url + fmt.Sprint(Pi)
}

func shadowLocal() {
	u, err := url.Parse("x")
	fmt.Println(u, err)
	log := log.New(nil, "", 0)
	log.Print("x")
}

func keys() server {
	return server{log: log.Default(), url: "x"}
}

func closure() func() {
	return func() {
		fmt.Println(str.ToUpper("a"), yaml.Marshal, thing.X)
	}
}

func (s *server) method(fmt string) {
	s.log.Print(fmt)
	// fmt.Println in a comment
	_ = "fmt.Println in a string"
}

func varBlock() {
	var (
		log    = newLogger()
		prefix = "a" +
			fmt.Sprint("b")
	)
	log.Print(prefix)
	const n, url = 1, 2
	var k, str = n, url
	_ = url.Host
	_ = str.Builder{}
	fmt.Println(k)
}
