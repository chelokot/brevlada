#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

static pthread_once_t attached = PTHREAD_ONCE_INIT;
static const volatile int64_t *frozen;
static int (*next_clock_gettime)(clockid_t, struct timespec *);

static void attach(void) {
  next_clock_gettime = dlsym(RTLD_NEXT, "clock_gettime");
  int file = open(getenv("BREVLADA_CLOCK"), O_RDONLY | O_CLOEXEC);
  frozen = mmap(NULL, sizeof *frozen, PROT_READ, MAP_SHARED, file, 0);
  close(file);
}

__attribute__((constructor)) static void hide_from_children(void) {
  pthread_once(&attached, attach);
  setenv("LD_PRELOAD", getenv("BREVLADA_CHILD_PRELOAD"), 1);
  unsetenv("BREVLADA_CHILD_PRELOAD");
  unsetenv("BREVLADA_CLOCK");
}

int clock_gettime(clockid_t clock, struct timespec *time) {
  pthread_once(&attached, attach);
  int64_t now = *frozen;
  if (now == 0 || (clock != CLOCK_MONOTONIC && clock != CLOCK_MONOTONIC_RAW && clock != CLOCK_MONOTONIC_COARSE && clock != CLOCK_BOOTTIME))
    return next_clock_gettime(clock, time);
  time->tv_sec = now / 1000000000;
  time->tv_nsec = now % 1000000000;
  return 0;
}
