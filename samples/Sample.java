// Sample Java file for exercising the Okibi dynamic focus layer.
// Move the caret into different { } blocks and watch the ember bar + fill.
// Type to flip Survey 構 -> Focus 流 -> Edit 異 (status bar, bottom-right).
//
// What to look for:
//   Focus 流 — data identities tint (locals, params, `this`, captured lambda
//     vars). Class/type names, field names, method names stay band-1.
//   Edit 異 — numbers go clay; writes escaping the block get a dashed underline.
//   Stability — a variable keeps one hue across sub-blocks and lambdas.

package samples;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import java.util.function.BiFunction;
import java.util.stream.Collectors;

public class Sample {

    static final int MAX_RETRIES = 3;
    static final int DEFAULT_TIMEOUT = 30;

    // a class-level static — bold identity when referenced
    static int totalCalls = 0;

    enum Status { PENDING, ACTIVE, CLOSED }

    // record: component names are band-1, not data
    record Config(String name, int retries, Map<String, String> tags) {
        Config withRetries(int retries) {
            return new Config(this.name, retries, this.tags);
        }
    }

    // functional interface — a transformer identity
    interface Handler {
        byte[] handle(Config cfg, byte[] input);
    }

    static Config loadConfig(String name) {
        Map<String, String> tags = new HashMap<>();
        tags.put("env", "dev");
        Config cfg = new Config(name, MAX_RETRIES, tags);

        if (cfg.retries() > 0) {
            for (int i = 0; i < cfg.retries(); i++) {
                // deepest block — cfg + i + backoff are data identities
                int backoff = 1 << i;
                System.out.printf("attempt %d for %s (backoff=%dms)%n",
                        i, cfg.name(), backoff);
            }
        }

        totalCalls++; // escapes the block — writes the class static
        return cfg;
    }

    // closures: captured `prefix` + stream params keep stable hues
    static String summarize(List<Config> cfgs) {
        String prefix = "cfg";
        return cfgs.stream()
                .filter(c -> !c.name().isEmpty())
                .map(c -> prefix + ":" + c.name() + " x" + c.retries())
                .collect(Collectors.joining("; "));
    }

    // generics: T is a type param (band-1); acc/item are data
    static <T> T fold(List<Config> cfgs, T seed, BiFunction<T, Config, T> reducer) {
        T acc = seed;
        for (Config item : cfgs) {
            acc = reducer.apply(acc, item);
        }
        return acc;
    }

    // inner class: `this` is the keyword colour; methods are band-1
    static class Worker {
        private final String id;
        private int seen;
        private final List<String> history = new ArrayList<>();

        Worker(String id) {
            this.id = id;
            this.seen = 0;
        }

        void process(Config cfg) {
            this.seen += 1; // write to this-bound field → escapes the block
            int bytes = cfg.name().length();
            if (bytes > 3) {
                this.seen += bytes;
            }
            history.add(cfg.name());
        }

        int score() {
            return this.seen;
        }
    }

    public static void main(String[] args) {
        List<Config> cfgs = new ArrayList<>();
        for (String name : new String[] {"alpha", "beta", "gamma"}) {
            cfgs.add(loadConfig(name));
        }

        Worker worker = new Worker("w-1");
        cfgs.forEach(worker::process);

        int total = fold(cfgs, 0, (acc, item) -> acc + item.retries());

        System.out.println(summarize(cfgs));
        System.out.printf("score=%d total_retries=%d calls=%d%n",
                worker.score(), total, totalCalls);
    }
}
