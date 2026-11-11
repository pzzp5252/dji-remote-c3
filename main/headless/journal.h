#ifndef HEADLESS_JOURNAL_H
#define HEADLESS_JOURNAL_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include "cJSON.h"
#define JOURNAL_ID_MAX 64
#define JOURNAL_ACTION_MAX 32
#define JOURNAL_RESERVE_BYTES 8192u
#define JOURNAL_LINE_MAX 4096u
/* Single control-task owner. BLE callbacks must never call these APIs. */
typedef struct {
    char project_id[JOURNAL_ID_MAX], template_id[JOURNAL_ID_MAX];
    char action_id[JOURNAL_ACTION_MAX], point_id[JOURNAL_ACTION_MAX];
    char last_command_id[JOURNAL_ID_MAX];
    uint32_t take_id, event_seq, lines;
    uint8_t target_cameras; /* Persistent operator intent; not take participation. */
    size_t bytes;
    bool unfinished, writable;
    /* Latest TAKE_BEGIN, retained during replay; caller never frees it. */
    cJSON *last_begin;
} journal_state_t;
/* Mount LittleFS without format-on-failure. Fresh erased partition is formatted
 * explicitly only if it has no filesystem signature. Host builds use root. */
bool journal_open(const char *root);
const journal_state_t *journal_state(void);
/* IDs: ASCII letters, digits, underscore, dash and dot; no path separators. */
bool journal_id_valid(const char *id, size_t capacity, bool allow_empty);
bool journal_init_project(const char *project_id, const char *template_id);
/* Adds schema_version/project_id/template_id/event_seq to event. On success
 * flushes + fsyncs before updating RAM state. Caller retains event ownership. */
bool journal_append(cJSON *event);
bool journal_can_begin(void);
bool journal_space(size_t *total, size_t *used);
/* Exact JSONL bytes only, no envelope. after_seq=0 exports all events. */
bool journal_export(FILE *out, uint32_t after_seq);
typedef struct {
    FILE *file;
    journal_state_t snapshot; /* last_begin is NULL: no borrowed JSON ownership */
    size_t remaining;
    uint32_t after_seq, previous_seq, generation;
} journal_reader_t;
typedef enum {
    JOURNAL_READ_ERROR=-1, JOURNAL_READ_END=0,
    JOURNAL_READ_EVENT=1, JOURNAL_READ_SKIP=2
} journal_read_result_t;
/* Bounded snapshot reader for nonblocking BLE export. Zero-init before open.
 * Each next call reads at most one committed JSONL line, including skipped ones.
 * Returned line includes LF and a trailing NUL; length counts LF, not NUL.
 * Later appends are not part of the snapshot; project reset invalidates it. */
bool journal_reader_open(journal_reader_t *reader, uint32_t after_seq);
journal_read_result_t journal_reader_next(journal_reader_t *reader,
                                         char line[JOURNAL_LINE_MAX+1], size_t *length);
void journal_reader_close(journal_reader_t *reader);
/* Caller must ensure camera/take safety and require explicit user confirmation.
 * Expected tuple must match current committed state. Atomic manifest switch
 * precedes old-file cleanup; pairings/NVS are outside this module. */
bool journal_reset(const char *project_id, uint32_t event_seq, uint32_t take_id,
                   uint32_t lines, size_t bytes);
const char *journal_error(void);
#endif
