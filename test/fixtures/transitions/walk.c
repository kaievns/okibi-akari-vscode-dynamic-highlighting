#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include "local.h"

#define MAX_ITEMS 16
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define ARRAY_LEN(x) (sizeof(x) / sizeof((x)[0]))
#define LOG(fmt, ...) fprintf(stderr, "[log] " fmt "\n", __VA_ARGS__)
#define SWAP(t, x, y) do { \
    t tmp_ = (x);          \
    (x) = (y);             \
    (y) = tmp_;            \
  } while (0)

#ifdef DEBUG
static int debug_level = 2;
#else
static int debug_level = 0;
#endif

#if 0
int dead_code(int n) { return n * 2; }
#endif

typedef struct point {
  int x;
  int y;
} point_t;

enum color { RED, GREEN = 4, BLUE };

typedef int (*cmp_fn)(const void *, const void *);

static int counter = 0;
const char *names[] = {"alpha", "beta", NULL};
static bool verbose = false;
#define ON_OFF(x) ((x) ? true : false)
static unsigned long total_bytes __attribute__((unused)) = 0;

static int compare_points(const void *a, const void *b) {
  const point_t *pa = (const point_t *)a;
  const point_t *pb = (const point_t *)b;
  return pa->x - pb->x;
}

int sum_points(point_t *pts, size_t count, cmp_fn cmp) {
  int total = 0;
  qsort(pts, count, sizeof(point_t), cmp);
  for (size_t i = 0; i < count; i++) {
    point_t *p = &pts[i];
    total += p->x + p->y;
    if (total > MAX_ITEMS) {
      counter++;
      break;
    }
  }
  return MAX(total, 0);
}

void fill(point_t *out, int n) {
  int i, j = 0;
  char buf[32];
  for (i = 0; i < n; i++) {
    out[i] = (point_t){ .x = i, .y = j };
    j += 2;
    snprintf(buf, sizeof buf, "%d:%-4s %5.2f%%", i, names[i % 2], (double)j);
  }
  SWAP(int, i, j);
  LOG("filled %d points into %p", n, (void *)out);
}

int parse(const char *s) {
  int value = 0;
  long big = 10L;
  unsigned u = 0x1Fu;
  char c = '\n';
  while (*s) {
    switch (*s) {
    case '0':
    case '1':
      value = value * 2 + (*s - '0');
      break;
    default:
      goto fail;
    }
    s++;
  }
  return value + (int)big + (int)u + c;
fail:
  return -1;
}

int main(int argc, char **argv) {
  point_t pts[MAX_ITEMS];
  enum color shade = GREEN;
  fill(pts, MAX_ITEMS);
  int result = sum_points(pts, ARRAY_LEN(pts), compare_points);
  printf("%s: %d (%d) shade=%d debug=%d\n", argv[0], result, argc, shade, debug_level);
  return result > 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
