#define _POSIX_C_SOURCE 200809L
#include "control_service.h"
#include "journal.h"
#include <assert.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static cap_sample_t cameras[2];
static unsigned starts[2], stops[2];
static cJSON *last_reply;
static char root[64];

static bool dispatch(void *ctx, int slot, bool start) {
    (void)ctx;
    assert(slot >= 0 && slot < 2);
    if (start) assert(journal_state()->unfinished); /* START must be durable; safety STOP need not be. */
    if (start) ++starts[slot]; else ++stops[slot];
    return true;
}
static void reply(void *ctx, const char *json, size_t length) {
    (void)ctx; (void)length;
    cJSON_Delete(last_reply);
    last_reply = cJSON_Parse(json);
    assert(last_reply);
}
static void command(const char *json, control_transport_t transport, uint64_t now) {
    cJSON *request = cJSON_Parse(json);
    assert(request);
    const control_request_t origin = {.transport=transport, .reply=reply};
    control_service_command(request, cameras, now, &origin);
    cJSON_Delete(request);
}
static unsigned field(const cJSON *object, const char *name) {
    const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, name);
    assert(cJSON_IsNumber(value));
    return (unsigned)value->valueint;
}
static void snapshot(uint64_t now, unsigned target, unsigned active) {
    cJSON *state = control_service_status(cameras, now);
    assert(state);
    assert(field(state, "target_cameras") == target);
    assert(field(state, "active_participants") == active);
    cJSON_Delete(state);
}
static cap_sample_t ready(uint64_t now) {
    return (cap_sample_t){.connected=true, .valid=true, .video=true, .status_ms=now};
}
static void setup(void) {
    strcpy(root, "/tmp/dji-selection-XXXXXX");
    assert(mkdtemp(root) && journal_open(root));
    memset(starts, 0, sizeof(starts)); memset(stops, 0, sizeof(stops));
    cameras[0] = cameras[1] = ready(100);
    control_service_init("selection-boot", dispatch, NULL, NULL);
    command("{\"cmd\":\"INIT_PROJECT\",\"project_id\":\"P\",\"template_id\":\"T\"}", CONTROL_USB, 100);
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(last_reply, "ok")));
}
static void cleanup(void) {
    DIR *directory = opendir(root);
    assert(directory);
    struct dirent *entry;
    while ((entry = readdir(directory))) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        char path[512];
        assert(snprintf(path, sizeof(path), "%s/%s", root, entry->d_name) < (int)sizeof(path));
        assert(unlink(path) == 0);
    }
    closedir(directory); assert(rmdir(root) == 0);
    cJSON_Delete(last_reply); last_reply = NULL;
}
static void stop_take(uint64_t now) {
    char json[128];
    snprintf(json, sizeof(json), "{\"cmd\":\"STOP\",\"project_id\":\"P\",\"take_id\":%u}", journal_state()->take_id);
    command(json, CONTROL_BLE, now);
    cameras[0].recording = cameras[1].recording = false;
    cameras[0].status_ms = cameras[1].status_ms = now + 1;
    control_service_observe(cameras, now + 1);
    assert(!control_service_active());
}
static void test_strict_default_and_durable_single_target(void) {
    setup(); snapshot(100, 3, 0);
    /* A legacy selection still means explicit default dual, never auto-single. */
    command("{\"cmd\":\"SELECT_ACTION\",\"project_id\":\"P\",\"action_id\":\"D1\"}", CONTROL_USB, 100);
    cameras[1].connected = false;
    command("{\"cmd\":\"START\",\"project_id\":\"P\",\"command_id\":\"reject-dual\"}", CONTROL_BLE, 101);
    assert(!starts[0] && !starts[1] && journal_state()->take_id == 0);
    control_service_button(cameras, 102);
    assert(!starts[0] && journal_state()->take_id == 0);
    command("{\"cmd\":\"SELECT_ACTION\",\"project_id\":\"P\",\"action_id\":\"D1\",\"target_cameras\":1}", CONTROL_BLE, 103);
    assert(field(last_reply, "target_cameras") == 1);
    assert(journal_open(root)); control_service_init("reboot", dispatch, NULL, NULL);
    snapshot(104, 1, 0);
    command("{\"cmd\":\"START\",\"project_id\":\"P\",\"command_id\":\"a-only\",\"target_cameras\":1}", CONTROL_BLE, 105);
    assert(starts[0] == 1 && !starts[1]); snapshot(105, 1, 1);
    assert(field(journal_state()->last_begin, "participants") == 1);
    uint32_t seq = journal_state()->event_seq;
    command("{\"cmd\":\"SELECT_ACTION\",\"project_id\":\"P\",\"action_id\":\"D1\",\"target_cameras\":2}", CONTROL_USB, 106);
    assert(journal_state()->event_seq == seq); snapshot(106, 1, 1);
    stop_take(107);
    assert(stops[0] == 1 && !stops[1]); snapshot(108, 1, 0);
    command("{\"cmd\":\"START\",\"project_id\":\"P\",\"command_id\":\"a-only\",\"target_cameras\":1}", CONTROL_BLE, 109);
    assert(starts[0] == 1 && journal_state()->take_id == 1);
    cleanup();
}
static void test_both_online_single_slot_and_stop_isolation(void) {
    for (unsigned target = 1; target <= 2; ++target) {
        setup();
        char selection[160];
        snprintf(selection, sizeof(selection), "{\"cmd\":\"SELECT_ACTION\",\"project_id\":\"P\",\"action_id\":\"D1\",\"target_cameras\":%u}", target);
        command(selection, CONTROL_USB, 100);
        control_service_button(cameras, 101);
        unsigned chosen = target == 1 ? 0 : 1, other = chosen ^ 1u;
        assert(starts[chosen] == 1 && !starts[other]); snapshot(101, target, target);
        cameras[chosen].recording = true; cameras[chosen].status_ms = 102;
        control_service_observe(cameras, 102);
        stop_take(103);
        assert(stops[chosen] == 1 && !stops[other]);
        FILE *log = tmpfile();
        assert(log && journal_export(log, journal_state()->event_seq - 1));
        rewind(log);
        char line[JOURNAL_LINE_MAX + 1];
        assert(fgets(line, sizeof(line), log));
        cJSON *ended = cJSON_Parse(line);
        assert(ended && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(ended, "complete")));
        const cJSON *evidence = cJSON_GetObjectItemCaseSensitive(ended, "cameras");
        assert(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(cJSON_GetArrayItem(evidence, other), "participating")));
        assert(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(cJSON_GetArrayItem(evidence, other), "seen_recording")));
        cJSON_Delete(ended); fclose(log);
        cleanup();
    }
}
static void test_invalid_targets_and_stale_start_intent(void) {
    setup();
    command("{\"cmd\":\"SELECT_ACTION\",\"project_id\":\"P\",\"action_id\":\"D1\",\"target_cameras\":2}", CONTROL_BLE, 100);
    uint32_t seq = journal_state()->event_seq;
    const char *invalid[] = {"0", "4", "-1", "1.5", "true", "null", "\"1\""};
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        char json[200];
        snprintf(json, sizeof(json), "{\"cmd\":\"SELECT_ACTION\",\"project_id\":\"P\",\"action_id\":\"D2\",\"target_cameras\":%s}", invalid[i]);
        command(json, CONTROL_BLE, 101);
        assert(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(last_reply, "ok")));
        assert(journal_state()->event_seq == seq && !strcmp(journal_state()->action_id, "D1"));
        snapshot(101, 2, 0);
        snprintf(json, sizeof(json), "{\"cmd\":\"START\",\"project_id\":\"P\",\"command_id\":\"invalid\",\"target_cameras\":%s}", invalid[i]);
        command(json, CONTROL_USB, 101);
        assert(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(last_reply, "ok")));
        assert(journal_state()->take_id == 0 && !starts[0] && !starts[1]);
    }
    command("{\"cmd\":\"SELECT_ACTION\",\"project_id\":\"P\",\"action_id\":\"D2\"}", CONTROL_USB, 102);
    snapshot(102, 2, 0); /* Omission retains committed target. */
    command("{\"cmd\":\"START\",\"project_id\":\"P\",\"command_id\":\"stale-intent\",\"target_cameras\":1}", CONTROL_BLE, 103);
    assert(!strcmp(cJSON_GetObjectItemCaseSensitive(last_reply, "error")->valuestring, "target_mismatch"));
    assert(journal_state()->take_id == 0 && !starts[0] && !starts[1]);
    cleanup();
}
static void test_external_recording_preserves_selected_target(void) {
    setup();
    command("{\"cmd\":\"SELECT_ACTION\",\"project_id\":\"P\",\"action_id\":\"D1\",\"target_cameras\":2}", CONTROL_USB, 100);
    cameras[0].recording = true; cameras[0].status_ms = 101;
    control_service_observe(cameras, 101);
    snapshot(101, 2, 1);
    assert(!starts[0] && !starts[1]);
    cameras[0].recording = false; cameras[0].status_ms = 102;
    control_service_observe(cameras, 102);
    assert(!control_service_active()); snapshot(102, 2, 0);
    assert(journal_open(root)); control_service_init("external-reboot", dispatch, NULL, NULL);
    snapshot(103, 2, 0);
    cleanup();
}
static void test_safety_stop_without_journal_ignores_idle_peer(void) {
    setup();
    assert(journal_reset("P",0,0,0,0));
    cameras[0].recording=true;cameras[0].status_ms=101;
    control_service_button(cameras,101);
    assert(stops[0]==1 && stops[1]==0);
    assert(!starts[0] && !starts[1]);
    assert(!control_service_active() && !journal_state()->unfinished);
    assert(journal_state()->event_seq==0 && journal_state()->take_id==0);
    cleanup();
}
static void test_explicit_stop_after_timeout_keeps_closed_evidence(void) {
    setup();
    command("{\"cmd\":\"SELECT_ACTION\",\"project_id\":\"P\",\"action_id\":\"D1\",\"target_cameras\":1}",CONTROL_USB,100);
    control_service_button(cameras,101);
    cameras[0].recording=true;cameras[0].status_ms=102;
    control_service_observe(cameras,102);
    command("{\"cmd\":\"STOP\",\"project_id\":\"P\",\"take_id\":1}",CONTROL_BLE,110);
    cameras[0].status_ms=6110;cameras[1].status_ms=6110;
    control_service_observe(cameras,6110);
    assert(!control_service_active() && !journal_state()->unfinished);
    unsigned seq=journal_state()->event_seq;
    size_t bytes=journal_state()->bytes;
    command("{\"cmd\":\"STOP\",\"project_id\":\"P\",\"take_id\":0}",CONTROL_BLE,6111);
    assert(stops[0]==1 && stops[1]==0);
    command("{\"cmd\":\"STOP\",\"project_id\":\"P\",\"take_id\":1}",CONTROL_BLE,6112);
    assert(stops[0]==2 && stops[1]==0);
    assert(journal_state()->event_seq==seq && journal_state()->bytes==bytes);
    cleanup();
}
int main(void) {
    test_strict_default_and_durable_single_target();
    test_both_online_single_slot_and_stop_isolation();
    test_invalid_targets_and_stale_start_intent();
    test_external_recording_preserves_selected_target();
    test_safety_stop_without_journal_ignores_idle_peer();
    test_explicit_stop_after_timeout_keeps_closed_evidence();
    puts("camera selection: strict admission, durable intent and isolated dispatch passed");
    return 0;
}
