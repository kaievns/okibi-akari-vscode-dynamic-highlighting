#include <algorithm>
#include <cstdio>
#include <format>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <vector>

#define CHECK(cond) do { if (!(cond)) std::abort(); } while (0)

namespace geo {

constexpr int kLimit = 8;

template <typename T>
struct Box {
  T value;
  int uses = 0;
  [[nodiscard]] T get() const { return value; }
};

class Shape {
 public:
  explicit Shape(std::string name) : name_(std::move(name)), area_(0.0) {}
  virtual ~Shape() = default;
  virtual double area() const = 0;
  const std::string& name() const { return name_; }

 protected:
  void grow(double by) noexcept {
    area_ += by;
    this->area_ *= 2;
  }
  double scaled(double k,
                double bias) const noexcept {
    return area_ * k + bias;
  }

 private:
  std::string name_;
  double area_;
};

class Circle final : public Shape {
 public:
  explicit Circle(double r) : Shape("circle"), radius_(r) {}
  double area() const override { return 3.14159 * radius_ * radius_; }

 private:
  double radius_;
};

enum class Mode { kFast, kSafe };

template <typename T, typename F>
T fold(const std::vector<T>& xs, T seed, F&& fn) {
  T acc = seed;
  for (const auto& x : xs) {
    acc = fn(acc, x);
  }
  return acc;
}

}  // namespace geo

using geo::Box;
using Table = std::map<std::string, int>;

static int g_calls = 0;

int tally(const Table& table, geo::Mode mode) {
  int total = 0;
  for (const auto& [key, count] : table) {
    if (mode == geo::Mode::kSafe && key.empty()) {
      continue;
    }
    total += count;
  }
  auto bump = [&total](int by) { total += by; return total; };
  auto twice = [=](int v) mutable { return v * 2 + total; };
  bump(1);
  g_calls++;
  return twice(total);
}

void casts(void* raw, const int* ci, double d) {
  auto* bytes = reinterpret_cast<unsigned char*>(raw);
  int* mut = const_cast<int*>(ci);
  int whole = static_cast<int>(d);
  long wide = (long)whole;
  auto* shape = dynamic_cast<geo::Circle*>(static_cast<geo::Shape*>(raw));
  *mut = whole + bytes[0] + static_cast<int>(wide);
  CHECK(shape != nullptr);
}

int main(int argc, char** argv) {
  std::vector<int> xs{1, 2, 3};
  Box<int> box{42};
  Table table{{"a", 1}, {"b", 2}};
  auto shape = std::make_unique<geo::Circle>(2.0);
  int sum = geo::fold(xs, 0, [](int a, int b) { return a + b; });
  std::cout << "sum=" << sum << " box=" << box.get() << '\n';
  std::string line = std::format("{} has area {:.2f} ({}/{})", shape->name(), shape->area(), argc, sum);
  std::printf("%s %d\n", line.c_str(), tally(table, geo::Mode::kFast));
  auto raw = R"(raw "text" with %d)";
  for (int i = 0; i < geo::kLimit; ++i) {
    if (i % 2 == 0) continue;
    sum += i;
  }
  std::sort(xs.begin(), xs.end(), [](int l, int r) { return l > r; });
  return sum + static_cast<int>(std::string(raw).size()) + (argv != nullptr);
}
