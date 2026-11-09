#!/usr/bin/env ruby
# frozen_string_literal: true
# encoding: utf-8

require "json"
require_relative "support/helper"

=begin
A block comment with def and end inside,
  and "quotes" and #{interp} that are not code.
=end

# A YARD-documented module.
module Shapes
  VERSION = "1.2.0"
  ORIGIN = [0, 0].freeze

  # @param x [Integer] the abscissa
  # @param y [Integer] the ordinate
  # @return [Point]
  class Point
    attr_accessor :x, :y
    attr_reader :label

    @@count = 0
    $registry = {}

    def initialize(x, y, label: "p")
      @x = x
      @y = y
      @label = label
      @@count += 1
      $registry[label] = self
    end

    def self.origin = new(0, 0)

    def +(other)
      Point.new(x + other.x, y + other.y)
    end

    def ==(other) = other.is_a?(Point) && x == other.x && y == other.y

    def [](i)
      i.zero? ? x : y
    end

    def scale!(factor)
      @x *= factor
      @y = @y * factor
      self
    end

    def to_s
      "Point(#{x}, #{y}) #{@label} #$registry"
    end

    class << self
      def count
        @@count
      end

      def reset!
        @@count = 0
      end
    end

    private

    def method_missing(name, *args, **opts, &blk)
      return super unless name.to_s.start_with?("get_")
      field = name.to_s.delete_prefix("get_")
      public_send(field, *args, **opts, &blk)
    end

    def respond_to_missing?(name, include_private = false)
      name.to_s.start_with?("get_") || super
    end
  end
end

module StringRefinements
  refine String do
    def shout
      upcase + "!"
    end
  end
end

using StringRefinements

def totals(items, tax: 0.1, **extra)
  sum = 0
  count = 0
  items.each do |item|
    next if item.nil?
    sum += item.price
    count += 1
  end
  items.each_with_index { |(name, price), idx| puts "#{idx}: #{name} #{price}" }
  avg = count.zero? ? 0 : sum / count
  total = sum * (1 + tax)
  { sum:, avg:, total:, extra: extra }
end

def blocks_and_params
  pairs = { a: 1, b: 2 }
  pairs.map { |k, v| [k, v * 2] }.to_h
  pairs.each { |key, (lo, hi), *rest, last:, **kw, &cb| key }
  [1, 2, 3].map { _1 * 2 }
  [1, 2, 3].map { it + 1 }
  [[1, 2]].each { |a; shadow| shadow = a }
  doubler = ->(n) { n * 2 }
  tripler = lambda { |n| n * 3 }
  adder = proc { |a, b = 1| a + b }
  doubler.(3) + tripler[4] + adder.call(1)
end

def control_flow(n)
  result = []
  i = 0
  while i < n
    i += 1
    next if i.odd?
    redo if false
    break if i > 10
    result << i
  end
  until n.zero?
    n -= 1
  end
  for j in 1..3 do
    result.push(j)
  end
  begin
    n += 1
  end while n < 5
  result << n unless n.negative?
  x = if n > 3 then :big else :small end
  y = n > 0 ? "pos" : "neg"
  loop do
    break
  end
  case n
  when 1, 2 then :low
  when 3..5
    :mid
  else
    :high
  end
  [result, x, y]
end

def matching(config)
  expected = 42
  case config
  in { name: String => name, version: [Integer => major, *] }
    "#{name} v#{major}"
  in { port: ^expected }
    "default port"
  in [first, *tail] if first > 0
    tail.size
  in Integer | Float => num
    num.to_s
  else
    nil
  end
  config => { name: }
  config in { version: }
  name
end

def errors
  attempts = 0
  begin
    attempts += 1
    raise ArgumentError, "bad" if attempts < 3
    Integer("x")
  rescue ArgumentError => e
    retry if attempts < 3
    warn e.message
  rescue TypeError, NameError
    fail "type"
  else
    :ok
  ensure
    attempts = 0
  end
  value = Integer("1") rescue 0
  throw :done if value.zero?
  catch(:done) { throw :done, 1 }
  value
end

def strings_and_literals
  name = "world"
  single = 'it\'s #{not} interpolated'
  double = "hello #{name} and #{name.upcase + "!"} \t é \n"
  words = %w[alpha beta #notacomment]
  syms = %i[one two three]
  quoted = %q(a (nested) paren)
  big = %Q{braces {nested} #{name}}
  plain = %(parens #{name})
  angle = %<angle <nested> >
  pipes = %|pipe #{name}|
  sym = :symbol
  qsym = :"quoted #{name}"
  dsym = :'single quoted'
  ops = [:+, :[], :<=>, :!, :name=, :a?]
  hash = { key: 1, "str key": 2, :old => 3, "k" => 4 }
  char = ?a
  esc = ?\n
  shell = `echo #{name}`
  shell2 = %x(ls -la)
  re = /wor(ld)?\s#{name}/i
  re2 = %r{^/path/#{name}/\d+$}x
  div = 10 / 2 / 1
  ratio = div / 3
  fmt = format("%05.2f %s %-10s %%", 3.14159, name, "x")
  fmt2 = "%d items" % [3]
  fmt3 = sprintf("%<a>s and %{b}", a: 1, b: 2)
  printf("%x\n", 255)
  [single, double, words, syms, quoted, big, plain, angle, pipes, sym, qsym, dsym, ops, hash, char, esc, shell, shell2, re, re2, ratio, fmt, fmt2, fmt3]
end

def heredocs(name)
  text = <<~EOS
    Dear #{name},
    def not_code; end
    if this were code it would end here
  EOS
  raw = <<-'RAW'
    no #{interpolation} here
    RAW
  a, b = <<~A, <<~B
    first #{name}
  A
    second
  B
  sql = <<~SQL.strip.squeeze(" ")
    SELECT * FROM t WHERE x = 1
  SQL
  call(<<~ONE, name)
    inside a call
  ONE
  [text, raw, a, b, sql]
end

def numbers
  [1_000_000, 0x1F, 0b1010, 0o17, 017, 1r, 2i, 1.5r, 3ri, 1e3, 1.5e-3, 12.34, -7]
end

def endless(x) = x * 2
def endless_args(a, b) = a + b

def safe_nav(user)
  user&.profile&.name || "anon"
end

def globals_and_specials
  $stdout.puts $PROGRAM_NAME
  $counter ||= 0
  $counter += 1
  last = $~
  arg0 = $0
  __method__.to_s + __FILE__ + __LINE__.to_s + __dir__
end

def yielder
  return enum_for(:yielder) unless block_given?
  yield 1
  yield(2)
  3
end

def kernel_shadows(p, puts)
  print = p + puts
  print
end

def closure_capture
  total = 0
  seen = []
  [1, 2].each do |v|
    total += v
    seen << v
    $last = v
    @last = v
  end
  counter = 0
  increment = -> { counter += 1 }
  increment.call
  [total, seen, counter]
end

BEGIN { $started = Time.now }
END { puts "done" }

if __FILE__ == $PROGRAM_NAME
  puts totals([])
end

__END__
This is data, not code: def foo; end
#{name} and "quotes" and 'more'
