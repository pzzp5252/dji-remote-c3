#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>
#include "journal.h"
#include <fcntl.h>
#include <sys/statvfs.h>

static bool simulate_space;
static size_t available_space;
/* Interpose only this host test executable's capacity query. Actual journal
 * writes/replay still use the real isolated filesystem. */
int statvfs(const char *name, struct statvfs *info) {
    if(simulate_space) {
        memset(info,0,sizeof(*info));
        info->f_frsize=1;info->f_blocks=1024*1024;info->f_bavail=available_space;
        return 0;
    }
    int fd=open(name,O_RDONLY);
    if(fd<0)return -1;
    int result=fstatvfs(fd,info),saved=errno;
    close(fd);errno=saved;return result;
}

/* Host compiler needs cJSON headers/library (for example pkg-config libcjson)
 * plus -lm; no ESP, NVS, or camera implementation is linked into this test. */
static char fixture[256];
static void fixture_open(void) {
    strcpy(fixture, "/tmp/dji-journal-XXXXXX");
    assert(mkdtemp(fixture));
    assert(journal_open(fixture));
}
static void path(char *out, const char *name) {
    assert(snprintf(out, 320, "%s/%s", fixture, name) < 320);
}
static void log_name(char *out) {
    char manifest_path[320], data[512];
    path(manifest_path, "current.json");
    FILE *f = fopen(manifest_path, "rb");
    assert(f);
    size_t n = fread(data, 1, sizeof(data) - 1, f);
    assert(!ferror(f) && fclose(f) == 0);
    data[n] = 0;
    cJSON *manifest = cJSON_Parse(data);
    assert(manifest);
    const cJSON *slot = cJSON_GetObjectItemCaseSensitive(manifest, "generation");
    assert(cJSON_IsNumber(slot));
    path(out, slot->valueint ? "generation-1.jsonl" : "generation-0.jsonl");
    cJSON_Delete(manifest);
}
static void fixture_remove(void) {
    const char *names[] = {"current.json", "current.tmp", "generation-0.jsonl",
                           "generation-1.jsonl", "nvs-pairing.bin"};
    char name[320];
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); ++i) {
        path(name, names[i]);
        assert(unlink(name) == 0 || errno == ENOENT);
    }
    assert(rmdir(fixture) == 0);
}
static cJSON *event(const char *type) {
    cJSON *obj = cJSON_CreateObject();
    assert(obj);
    assert(cJSON_AddStringToObject(obj, "type", type));
    assert(cJSON_AddStringToObject(obj, "boot_id", "boot-1"));
    assert(cJSON_AddNumberToObject(obj, "mono_ms", 100));
    assert(cJSON_AddNullToObject(obj, "time_anchor"));
    return obj;
}
static void append_ok(cJSON *obj) {
    assert(journal_append(obj));
    cJSON_Delete(obj);
}
static cJSON *selection(const char *action, const char *point) {
    cJSON *obj = event("SELECT_ACTION");
    assert(cJSON_AddStringToObject(obj, "action_id", action));
    assert(cJSON_AddStringToObject(obj, "point_id", point));
    return obj;
}
static cJSON *begin(uint32_t take, const char *command) {
    cJSON *obj = event("TAKE_BEGIN");
    assert(cJSON_AddNumberToObject(obj, "take_id", take));
    assert(cJSON_AddStringToObject(obj, "command_id", command));
    assert(cJSON_AddStringToObject(obj, "action_id", journal_state()->action_id));
    assert(cJSON_AddStringToObject(obj, "point_id", journal_state()->point_id));
    assert(cJSON_AddStringToObject(obj, "source", "usb"));
    assert(cJSON_AddNumberToObject(obj, "participants", 1));
    return obj;
}
static cJSON *end(void) {
    const cJSON *start = journal_state()->last_begin;
    cJSON *obj = event("TAKE_END");
    assert(start);
    assert(cJSON_AddNumberToObject(obj, "take_id", journal_state()->take_id));
    assert(cJSON_AddStringToObject(obj, "action_id",
        cJSON_GetObjectItemCaseSensitive(start, "action_id")->valuestring));
    assert(cJSON_AddStringToObject(obj, "point_id",
        cJSON_GetObjectItemCaseSensitive(start, "point_id")->valuestring));
    assert(cJSON_AddStringToObject(obj, "begin_boot_id",
        cJSON_GetObjectItemCaseSensitive(start, "boot_id")->valuestring));
    assert(cJSON_AddNumberToObject(obj, "begin_mono_ms",
        cJSON_GetObjectItemCaseSensitive(start, "mono_ms")->valuedouble));
    assert(cJSON_AddStringToObject(obj, "reason", "recovered"));
    assert(cJSON_AddBoolToObject(obj, "complete", false));
    cJSON *cameras = cJSON_AddArrayToObject(obj, "cameras");
    assert(cameras);
    assert(cJSON_AddItemToArray(cameras, cJSON_CreateObject()));
    assert(cJSON_AddItemToArray(cameras, cJSON_CreateObject()));
    return obj;
}
static char *export_bytes(uint32_t after, size_t *size) {
    FILE *out = tmpfile();
    assert(out && journal_export(out, after));
    assert(fflush(out) == 0);
    long length = ftell(out);
    assert(length >= 0 && fseek(out, 0, SEEK_SET) == 0);
    char *bytes = malloc((size_t)length + 1);
    assert(bytes && fread(bytes, 1, (size_t)length, out) == (size_t)length);
    bytes[length] = 0;
    assert(fclose(out) == 0);
    *size = (size_t)length;
    return bytes;
}
static void write_bytes(const char *name, const char *data, size_t size, const char *mode) {
    FILE *f = fopen(name, mode);
    assert(f && fwrite(data, 1, size, f) == size);
    assert(fflush(f) == 0 && fsync(fileno(f)) == 0 && fclose(f) == 0);
}
static void rejected(cJSON *obj) {
    journal_state_t before = *journal_state();
    char name[320];
    log_name(name);
    struct stat disk;
    assert(!journal_append(obj));
    assert(*journal_error());
    assert(journal_state()->bytes == before.bytes && journal_state()->lines == before.lines);
    assert(journal_state()->take_id == before.take_id && journal_state()->event_seq == before.event_seq);
    assert(journal_state()->unfinished == before.unfinished);
    assert(stat(name, &disk) == 0 && (size_t)disk.st_size == before.bytes);
    cJSON_Delete(obj);
}
static void setup_selected(void) {
    fixture_open();
    assert(journal_init_project("project-1", "template-1"));
    append_ok(selection("action_1", "point.1"));
}

static void test_durable_replay_and_export(void) {
    fixture_open();
    assert(!journal_can_begin());
    assert(journal_init_project("project-1", "template-1"));
    assert(journal_open(fixture));
    assert(!strcmp(journal_state()->project_id, "project-1"));
    assert(!strcmp(journal_state()->template_id, "template-1"));
    assert(journal_state()->lines == 0);
    append_ok(selection("action_1", "point.1"));
    assert(journal_can_begin());
    cJSON *obj = begin(1, "command-1");
    assert(journal_append(obj));
    cJSON_DeleteItemFromObjectCaseSensitive(obj, "command_id");
    cJSON_Delete(obj); /* retained BEGIN must not alias caller ownership */
    assert(!strcmp(journal_state()->last_command_id, "command-1"));
    assert(journal_open(fixture));
    assert(journal_state()->unfinished && journal_state()->take_id == 1);
    assert(!strcmp(journal_state()->last_command_id, "command-1"));
    assert(journal_state()->last_begin);
    assert(!strcmp(cJSON_GetObjectItemCaseSensitive(journal_state()->last_begin, "boot_id")->valuestring, "boot-1"));
    append_ok(end());
    append_ok(selection("action_2", ""));
    append_ok(begin(2, "command-2"));
    append_ok(end());
    cJSON *discard = event("MARK_DISCARD");
    assert(cJSON_AddNumberToObject(discard, "take_id", 1));
    assert(cJSON_AddBoolToObject(discard, "discard", true));
    append_ok(discard);
    cJSON *reassign = event("REASSIGN");
    assert(cJSON_AddNumberToObject(reassign, "take_id", 1));
    assert(cJSON_AddStringToObject(reassign, "action_id", "reassigned"));
    assert(cJSON_AddStringToObject(reassign, "point_id", ""));
    append_ok(reassign);
    size_t length;
    char *all = export_bytes(0, &length);
    assert(length == journal_state()->bytes && journal_state()->lines == 8);
    assert(journal_open(fixture));
    assert(journal_state()->take_id == 2 && !journal_state()->unfinished);
    assert(!strcmp(journal_state()->last_command_id, "command-2"));
    assert(!strcmp(journal_state()->action_id, "action_2"));
    size_t again_length, suffix_length;
    char *again = export_bytes(0, &again_length);
    assert(length == again_length && !memcmp(all, again, length));
    char physical_name[320];
    log_name(physical_name);
    FILE *physical = fopen(physical_name, "rb");
    char *physical_bytes = malloc(length);
    assert(physical && physical_bytes);
    assert(fread(physical_bytes, 1, length, physical) == length && fgetc(physical) == EOF);
    assert(!memcmp(all, physical_bytes, length) && fclose(physical) == 0);
    free(physical_bytes);
    const char *suffix = all;
    for (int i = 0; i < 4; ++i) { suffix = strchr(suffix, '\n'); assert(suffix); ++suffix; }
    char *filtered = export_bytes(4, &suffix_length);
    assert(suffix_length == strlen(suffix) && !memcmp(filtered, suffix, suffix_length));
    free(filtered); free(again); free(all);
    fixture_remove();
}

static void test_tail_and_corrupt_interior(void) {
    setup_selected();
    append_ok(begin(1, "last-command"));
    size_t committed = journal_state()->bytes;
    char name[320];
    log_name(name);
    char partial[5000];
    memset(partial, 'x', sizeof(partial));
    write_bytes(name, partial, sizeof(partial), "ab");
    assert(journal_open(fixture));
    struct stat disk;
    assert(stat(name, &disk) == 0 && (size_t)disk.st_size == committed);
    assert(journal_state()->unfinished && !strcmp(journal_state()->last_command_id, "last-command"));
    append_ok(end());
    size_t size;
    char *all = export_bytes(0, &size);
    char *first_end = strchr(all, '\n');
    assert(first_end);
    size_t first = (size_t)(first_end + 1 - all);
    write_bytes(name, all, first, "wb");
    write_bytes(name, "{broken}\n", 9, "ab");
    write_bytes(name, all + first, size - first, "ab");
    assert(!journal_open(fixture));
    assert(strstr(journal_error(), "malformed"));
    assert(!journal_state()->writable && journal_state()->lines == 1);
    assert(stat(name, &disk) == 0 && (size_t)disk.st_size == size + 9);
    free(all);
    fixture_remove();
}

static void test_ordering_and_bounds(void) {
    fixture_open();
    assert(journal_init_project("project-1", "template-1"));
    rejected(begin(1, "without-action"));
    append_ok(selection("selected", ""));
    rejected(begin(2, "skipped-take"));
    cJSON *obj = event("TAKE_END");
    assert(cJSON_AddNumberToObject(obj, "take_id", 1));
    rejected(obj);
    obj = begin(1, "bad-selection");
    assert(cJSON_ReplaceItemInObjectCaseSensitive(obj, "action_id", cJSON_CreateString("other")));
    rejected(obj);
    append_ok(begin(1, "command"));
    assert(!journal_can_begin());
    rejected(begin(2, "overlapping"));
    rejected(selection("other", ""));
    obj = end();
    assert(cJSON_ReplaceItemInObjectCaseSensitive(obj, "begin_boot_id", cJSON_CreateString("wrong-boot")));
    rejected(obj);
    obj = event("REASSIGN");
    assert(cJSON_AddNumberToObject(obj, "take_id", 1));
    assert(cJSON_AddStringToObject(obj, "action_id", "other"));
    assert(cJSON_AddStringToObject(obj, "point_id", ""));
    rejected(obj);
    append_ok(end());
    rejected(end());
    obj = event("NOT_AN_EVENT");
    assert(cJSON_AddNumberToObject(obj, "take_id", 1));
    rejected(obj);
    assert(!journal_init_project("another-project", "template-1"));
    assert(!journal_init_project("project-1", "another-template"));
    fixture_remove();

    fixture_open();
    assert(journal_init_project("first", "template-1"));
    append_ok(selection("selected", ""));
    /* No takes: switching identity starts an empty generation, not mixed history. */
    assert(journal_init_project("second", "template-1"));
    assert(!journal_state()->lines && !journal_state()->action_id[0]);
    obj = selection("bounded", "");
    char huge[JOURNAL_LINE_MAX + 1];
    memset(huge, 'x', sizeof(huge) - 1); huge[sizeof(huge) - 1] = 0;
    assert(cJSON_AddStringToObject(obj, "padding", huge));
    rejected(obj);
    obj = selection("bounded", "");
    assert(cJSON_AddStringToObject(obj, "padding", huge));
    assert(!journal_append(obj)); /* attaches metadata before rejecting oversized record */
    char *encoded = cJSON_PrintUnformatted(obj);
    assert(encoded);
    size_t overhead = strlen(encoded) - strlen(huge);
    cJSON_free(encoded);
    assert(overhead < JOURNAL_LINE_MAX - 1);
    huge[JOURNAL_LINE_MAX - 1 - overhead] = 0;
    assert(cJSON_ReplaceItemInObjectCaseSensitive(obj, "padding", cJSON_CreateString(huge)));
    append_ok(obj);
    assert(journal_state()->bytes == JOURNAL_LINE_MAX);
    assert(journal_open(fixture) && journal_state()->bytes == JOURNAL_LINE_MAX);
    fixture_remove();
}

static void test_replay_validation(void) {
    enum { IDENTITY, TEMPLATE, SEQUENCE, TAKE_ORDER, END_PAIR, UNKNOWN, SELECTION, COMMAND };
    for (int kind = IDENTITY; kind <= COMMAND; ++kind) {
        setup_selected();
        append_ok(begin(1, "command-1"));
        append_ok(end());
        size_t size;
        char *all = export_bytes(0, &size);
        char name[320];
        log_name(name);
        FILE *output = fopen(name, "wb");
        assert(output);
        char *line = all;
        for (int index = 0; index < 3; ++index) {
            char *lf = strchr(line, '\n');
            assert(lf); *lf = 0;
            cJSON *obj = cJSON_Parse(line);
            assert(obj);
            if (index == 1) {
                const char *key = NULL;
                cJSON *value = NULL;
                switch (kind) {
                    case IDENTITY: key = "project_id"; value = cJSON_CreateString("wrong"); break;
                    case TEMPLATE: key = "template_id"; value = cJSON_CreateString("wrong"); break;
                    case SEQUENCE: key = "event_seq"; value = cJSON_CreateNumber(1); break;
                    case TAKE_ORDER: key = "take_id"; value = cJSON_CreateNumber(2); break;
                    case UNKNOWN: key = "type"; value = cJSON_CreateString("UNKNOWN"); break;
                    case SELECTION: key = "action_id"; value = cJSON_CreateString("wrong"); break;
                    case COMMAND: key = "command_id"; value = cJSON_CreateString("bad/command"); break;
                    default: break;
                }
                if (key) assert(cJSON_ReplaceItemInObjectCaseSensitive(obj, key, value));
            }
            if (index == 2 && kind == END_PAIR)
                assert(cJSON_ReplaceItemInObjectCaseSensitive(obj, "begin_mono_ms", cJSON_CreateNumber(101)));
            char *encoded = cJSON_PrintUnformatted(obj);
            assert(encoded && fprintf(output, "%s\n", encoded) > 0);
            cJSON_free(encoded); cJSON_Delete(obj);
            line = lf + 1;
        }
        assert(fflush(output) == 0 && fsync(fileno(output)) == 0 && fclose(output) == 0);
        assert(!journal_open(fixture) && !journal_state()->writable);
        assert(*journal_error());
        free(all);
        fixture_remove();
    }
}

static void test_append_failure_rolls_back(void) {
    setup_selected();
    struct rlimit previous, limited;
    assert(getrlimit(RLIMIT_FSIZE, &previous) == 0);
    limited = previous;
    limited.rlim_cur = (rlim_t)journal_state()->bytes + 20;
    assert(signal(SIGXFSZ, SIG_IGN) != SIG_ERR);
    assert(setrlimit(RLIMIT_FSIZE, &limited) == 0);
    rejected(begin(1, "partial-write"));
    assert(setrlimit(RLIMIT_FSIZE, &previous) == 0);
    assert(journal_state()->writable);
    assert(journal_open(fixture));
    assert(journal_state()->take_id == 0 && journal_state()->lines == 1);
    append_ok(begin(1, "retry-command"));
    assert(journal_open(fixture) && journal_state()->unfinished);
    assert(!strcmp(journal_state()->last_command_id, "retry-command"));
    fixture_remove();
}

static void test_reset_tuple_and_pairing_independence(void) {
    setup_selected();
    append_ok(begin(1, "command-1"));
    append_ok(end());
    journal_state_t saved = *journal_state();
    char pairing[320];
    path(pairing, "nvs-pairing.bin");
    static const char paired[] = "pairing must remain byte-identical";
    write_bytes(pairing, paired, sizeof(paired), "wb");
    assert(!journal_reset("wrong", saved.event_seq, saved.take_id, saved.lines, saved.bytes));
    assert(!journal_reset(saved.project_id, saved.event_seq + 1, saved.take_id, saved.lines, saved.bytes));
    assert(!journal_reset(saved.project_id, saved.event_seq, saved.take_id + 1, saved.lines, saved.bytes));
    assert(!journal_reset(saved.project_id, saved.event_seq, saved.take_id, saved.lines + 1, saved.bytes));
    assert(!journal_reset(saved.project_id, saved.event_seq, saved.take_id, saved.lines, saved.bytes + 1));
    assert(journal_state()->bytes == saved.bytes);
    /* Simulate power loss with prepared inactive log/manifest but no rename. */
    char selected[320], inactive[320], temporary[320];
    log_name(selected);
    path(inactive, strstr(selected, "generation-0") ? "generation-1.jsonl" : "generation-0.jsonl");
    path(temporary, "current.tmp");
    write_bytes(inactive, "", 0, "wb");
    write_bytes(temporary, "incomplete manifest", 19, "wb");
    assert(journal_open(fixture));
    assert(journal_state()->bytes == saved.bytes && journal_state()->take_id == saved.take_id);
    assert(journal_reset(saved.project_id, saved.event_seq, saved.take_id, saved.lines, saved.bytes));
    assert(!journal_state()->project_id[0] && !journal_state()->template_id[0]);
    assert(!journal_state()->lines && !journal_state()->bytes && !journal_state()->take_id);
    assert(!journal_state()->last_begin && !journal_state()->last_command_id[0]);
    /* Obsolete-generation leftovers after the switch must never be replayed. */
    write_bytes(selected, "corrupted old log\n", 18, "wb");
    assert(journal_open(fixture) && !journal_state()->lines);
    FILE *f = fopen(pairing, "rb");
    char actual[sizeof(paired)];
    assert(f && fread(actual, 1, sizeof(actual), f) == sizeof(actual));
    assert(!memcmp(actual, paired, sizeof(paired)) && fclose(f) == 0);
    assert(journal_init_project("project-2", "template-1"));
    append_ok(selection("new-action", ""));
    append_ok(begin(1, "new-command"));
    assert(journal_open(fixture));
    assert(!strcmp(journal_state()->project_id, "project-2"));
    assert(!strcmp(journal_state()->template_id, "template-1") && journal_state()->take_id == 1);
    fixture_remove();
}

static void test_external_begin_is_unassigned(void) {
    setup_selected();
    cJSON *obj = begin(1, "external-command");
    assert(cJSON_ReplaceItemInObjectCaseSensitive(obj, "source", cJSON_CreateString("external")));
    rejected(obj); /* Selected attribution must not leak into an external take. */
    obj = begin(1, "external-command");
    assert(cJSON_ReplaceItemInObjectCaseSensitive(obj, "source", cJSON_CreateString("external")));
    assert(cJSON_ReplaceItemInObjectCaseSensitive(obj, "action_id", cJSON_CreateString("")));
    assert(cJSON_ReplaceItemInObjectCaseSensitive(obj, "point_id", cJSON_CreateString("")));
    append_ok(obj);
    assert(journal_state()->unfinished);
    assert(!strcmp(journal_state()->action_id, "action_1"));
    assert(!strcmp(journal_state()->point_id, "point.1"));
    assert(journal_open(fixture) && journal_state()->unfinished);
    assert(!*cJSON_GetObjectItemCaseSensitive(journal_state()->last_begin, "action_id")->valuestring);
    assert(!*cJSON_GetObjectItemCaseSensitive(journal_state()->last_begin, "point_id")->valuestring);
    append_ok(end());
    assert(journal_open(fixture) && !journal_state()->unfinished);
    assert(!strcmp(journal_state()->action_id, "action_1"));
    append_ok(begin(2, "selected-command"));
    append_ok(end());
    fixture_remove();
}

static void test_low_space_admission_and_end(void) {
    setup_selected();
    simulate_space=true;available_space=JOURNAL_RESERVE_BYTES;
    cJSON *obj=begin(1,"space-boundary");
    assert(!journal_append(obj));
    assert(journal_state()->take_id==0 && !journal_state()->unfinished);
    char *serialized=cJSON_PrintUnformatted(obj);assert(serialized);
    size_t needed=JOURNAL_RESERVE_BYTES+strlen(serialized)+1;
    cJSON_free(serialized);
    available_space=needed-1;
    assert(!journal_append(obj));
    available_space=needed;
    assert(journal_append(obj));cJSON_Delete(obj);
    available_space=0;
    append_ok(end()); /* END and export are never gated by BEGIN reserve. */
    size_t bytes;char *exported=export_bytes(0,&bytes);
    assert(bytes==journal_state()->bytes);free(exported);
    rejected(begin(2,"space-full"));
    simulate_space=false;
    assert(journal_open(fixture) && journal_state()->take_id==1);
    fixture_remove();
}

int main(void) {
    assert(journal_id_valid("A-z_0.9", JOURNAL_ID_MAX, false));
    assert(!journal_id_valid("a/b", JOURNAL_ID_MAX, false));
    assert(!journal_id_valid("", JOURNAL_ID_MAX, false));
    assert(journal_id_valid("", JOURNAL_ACTION_MAX, true));
    assert(!journal_id_valid("nonascii-\xc3\xa9", JOURNAL_ID_MAX, false));
    test_durable_replay_and_export();
    test_tail_and_corrupt_interior();
    test_ordering_and_bounds();
    test_replay_validation();
    test_append_failure_rolls_back();
    test_reset_tuple_and_pairing_independence();
    test_external_begin_is_unassigned();
    test_low_space_admission_and_end();
    puts("journal: all tests passed");
    return 0;
}
