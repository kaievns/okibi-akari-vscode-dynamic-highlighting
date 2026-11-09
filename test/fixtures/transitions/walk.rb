# frozen_string_literal: true

# A queue of jobs, synthetic: every construct the walks need.
class Queue
  attr_reader :size

  def self.build(n) = new(n)

  def initialize(size)
    @size = size
    @items = []
  end

  def push(job, priority = 1)
    pushed = 0
    @items.each do |item|
      pushed += 1 if item.priority > priority
    end
    @items << job
    pushed
  end

  def report(p)
    text = <<~EOS
      #{p} jobs
      def not_code; end
    EOS
    total = 0
    @items.each { |job| total += job.cost * 2 }
    half = total /2
    opts = p ? { half: half } : {}
    format("%d jobs, %.2f total", p, total) + text + opts.to_s
  end
end

def count_words(lines)
  count = 0
  lines.each do |line|
    case line
    when /^#/ then next
    else
      count += line.split.size
    end
  end
  count
end

$jobs = Queue.new(10)
puts count_words(["a b", "# c"]) if __FILE__ == $PROGRAM_NAME
