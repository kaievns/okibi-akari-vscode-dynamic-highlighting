/* Sample C file for exercising the Okibi dynamic focus layer.
 * Move the caret into different { } blocks and watch the ember bar + fill.
 * Type to flip Survey 構 -> Focus 流 -> Edit 異 (status bar, bottom-right).
 *
 * What to look for:
 *   Focus 流 — data identities tint (locals, params). Struct field names, type
 *     names, function names, and macros stay band-1.
 *   Edit 異 — numeric literals go clay; writes to out-of-block bindings get a
 *     dashed underline; relaxes to Focus after ~2s.
 *   Stability — a variable keeps one hue across every sub-block of its function.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_RETRIES 3
#define DEFAULT_TIMEOUT 30
#define ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))

/* struct field names are band-1, not data */
typedef struct {
    char name[64];
    int retries;
    int timeout;
} Config;

typedef enum {
    STATUS_PENDING,
    STATUS_ACTIVE,
    STATUS_CLOSED,
} Status;

/* a file-scope global — bold identity when referenced */
static int total_calls = 0;

/* function pointer typedef — a transformer identity */
typedef int (*Handler)(const Config *cfg, char *out, size_t cap);

static Config load_config(const char *name) {
    Config cfg;
    strncpy(cfg.name, name, sizeof(cfg.name) - 1);
    cfg.name[sizeof(cfg.name) - 1] = '\0';
    cfg.retries = MAX_RETRIES;
    cfg.timeout = DEFAULT_TIMEOUT;

    if (cfg.retries > 0) {
        for (int i = 0; i < cfg.retries; i++) {
            /* deepest block — cfg + i are the data identities here */
            int backoff = 1 << i;
            printf("attempt %d for %s (backoff=%dms)\n", i, cfg.name, backoff);
        }
    }

    total_calls++; /* escapes the block — writes the file-scope global */
    return cfg;
}

static int summarize(const Config *cfgs, size_t count, char *out, size_t cap) {
    size_t written = 0;
    for (size_t idx = 0; idx < count; idx++) {
        const Config *c = &cfgs[idx];
        if (c->name[0] == '\0') {
            continue;
        }
        int n = snprintf(out + written, cap - written, "%zu:%s x%d; ",
                         idx, c->name, c->retries);
        if (n < 0 || (size_t)n >= cap - written) {
            break;
        }
        written += (size_t)n;
    }
    return (int)written;
}

static int echo_handler(const Config *cfg, char *out, size_t cap) {
    return snprintf(out, cap, "%s", cfg->name);
}

int main(void) {
    Config cfgs[] = {
        load_config("alpha"),
        load_config("beta"),
        load_config("gamma"),
    };

    char buf[256];
    int len = summarize(cfgs, ARRAY_LEN(cfgs), buf, sizeof(buf));
    printf("summary (%d bytes): %s\n", len, buf);

    Handler h = echo_handler;
    char out[64];
    for (size_t i = 0; i < ARRAY_LEN(cfgs); i++) {
        int wrote = h(&cfgs[i], out, sizeof(out));
        printf("handler wrote %d bytes: %s\n", wrote, out);
    }

    printf("total calls: %d\n", total_calls);
    return 0;
}
