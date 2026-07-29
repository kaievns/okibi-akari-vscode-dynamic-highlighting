// Sample C++ file for exercising the Okibi dynamic focus layer.
// Move the caret into different { } blocks and watch the ember bar + fill.
// Type to flip Survey 構 -> Focus 流 -> Edit 異 (status bar, bottom-right).
//
// What to look for:
//   Focus 流 — data identities tint (locals, params, `this`, captured lambda
//     vars). Class/type names, member-field names, methods, and namespaces
//     stay band-1.
//   Edit 異 — numbers go clay; writes escaping the block get a dashed underline.
//   Stability — a variable keeps one hue across sub-blocks and nested lambdas.

#include <algorithm>
#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace okibi {

constexpr int kMaxRetries = 3;
constexpr int kDefaultTimeout = 30;

// field names are band-1; the type name Config is band-1
struct Config {
    std::string name;
    int retries = kMaxRetries;
    int timeout = kDefaultTimeout;
    std::map<std::string, std::string> tags;
};

enum class Status { Pending, Active, Closed };

// a translation-unit global — bold identity when referenced
static int total_calls = 0;

Config load_config(const std::string& name) {
    Config cfg;
    cfg.name = name;
    cfg.tags["env"] = "dev";

    if (cfg.retries > 0) {
        for (int i = 0; i < cfg.retries; ++i) {
            // deepest block — cfg + i + backoff are data identities
            int backoff = 1 << i;
            std::cout << "attempt " << i << " for " << cfg.name
                      << " (backoff=" << backoff << "ms)\n";
        }
    }

    ++total_calls; // escapes the block — writes the TU-global
    return cfg;
}

// template method: T is a type param (band-1); acc/item are data
template <typename T, typename Reducer>
T fold(const std::vector<Config>& cfgs, T seed, Reducer reducer) {
    T acc = seed;
    for (const auto& item : cfgs) {
        acc = reducer(acc, item);
    }
    return acc;
}

// class: `this` is the gold self-slot; methods are band-1
class Worker {
public:
    explicit Worker(std::string id) : id_(std::move(id)), seen_(0) {}

    void process(const Config& cfg) {
        this->seen_ += 1; // write to this-bound member → escapes the block
        auto bytes = static_cast<int>(cfg.name.size());
        if (bytes > 3) {
            this->seen_ += bytes;
        }
        history_.push_back(cfg.name);
    }

    int score() const { return seen_; }

private:
    std::string id_;
    int seen_;
    std::vector<std::string> history_;
};

// closures: captured `prefix` + params keep stable hues
std::string summarize(const std::vector<Config>& cfgs) {
    std::string out;
    std::string prefix = "cfg";
    std::for_each(cfgs.begin(), cfgs.end(), [&](const Config& c) {
        if (!c.name.empty()) {
            out += prefix + ":" + c.name + " x" + std::to_string(c.retries) + "; ";
        }
    });
    return out;
}

}  // namespace okibi

int main() {
    using okibi::Config;
    std::vector<Config> cfgs{
        okibi::load_config("alpha"),
        okibi::load_config("beta"),
        okibi::load_config("gamma"),
    };

    auto worker = std::make_unique<okibi::Worker>("w-1");
    for (const auto& cfg : cfgs) {
        worker->process(cfg);
    }

    int total = okibi::fold(cfgs, 0, [](int acc, const Config& c) {
        return acc + c.retries;
    });

    std::cout << okibi::summarize(cfgs) << "\n";
    std::cout << "score=" << worker->score() << " total_retries=" << total << "\n";
    return 0;
}
