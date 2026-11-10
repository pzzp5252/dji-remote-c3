#define _POSIX_C_SOURCE 200809L
#include "journal.h"
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef ESP_PLATFORM
#include "esp_littlefs.h"
#include "esp_partition.h"
#else
#include <sys/statvfs.h>
#endif

#define PATH_CAP 256
#define MANIFEST_MAX 512
static journal_state_t state;
static char root_path[PATH_CAP], log_path[PATH_CAP], error_text[160];
static unsigned generation;
static bool opened;

static bool fail(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(error_text, sizeof(error_text), fmt, ap);
    va_end(ap);
    return false;
}
static bool io_error(const char *operation) {
    return fail("%s: %s", operation, strerror(errno));
}
const char *journal_error(void) { return error_text; }
const journal_state_t *journal_state(void) { return &state; }

bool journal_id_valid(const char *id, size_t capacity, bool allow_empty) {
    if (!id || !capacity || (!*id && !allow_empty)) return false;
    size_t n = 0;
    for (; id[n]; ++n) {
        unsigned char c = (unsigned char)id[n];
        if (n >= capacity - 1 || !((c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
            c == '_' || c == '-' || c == '.')) return false;
    }
    return true;
}
static bool path_for(char *out, const char *name) {
    int n = snprintf(out, PATH_CAP, "%s/%s", root_path, name);
    return n >= 0 && n < PATH_CAP ? true : fail("journal path too long");
}
static bool generation_path(char *out, unsigned slot) {
    return path_for(out, slot ? "generation-1.jsonl" : "generation-0.jsonl");
}
static bool sync_directory(void) {
#ifdef ESP_PLATFORM
    /* LittleFS rename commits its metadata synchronously; VFS has no dir fsync. */
    return true;
#else
    int fd = open(root_path, O_RDONLY | O_DIRECTORY);
    if (fd < 0) return io_error("open journal directory");
    bool ok = fsync(fd) == 0;
    int saved = errno;
    if (close(fd) != 0 && ok) return io_error("close journal directory");
    errno = saved;
    return ok ? true : io_error("sync journal directory");
#endif
}
static const char *string_field(const cJSON *obj, const char *key) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}
static bool number_field(const cJSON *obj, const char *key, double maximum, double *out) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (!cJSON_IsNumber(v) || !isfinite(v->valuedouble) ||
        v->valuedouble < 0 || v->valuedouble > maximum ||
        floor(v->valuedouble) != v->valuedouble) return false;
    *out = v->valuedouble;
    return true;
}
static bool id_field(const cJSON *obj, const char *key, size_t capacity, bool empty) {
    return journal_id_valid(string_field(obj, key), capacity, empty);
}
static cJSON *parse_exact(char *text, size_t length) {
    const char *end = NULL;
    text[length] = '\0';
    cJSON *obj = cJSON_ParseWithLengthOpts(text, length + 1, &end, true);
    if (obj && (!cJSON_IsObject(obj) || end != text + length)) {
        cJSON_Delete(obj);
        obj = NULL;
    }
    return obj;
}
static bool time_fields(const cJSON *event) {
    double value;
    if (!id_field(event, "boot_id", JOURNAL_ID_MAX, false) ||
        !number_field(event, "mono_ms", 9007199254740991.0, &value)) return false;
    const cJSON *anchor = cJSON_GetObjectItemCaseSensitive(event, "time_anchor");
    return cJSON_IsNull(anchor) || (cJSON_IsObject(anchor) &&
        id_field(anchor, "boot_id", JOURNAL_ID_MAX, false) &&
        number_field(anchor, "mono_ms", 9007199254740991.0, &value) &&
        number_field(anchor, "utc_ms", 9007199254740991.0, &value));
}

/* Validate into a value copy. No state, allocation, or I/O changes here. */
static bool transition(const cJSON *event, journal_state_t *next) {
    double value;
    const char *type = string_field(event, "type");
    const char *project = string_field(event, "project_id");
    const char *template = string_field(event, "template_id");
    if (!cJSON_IsObject(event) || !type || !project || !template ||
        !state.project_id[0] || strcmp(project, state.project_id) ||
        strcmp(template, state.template_id) ||
        !number_field(event, "schema_version", 1, &value) || value != 1 ||
        !number_field(event, "event_seq", UINT32_MAX, &value) || value <= state.event_seq ||
        !time_fields(event)) return fail("invalid event identity, sequence, or time fields");
    *next = state;
    next->event_seq = (uint32_t)value;
    if (state.lines == UINT32_MAX) return fail("journal line counter exhausted");
    next->lines++;
    if (!strcmp(type, "SELECT_ACTION")) {
        if (state.unfinished || !id_field(event, "action_id", JOURNAL_ACTION_MAX, false) ||
            !id_field(event, "point_id", JOURNAL_ACTION_MAX, true))
            return fail("invalid SELECT_ACTION or take still open");
        strcpy(next->action_id, string_field(event, "action_id"));
        strcpy(next->point_id, string_field(event, "point_id"));
        return true;
    }
    if (!number_field(event, "take_id", UINT32_MAX, &value) || value < 1)
        return fail("invalid take_id");
    uint32_t take = (uint32_t)value;
    if (!strcmp(type, "TAKE_BEGIN")) {
        const char *source = string_field(event, "source");
        if (state.unfinished || state.take_id == UINT32_MAX || take != state.take_id + 1 ||
            !id_field(event, "command_id", JOURNAL_ID_MAX, false) ||
            !id_field(event, "action_id", JOURNAL_ACTION_MAX, true) ||
            !id_field(event, "point_id", JOURNAL_ACTION_MAX, true) || !source ||
            (strcmp(source, "boot") && strcmp(source, "usb") && strcmp(source, "ble") && strcmp(source, "external")) ||
            (!strcmp(source, "external")
                ? (*string_field(event, "action_id") || *string_field(event, "point_id"))
                : (!state.action_id[0] ||
                    strcmp(string_field(event, "action_id"), state.action_id) ||
                    strcmp(string_field(event, "point_id"), state.point_id))) ||
            !number_field(event, "participants", 3, &value) || value < 1)
            return fail("invalid TAKE_BEGIN ordering, selection, or participants");
        next->take_id = take;
        next->unfinished = true;
        strcpy(next->last_command_id, string_field(event, "command_id"));
        return true;
    }
    if (!strcmp(type, "TAKE_END")) {
        const cJSON *begin = state.last_begin;
        const char *action = string_field(event, "action_id");
        const char *point = string_field(event, "point_id");
        const char *boot = string_field(event, "begin_boot_id");
        const char *reason = string_field(event, "reason");
        const cJSON *cameras = cJSON_GetObjectItemCaseSensitive(event, "cameras");
        double begin_ms;
        if (!state.unfinished || take != state.take_id || !begin || !action || !point || !boot ||
            strcmp(action, string_field(begin, "action_id")) ||
            strcmp(point, string_field(begin, "point_id")) ||
            strcmp(boot, string_field(begin, "boot_id")) ||
            !number_field(event, "begin_mono_ms", 9007199254740991.0, &begin_ms) ||
            !number_field(begin, "mono_ms", 9007199254740991.0, &value) || begin_ms != value ||
            !reason || !*reason || !cJSON_IsBool(cJSON_GetObjectItemCaseSensitive(event, "complete")) ||
            !cJSON_IsArray(cameras) || cJSON_GetArraySize(cameras) != 2 ||
            !cJSON_IsObject(cJSON_GetArrayItem(cameras, 0)) ||
            !cJSON_IsObject(cJSON_GetArrayItem(cameras, 1)))
            return fail("TAKE_END does not pair with open BEGIN");
        next->unfinished = false;
        return true;
    }
    if (take > state.take_id) return fail("event references unknown take");
    if (!strcmp(type, "MARK_DISCARD")) {
        if (!cJSON_IsBool(cJSON_GetObjectItemCaseSensitive(event, "discard")))
            return fail("MARK_DISCARD requires boolean discard");
        return true;
    }
    if (!strcmp(type, "REASSIGN")) {
        if ((state.unfinished && take == state.take_id) ||
            !id_field(event, "action_id", JOURNAL_ACTION_MAX, false) ||
            !id_field(event, "point_id", JOURNAL_ACTION_MAX, true))
            return fail("invalid REASSIGN or take still open");
        return true;
    }
    return fail("unknown event type");
}

static bool durable_file(const char *path, const char *data, size_t length) {
    FILE *file = fopen(path, "wb");
    if (!file) return io_error("create journal file");
    bool ok = (!length || fwrite(data, 1, length, file) == length) &&
              fflush(file) == 0 && fsync(fileno(file)) == 0;
    int saved = errno;
    if (fclose(file) != 0) { ok = false; saved = errno; }
    errno = saved;
    return ok ? true : io_error("persist journal file");
}
/* Only the inactive generation is touched before the manifest commit. */
static bool switch_generation(unsigned slot, const char *project, const char *template) {
    char project_copy[JOURNAL_ID_MAX], template_copy[JOURNAL_ID_MAX];
    strcpy(project_copy, project);
    strcpy(template_copy, template);
    char target[PATH_CAP], manifest[PATH_CAP], temporary[PATH_CAP];
    char text[MANIFEST_MAX];
    if (!generation_path(target, slot) || !path_for(manifest, "current.json") ||
        !path_for(temporary, "current.tmp")) return false;
    int length = snprintf(text, sizeof(text),
        "{\"schema_version\":1,\"generation\":%u,\"project_id\":\"%s\",\"template_id\":\"%s\"}\n",
        slot, project, template);
    if (length < 0 || (size_t)length >= sizeof(text)) return fail("manifest too large");
    if (!durable_file(target, NULL, 0) || !sync_directory() ||
        !durable_file(temporary, text, (size_t)length) || !sync_directory()) return false;
    if (rename(temporary, manifest) != 0) return io_error("commit journal manifest");
    /* The rename is the commit point: publish its already prepared state. */
    cJSON_Delete(state.last_begin);
    memset(&state, 0, sizeof(state));
    strcpy(state.project_id, project_copy);
    strcpy(state.template_id, template_copy);
    generation = slot;
    strcpy(log_path, target);
    state.writable = true;
    if (!sync_directory()) {
        state.writable = false;
        return false;
    }
    /* Cleanup cannot change the outcome of an already committed reset. */
    char old[PATH_CAP];
    if (generation_path(old, slot ^ 1u)) (void)unlink(old);
    return true;
}

static bool truncate_tail(size_t offset) {
    int fd = open(log_path, O_WRONLY);
    if (fd < 0) return io_error("open tail for rollback");
    bool ok = ftruncate(fd, (off_t)offset) == 0 && fsync(fd) == 0;
    int saved = errno;
    if (close(fd) != 0) { ok = false; saved = errno; }
    errno = saved;
    return ok ? true : io_error("truncate journal tail");
}
static bool replay(void) {
    FILE *file = fopen(log_path, "rb");
    if (!file) return io_error("open selected journal generation");
    char line[JOURNAL_LINE_MAX + 1];
    size_t length = 0;
    bool oversized = false, incomplete = false, ok = true;
    int ch;
    while ((ch = fgetc(file)) != EOF) {
        incomplete = true;
        if (length < JOURNAL_LINE_MAX) line[length++] = (char)ch;
        else oversized = true;
        if (ch != '\n') continue;
        if (oversized) { ok = fail("complete journal line exceeds 4096 bytes"); break; }
        cJSON *event = parse_exact(line, length - 1);
        journal_state_t next;
        if (!event) { ok = fail("malformed complete journal line %u", state.lines + 1); break; }
        if (!transition(event, &next)) { cJSON_Delete(event); ok = false; break; }
        if (SIZE_MAX - state.bytes < length) {
            cJSON_Delete(event); ok = fail("journal byte counter exhausted"); break;
        }
        next.bytes += length;
        if (!strcmp(string_field(event, "type"), "TAKE_BEGIN")) {
            cJSON_Delete(state.last_begin);
            next.last_begin = event;
        } else cJSON_Delete(event);
        state = next;
        length = 0;
        incomplete = false;
    }
    if (ferror(file)) ok = io_error("read journal history");
    if (fclose(file) != 0 && ok) ok = io_error("close journal history");
    if (ok && incomplete) ok = truncate_tail(state.bytes);
    return ok;
}

#ifdef ESP_PLATFORM
static bool mount_littlefs(const char *root) {
    static char mounted_root[PATH_CAP];
    if (mounted_root[0])
        return !strcmp(mounted_root, root) ? true : fail("LittleFS already mounted at another root");
    esp_vfs_littlefs_conf_t config = {
        .base_path = root, .partition_label = "journal", .format_if_mount_failed = false
    };
    esp_err_t result = esp_vfs_littlefs_register(&config);
    if (result == ESP_OK) { strcpy(mounted_root, root); return true; }
    const esp_partition_t *partition = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "journal");
    if (!partition) return fail("LittleFS journal partition missing");
    uint8_t block[256];
    for (size_t offset = 0; offset < partition->size; offset += sizeof(block)) {
        size_t count = partition->size - offset;
        if (count > sizeof(block)) count = sizeof(block);
        if (esp_partition_read(partition, offset, block, count) != ESP_OK)
            return fail("cannot prove LittleFS partition erased");
        for (size_t i = 0; i < count; ++i)
            if (block[i] != 0xff) return fail("LittleFS mount failed; non-erased partition preserved");
    }
    if (esp_littlefs_format("journal") != ESP_OK)
        return fail("format erased LittleFS partition failed");
    result = esp_vfs_littlefs_register(&config);
    if (result == ESP_OK) { strcpy(mounted_root, root); return true; }
    return fail("mount formatted LittleFS failed: %d", (int)result);
}
#endif

bool journal_open(const char *root) {
    opened = false;
    cJSON_Delete(state.last_begin);
    memset(&state, 0, sizeof(state));
    error_text[0] = '\0';
    if (!root || !*root || strlen(root) >= sizeof(root_path) - 32)
        return fail("invalid journal root");
#ifdef ESP_PLATFORM
    if (!mount_littlefs(root)) return false;
#else
    struct stat directory;
    if (stat(root, &directory) != 0) return io_error("stat journal root");
    if (!S_ISDIR(directory.st_mode)) return fail("journal root is not a directory");
#endif
    strcpy(root_path, root);
    char path[PATH_CAP];
    if (!path_for(path, "current.json")) return false;
    FILE *file = fopen(path, "rb");
    if (!file) {
        if (errno != ENOENT) return io_error("open journal manifest");
        /* An absent manifest is fresh only if no published generation exists. */
        for (unsigned slot = 0; slot < 2; ++slot) {
            struct stat existing;
            if (!generation_path(path, slot)) return false;
            int result = stat(path, &existing);
            if (result == 0 && existing.st_size != 0)
                return fail("manifest missing beside nonempty journal; preserving files");
            if (result != 0 && errno != ENOENT)
                return io_error("stat unselected generation");
        }
        if (!switch_generation(0, "", "")) return false;
    } else {
        char text[MANIFEST_MAX + 1];
        size_t length = fread(text, 1, sizeof(text), file);
        bool ok = !ferror(file);
        if (fclose(file) != 0) ok = false;
        if (!ok) return io_error("read journal manifest");
        if (!length || length > MANIFEST_MAX) return fail("invalid manifest length");
        cJSON *manifest = parse_exact(text, length);
        double version, slot;
        if (!manifest || !number_field(manifest, "schema_version", 1, &version) || version != 1 ||
            !number_field(manifest, "generation", 1, &slot) ||
            !id_field(manifest, "project_id", JOURNAL_ID_MAX, true) ||
            !id_field(manifest, "template_id", JOURNAL_ID_MAX, true) ||
            (!!*string_field(manifest, "project_id") != !!*string_field(manifest, "template_id"))) {
            cJSON_Delete(manifest);
            return fail("invalid current journal manifest");
        }
        generation = (unsigned)slot;
        strcpy(state.project_id, string_field(manifest, "project_id"));
        strcpy(state.template_id, string_field(manifest, "template_id"));
        cJSON_Delete(manifest);
        if (!generation_path(log_path, generation) || !replay()) return false;
        state.writable = true;
    }
    opened = true;
    return true;
}
bool journal_init_project(const char *project, const char *template) {
    error_text[0] = '\0';
    if (!opened || !state.writable) return fail("journal is not writable");
    if (!journal_id_valid(project, JOURNAL_ID_MAX, false) ||
        !journal_id_valid(template, JOURNAL_ID_MAX, false)) return fail("invalid project/template ID");
    if (!strcmp(project, state.project_id) && !strcmp(template, state.template_id)) return true;
    if (state.take_id) return fail("nonempty project requires explicit RESET");
    return switch_generation(generation ^ 1u, project, template);
}

bool journal_space(size_t *total, size_t *used) {
    if (!opened) return fail("journal is not open");
    size_t capacity, occupied;
#ifdef ESP_PLATFORM
    if (esp_littlefs_info("journal", &capacity, &occupied) != ESP_OK)
        return fail("cannot query LittleFS space");
#else
    struct statvfs info;
    if (statvfs(root_path, &info) != 0) return io_error("query journal space");
    if (info.f_frsize && info.f_blocks > SIZE_MAX / info.f_frsize)
        return fail("filesystem capacity exceeds size_t");
    capacity = (size_t)info.f_blocks * info.f_frsize;
    size_t available = (size_t)info.f_bavail * info.f_frsize;
    occupied = capacity >= available ? capacity - available : capacity;
#endif
    if (total) *total = capacity;
    if (used) *used = occupied;
    return true;
}
static bool reserve_space(size_t begin_bytes) {
    size_t total, used;
    if (!journal_space(&total, &used)) return false;
    if (begin_bytes > SIZE_MAX - JOURNAL_RESERVE_BYTES || used > total ||
        total - used < JOURNAL_RESERVE_BYTES + begin_bytes)
        return fail("insufficient space: BEGIN requires 8192-byte reserve");
    return true;
}
bool journal_can_begin(void) {
    if (!opened || !state.writable || !state.project_id[0]) return fail("journal is not ready");
    if (state.unfinished) return fail("previous take is unfinished");
    /* The caller has not built BEGIN yet; append checks its exact byte size. */
    return reserve_space(1);
}
static bool set_field(cJSON *event, const char *name, cJSON *value) {
    if (!value) return false;
    cJSON_DeleteItemFromObjectCaseSensitive(event, name);
    if (cJSON_AddItemToObject(event, name, value)) return true;
    cJSON_Delete(value);
    return false;
}

bool journal_append(cJSON *event) {
    error_text[0] = '\0';
    if (!opened || !state.writable) return fail("journal is not writable");
    if (!cJSON_IsObject(event) || state.event_seq == UINT32_MAX)
        return fail("invalid event or exhausted sequence");
    if (!set_field(event, "schema_version", cJSON_CreateNumber(1)) ||
        !set_field(event, "project_id", cJSON_CreateString(state.project_id)) ||
        !set_field(event, "template_id", cJSON_CreateString(state.template_id)) ||
        !set_field(event, "event_seq", cJSON_CreateNumber((double)state.event_seq + 1)))
        return fail("allocate event metadata failed");
    journal_state_t next;
    if (!transition(event, &next)) return false;
    bool begin = !strcmp(string_field(event, "type"), "TAKE_BEGIN");
    cJSON *saved_begin = begin ? cJSON_Duplicate(event, true) : NULL;
    if (begin && !saved_begin) return fail("allocate latest BEGIN failed");
    char *text = cJSON_PrintUnformatted(event);
    if (!text) { cJSON_Delete(saved_begin); return fail("serialize journal event failed"); }
    size_t length = strlen(text);
    if (length >= JOURNAL_LINE_MAX || SIZE_MAX - state.bytes < length + 1) {
        cJSON_free(text); cJSON_Delete(saved_begin);
        return fail("event exceeds journal line or byte limit");
    }
    if (begin && !reserve_space(length + 1)) {
        cJSON_free(text); cJSON_Delete(saved_begin); return false;
    }
    struct stat disk;
    if (stat(log_path, &disk) != 0 || disk.st_size < 0 || (uint64_t)disk.st_size != state.bytes) {
        cJSON_free(text); cJSON_Delete(saved_begin);
        state.writable = false;
        return fail("journal tail differs from committed state; reopen required");
    }
    FILE *file = fopen(log_path, "ab");
    if (!file) { cJSON_free(text); cJSON_Delete(saved_begin); return io_error("open journal append"); }
    bool ok = fwrite(text, 1, length, file) == length && fputc('\n', file) != EOF &&
        fflush(file) == 0 && fsync(fileno(file)) == 0;
    int saved = errno;
    if (fclose(file) != 0) { ok = false; saved = errno; }
    cJSON_free(text);
    if (!ok) {
        cJSON_Delete(saved_begin);
        if (!truncate_tail(state.bytes)) {
            state.writable = false;
            return fail("append failed and rollback uncertain; reopen required");
        }
        errno = saved;
        return io_error("append rolled back");
    }
    next.bytes += length + 1;
    if (begin) {
        cJSON_Delete(state.last_begin);
        next.last_begin = saved_begin;
    }
    state = next;
    return true;
}

bool journal_export(FILE *out, uint32_t after_seq) {
    error_text[0] = '\0';
    if (!opened || !out) return fail("journal or export stream unavailable");
    FILE *file = fopen(log_path, "rb");
    if (!file) return io_error("open journal export");
    char line[JOURNAL_LINE_MAX + 1];
    size_t remaining = state.bytes;
    bool ok = true;
    while (remaining) {
        size_t length = 0;
        int ch = 0;
        while (length < JOURNAL_LINE_MAX && length < remaining && (ch = fgetc(file)) != EOF) {
            line[length++] = (char)ch;
            if (ch == '\n') break;
        }
        if (!length || line[length - 1] != '\n') { ok = fail("export encountered invalid committed tail"); break; }
        cJSON *event = parse_exact(line, length - 1);
        double seq;
        if (!event || !number_field(event, "event_seq", UINT32_MAX, &seq)) {
            cJSON_Delete(event); ok = fail("export encountered malformed record"); break;
        }
        cJSON_Delete(event);
        line[length - 1] = '\n';
        if (seq > after_seq && fwrite(line, 1, length, out) != length) {
            ok = io_error("write journal export"); break;
        }
        remaining -= length;
    }
    if (ferror(file) && ok) ok = io_error("read journal export");
    if (fclose(file) != 0 && ok) ok = io_error("close journal export");
    return ok;
}

bool journal_reset(const char *project, uint32_t seq, uint32_t take, uint32_t lines, size_t bytes) {
    error_text[0] = '\0';
    if (!opened || !state.writable) return fail("journal is not writable");
    if (!project || strcmp(project, state.project_id) || seq != state.event_seq ||
        take != state.take_id || lines != state.lines || bytes != state.bytes)
        return fail("RESET backup tuple does not match committed journal");
    return switch_generation(generation ^ 1u, "", "");
}

void journal_reader_close(journal_reader_t *reader) {
    if(!reader)return;
    if(reader->file)fclose(reader->file);
    memset(reader,0,sizeof(*reader));
}
bool journal_reader_open(journal_reader_t *reader,uint32_t after_seq) {
    if(!reader || reader->file)return fail("invalid or already open journal reader");
    if(!opened || after_seq>state.event_seq)return fail("invalid journal cursor or unavailable journal");
    FILE *file=fopen(log_path,"rb");
    if(!file)return io_error("open journal snapshot");
    reader->file=file;
    reader->snapshot=state;
    reader->snapshot.last_begin=NULL;
    reader->remaining=state.bytes;
    reader->after_seq=after_seq;
    reader->previous_seq=0;
    reader->generation=generation;
    return true;
}
journal_read_result_t journal_reader_next(journal_reader_t *reader,
                                         char line[JOURNAL_LINE_MAX+1],size_t *length) {
    if(length)*length=0;
    if(!reader || !reader->file || !line || !length) {
        fail("invalid journal reader");return JOURNAL_READ_ERROR;
    }
    if(!opened || reader->generation!=generation ||
       strcmp(reader->snapshot.project_id,state.project_id) ||
       state.event_seq<reader->snapshot.event_seq || state.bytes<reader->snapshot.bytes) {
        fail("project changed during journal snapshot");return JOURNAL_READ_ERROR;
    }
    if(!reader->remaining)return JOURNAL_READ_END;
    size_t used=0;int ch=0;
    while(used<JOURNAL_LINE_MAX && used<reader->remaining &&
          (ch=fgetc(reader->file))!=EOF) {
        line[used++]=(char)ch;
        if(ch=='\n')break;
    }
    if(!used || line[used-1]!='\n') {
        fail("invalid committed snapshot line");return JOURNAL_READ_ERROR;
    }
    cJSON *event=parse_exact(line,used-1);
    double seq=0;
    const char *project=event?string_field(event,"project_id"):NULL;
    bool valid=project && !strcmp(project,reader->snapshot.project_id) &&
        number_field(event,"event_seq",UINT32_MAX,&seq) &&
        seq>reader->previous_seq && seq<=reader->snapshot.event_seq;
    cJSON_Delete(event);
    if(!valid) { fail("invalid journal snapshot identity or order");return JOURNAL_READ_ERROR; }
    reader->previous_seq=(uint32_t)seq;
    reader->remaining-=used;
    line[used-1]='\n';line[used]='\0';*length=used;
    return seq>reader->after_seq?JOURNAL_READ_EVENT:JOURNAL_READ_SKIP;
}
