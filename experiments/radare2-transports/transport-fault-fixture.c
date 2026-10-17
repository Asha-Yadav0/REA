/* Synthetic protocol faults only; never opens or executes the selected target. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  const char *mode = getenv("REA_FAULT_MODE");
  const char *transport = getenv("REA_FAULT_TRANSPORT");
  int pipe = !strcmp(transport, "r2pipe");
  int mcp = !strcmp(transport, "r2mcp");
  setbuf(stdout, NULL);
  if (pipe) putchar(0);
  FILE *ready = fopen(getenv("REA_FAULT_READY"), "w");
  if (!ready) return 1;
  fprintf(ready, "%d", getpid());
  fclose(ready);
  if (!strncmp(mode, "final-hash-", 11)) {
    const char *target = getenv("REA_FAULT_TARGET");
    if (!strcmp(mode, "final-hash-timeout")) {
      if (truncate(target, (off_t)4 * 1024 * 1024 * 1024)) return 2;
    } else if (unlink(target)) return 3;
    fputs("{\"error\":false,\"code\":0,\"res\":\"completed-native-reply\"}", stdout);
    fputs("completed-native-stderr\n", stderr);
    return 0;
  }
  if (!strcmp(mode, "blocked")) {
    for (;;) pause();
  }
  if (pipe || mcp) {
    int c;
    while ((c = getchar()) != '\n' && c != EOF) {}
  }
  if (!strcmp(mode, "partial")) {
    fputs("{\"res\":\"partial-", stdout);
    putchar(0xff);
    for (;;) pause();
  }
  if (mcp) fputs("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"", stdout);
  else fputs("{\"error\":false,\"code\":0,\"res\":\"", stdout);
  putchar(0xff);
  fputs("\"}", stdout);
  if (pipe) putchar(0);
  if (mcp) putchar('\n');
  if (pipe || mcp) {
    while (getchar() != EOF) {}
  }
  return 0;
}
