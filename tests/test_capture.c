#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "capture.h"

typedef struct {
    capture_t cap;
    capture_t begin, end;
    bool fail_begin;
    unsigned fail_ends;
    unsigned begins, end_attempts, ends;
    unsigned starts[2], stops[2];
    bool start_ok[2], stop_ok[2];
    unsigned order[64], order_count;
} fixture_t;

static void trace(fixture_t *f, unsigned value) {
    assert(f->order_count < sizeof(f->order) / sizeof(f->order[0]));
    f->order[f->order_count++] = value;
}

static bool emit(void *ctx, const char *type, const capture_t *take) {
    fixture_t *f = ctx;
    assert(take->ctx == f);
    if (!strcmp(type, "TAKE_BEGIN")) {
        trace(f, 1);
        assert(!take->cameras[0].start_sent && !take->cameras[1].start_sent);
        if (f->fail_begin) return false;
        ++f->begins;
        f->begin = *take;
        return true;
    }
    assert(!strcmp(type, "TAKE_END"));
    assert(take->phase == CAP_CLOSING);
    trace(f, 2);
    ++f->end_attempts;
    f->end = *take;
    if (f->fail_ends) {
        --f->fail_ends;
        return false;
    }
    ++f->ends;
    return true;
}

static bool dispatch(void *ctx, int slot, bool start) {
    fixture_t *f = ctx;
    assert(slot == 0 || slot == 1);
    assert(f->begins); /* A successful durable BEGIN must precede every send. */
    assert(f->cap.take_id == f->begin.take_id);
    trace(f, (start ? 10u : 20u) + (unsigned)slot);
    if (start) {
        ++f->starts[slot];
        return f->start_ok[slot];
    }
    ++f->stops[slot];
    return f->stop_ok[slot];
}

static void setup(fixture_t *f) {
    memset(f, 0, sizeof(*f));
    f->start_ok[0] = f->start_ok[1] = true;
    f->stop_ok[0] = f->stop_ok[1] = true;
    capture_init(&f->cap, emit, dispatch, f);
}

static cap_sample_t ready(uint64_t timestamp) {
    return (cap_sample_t){.connected = true, .valid = true, .video = true,
                          .status_ms = timestamp, .battery = 73};
}

static void status(cap_sample_t *s, uint64_t timestamp, bool recording, uint16_t timer) {
    s->status_ms = timestamp;
    s->recording = recording;
    s->record_time = timer;
}

static bool begin(fixture_t *f, cap_sample_t s[2], uint64_t now, uint32_t take_id) {
    return capture_begin(&f->cap, s, now, take_id, "cmd-1", "walk", "point.1", "boot_1", "usb", 3);
}

static void test_durable_begin(void) {
    fixture_t f;
    setup(&f);
    cap_sample_t s[2] = {ready(100), ready(100)};
    f.fail_begin = true;
    assert(!begin(&f, s, 100, 1));
    assert(f.cap.phase == CAP_IDLE && !capture_active(&f.cap));
    assert(!f.starts[0] && !f.starts[1] && !f.begins);
    assert(f.cap.emit == emit && f.cap.dispatch == dispatch && f.cap.ctx == &f);
    f.fail_begin = false;
    assert(begin(&f, s, 100, 1));
    assert(f.order[1] == 1 && f.order[2] == 10 && f.order[3] == 11);
    assert(f.cap.phase == CAP_STARTING && capture_active(&f.cap));
    assert(f.cap.cameras[0].start_sent && f.cap.cameras[1].start_sent);
    assert(!f.cap.cameras[0].seen_recording && !f.cap.cameras[1].seen_recording);
    assert(!begin(&f, s, 101, 2));
    assert(f.begins == 1);
}

static void test_single_ready_and_veto(void) {
    for (unsigned variant = 0; variant < 5; ++variant) {
        fixture_t f;
        setup(&f);
        cap_sample_t s[2] = {ready(5000), ready(5000)};
        switch (variant) {
        case 0: s[1].connected = false; break;
        case 1: s[1].sleeping = true; break;
        case 2: s[1].video = false; break;
        case 3: s[1].valid = false; break;
        default: s[1].status_ms = 1; break;
        }
        assert(capture_ready_mask(s, 5000) == 1);
        assert(!begin(&f, s, 5000, 1));
        assert(!f.begins && !f.starts[0] && !f.starts[1]);
        assert(capture_begin(&f.cap, s, 5000, 1, "cmd-1", "walk", "point.1", "boot_1", "usb", 1));
        assert(f.cap.participants == 1);
        assert(f.starts[0] == 1 && !f.starts[1]);
        assert(f.cap.cameras[0].participating && !f.cap.cameras[1].participating);
    }
    cap_sample_t s[2] = {ready(5000), ready(1)};
    s[1].recording = true;
    assert(!capture_ready_mask(s, 5000));
    s[1].valid = false;
    assert(!capture_ready_mask(s, 5000));
    s[1].connected = false;
    assert(capture_ready_mask(s, 5000) == 1);
    assert(capture_fresh(&s[0], 8000));
    assert(!capture_fresh(&s[0], 8001));
    assert(!capture_fresh(&s[0], 4999));
}

static void test_cancel_starting(void) {
    fixture_t f;
    setup(&f);
    cap_sample_t s[2] = {ready(100), ready(100)};
    assert(begin(&f, s, 100, 1));
    assert(capture_stop(&f.cap, s, 110));
    assert(f.cap.phase == CAP_STOPPING && f.cap.take_id == 1);
    assert(f.stops[0] == 1 && f.stops[1] == 1 && f.begins == 1);
    assert(!strcmp(f.cap.reason, "cancelled"));
    assert(capture_stop(&f.cap, s, 500));
    assert(f.cap.stop_requested_ms == 110);
    assert(f.stops[0] == 1 && f.stops[1] == 1);
    capture_observe(&f.cap, s, 501);
    assert(f.cap.phase == CAP_STOPPING && !f.ends);
    status(&s[0], 111, false, 0);
    status(&s[1], 112, false, 0);
    capture_observe(&f.cap, s, 502);
    assert(f.cap.phase == CAP_IDLE && f.ends == 1 && !f.end.complete);
    assert(f.end.cameras[0].stopped_ms == 111 && f.end.cameras[1].stopped_ms == 112);
    assert(!capture_stop(&f.cap, s, 503));
}

static void test_new_status_confirmation_and_sample_times(void) {
    fixture_t f;
    setup(&f);
    cap_sample_t s[2] = {ready(100), ready(100)};
    assert(begin(&f, s, 100, 1));
    s[0].recording = s[1].recording = true;
    capture_observe(&f.cap, s, 101);
    assert(f.cap.phase == CAP_STARTING);
    assert(!f.cap.cameras[0].seen_recording && !f.cap.cameras[1].seen_recording);
    status(&s[0], 101, true, 7);
    status(&s[1], 102, true, 11);
    capture_observe(&f.cap, s, 120);
    assert(f.cap.phase == CAP_RECORDING);
    assert(f.cap.cameras[0].first_record_ms == 101 && f.cap.cameras[1].first_record_ms == 102);
    status(&s[0], 121, true, 9);
    status(&s[1], 122, true, 13);
    capture_observe(&f.cap, s, 150);
    assert(f.cap.cameras[0].last_record_ms == 121 && f.cap.cameras[0].record_time == 9);
    assert(f.cap.cameras[1].last_record_ms == 122 && f.cap.cameras[1].record_time == 13);
    assert(capture_stop(&f.cap, s, 160));
    s[0].recording = s[1].recording = false;
    capture_observe(&f.cap, s, 161); /* Optimistic local flags cannot confirm STOP. */
    assert(f.cap.phase == CAP_STOPPING);
    status(&s[0], 162, false, 0);
    status(&s[1], 163, false, 0);
    capture_observe(&f.cap, s, 180);
    assert(f.ends == 1 && f.end.complete && f.cap.phase == CAP_IDLE);
    assert(f.end.cameras[0].stop_ms == 160 && f.end.cameras[0].stopped_ms == 162);
    assert(f.end.cameras[1].stopped_ms == 163);
    assert(f.end.cameras[0].record_time == 9 && f.end.cameras[1].record_time == 13);
    assert(f.cap.emit == emit && f.cap.dispatch == dispatch && f.cap.ctx == &f);
}

static void test_partial_success(void) {
    fixture_t f;
    setup(&f);
    f.start_ok[1] = false;
    cap_sample_t s[2] = {ready(100), ready(100)};
    assert(begin(&f, s, 100, 1));
    assert(f.cap.cameras[0].start_sent && !f.cap.cameras[0].start_failed);
    assert(!f.cap.cameras[1].start_sent && f.cap.cameras[1].start_failed);
    status(&s[0], 101, true, 1);
    status(&s[1], 101, false, 0);
    capture_observe(&f.cap, s, 101);
    assert(f.cap.phase == CAP_STARTING);
    status(&s[0], 6100, true, 6);
    status(&s[1], 6100, false, 0);
    capture_observe(&f.cap, s, 6100);
    assert(f.cap.phase == CAP_RECORDING && !strcmp(f.cap.reason, "start_timeout"));
    assert(f.cap.cameras[0].first_record_ms == 101 && f.cap.cameras[0].last_record_ms == 6100);
    assert(!f.stops[0] && !f.stops[1] && !f.ends);
    assert(capture_stop(&f.cap, s, 6200));
    status(&s[0], 6201, false, 6);
    status(&s[1], 6202, false, 0);
    capture_observe(&f.cap, s, 6202);
    assert(f.ends == 1 && !f.end.complete && !strcmp(f.end.reason, "start_timeout"));
    assert(f.end.cameras[0].seen_recording && !f.end.cameras[1].seen_recording);
}

static void test_unconfirmed_start_closes_explicitly(void) {
    fixture_t f;
    setup(&f);
    cap_sample_t s[2] = {ready(100), {0}};
    assert(capture_begin(&f.cap, s, 100, 1, "cmd-1", "walk", "point.1", "boot_1", "usb", 1));
    s[0] = ready(6100);
    capture_observe(&f.cap, s, 6100);
    assert(f.cap.phase == CAP_STOPPING && f.stops[0] == 1 && !f.ends);
    assert(f.cap.take_id == 1 && !strcmp(f.cap.reason, "start_timeout"));
    capture_observe(&f.cap, s, 6101);
    assert(f.cap.phase == CAP_STOPPING); /* Pre-STOP idle is insufficient. */
    status(&s[0], 6102, false, 0);
    capture_observe(&f.cap, s, 6103);
    assert(f.cap.phase == CAP_IDLE && f.ends == 1 && !f.end.complete);
    assert(!strcmp(f.end.reason, "start_timeout"));

    setup(&f);
    s[0] = ready(100);
    assert(capture_begin(&f.cap, s, 100, 1, "cmd-1", "walk", "point.1", "boot_1", "usb", 1));
    capture_observe(&f.cap, s, 6100);
    assert(f.cap.phase == CAP_STOPPING);
    capture_observe(&f.cap, s, 12100);
    assert(f.cap.phase == CAP_IDLE && f.ends == 1 && !f.end.complete);
    assert(!strcmp(f.end.reason, "stop_timeout"));
}

static void test_stop_timeout_and_single_camera_continuation(void) {
    fixture_t f;
    setup(&f);
    cap_sample_t s[2] = {ready(100), ready(100)};
    assert(begin(&f, s, 100, 1));
    status(&s[0], 101, true, 1);
    status(&s[1], 102, true, 1);
    capture_observe(&f.cap, s, 102);
    s[1].connected = false;
    capture_observe(&f.cap, s, 110);
    assert(f.cap.cameras[1].disconnect_count == 1 && f.cap.cameras[1].unknown);
    assert(capture_stop(&f.cap, s, 120));
    status(&s[0], 121, false, 2);
    capture_observe(&f.cap, s, 121);
    assert(f.cap.phase == CAP_STOPPING && f.cap.cameras[0].stop_confirmed);
    status(&s[0], 6120, false, 2);
    capture_observe(&f.cap, s, 6120);
    assert(f.cap.phase == CAP_IDLE && f.ends == 1 && !f.end.complete);
    assert(!strcmp(f.end.reason, "stop_timeout"));
    assert(f.end.cameras[1].unknown && !f.end.cameras[1].stop_confirmed);
    assert(f.end.cameras[1].seen_recording && f.end.observation_lost);
    assert(!begin(&f, s, 6121, 2)); /* Changing to single-camera is explicit. */
    assert(capture_begin(&f.cap, s, 6121, 2, "cmd-2", "walk", "point.1", "boot_1", "usb", 1));
    assert(f.cap.participants == 1 && f.starts[0] == 2 && f.starts[1] == 1);
    assert(f.cap.ctx == &f && f.cap.emit == emit && f.cap.dispatch == dispatch);
    assert(!f.cap.cameras[0].seen_recording && !f.cap.cameras[0].start_failed);
}

static void test_unknown_fresh_idle_recovery(void) {
    fixture_t f;
    setup(&f);
    cap_sample_t s[2] = {ready(100), {0}};
    assert(capture_begin(&f.cap, s, 100, 1, "cmd-1", "walk", "point.1", "boot_1", "usb", 1));
    status(&s[0], 101, true, 8);
    capture_observe(&f.cap, s, 102);
    s[0].connected = false;
    capture_observe(&f.cap, s, 103);
    assert(f.cap.cameras[0].unknown && f.cap.cameras[0].disconnect_count == 1);
    assert(capture_led(&f.cap, 0, &s[0], 103) == 0);
    s[0].connected = true;
    capture_observe(&f.cap, s, 104);
    assert(f.cap.cameras[0].unknown && f.cap.cameras[0].reconnect_count == 1);
    assert(!f.cap.cameras[0].stop_confirmed);
    status(&s[0], 105, true, 10);
    capture_observe(&f.cap, s, 110);
    assert(!f.cap.cameras[0].unknown && f.cap.cameras[0].last_record_ms == 105);
    assert(capture_stop(&f.cap, s, 120));
    capture_observe(&f.cap, s, 6120);
    assert(f.cap.phase == CAP_IDLE && f.cap.cameras[0].unknown && f.cap.cameras[0].stale);
    status(&s[0], 6121, false, 10);
    capture_observe(&f.cap, s, 6122);
    assert(!f.cap.cameras[0].unknown && !f.cap.cameras[0].final_recording);
    assert(f.cap.cameras[1].unknown);
    assert(capture_led(&f.cap, 0, &s[0], 6122) == 1);
    assert(capture_begin(&f.cap, s, 6122, 2, "cmd-2", "walk", "point.1", "boot_1", "usb", 1));
}

static void test_external_recording(void) {
    fixture_t f;
    setup(&f);
    cap_sample_t s[2] = {ready(90), ready(90)};
    status(&s[0], 95, true, 42);
    assert(capture_begin(&f.cap, s, 100, 1, "external.1", "", "", "boot_1", "external", 3));
    assert(f.cap.phase == CAP_RECORDING && f.cap.participants == 1);
    assert(!f.starts[0] && !f.starts[1] && !f.cap.action_id[0]);
    assert(f.cap.cameras[0].seen_recording && f.cap.cameras[0].first_record_ms == 95);
    assert(f.cap.cameras[0].record_time == 42);
    assert(capture_led(&f.cap, 0, &s[0], 100) == 2);
    status(&s[0], 110, false, 43);
    capture_observe(&f.cap, s, 120);
    assert(f.cap.phase == CAP_IDLE && f.ends == 1 && !f.stops[0]);
    assert(f.end.cameras[0].stop_confirmed && f.end.cameras[0].stopped_ms == 110);
    assert(f.end.cameras[0].unexpected_stop);
    assert(!capture_begin(&f.cap, s, 121, 2, "external.2", "", "", "boot_1", "external", 3));
    assert(!capture_begin(&f.cap, s, 121, 2, "cmd", "", "", "boot_1", "usb", 3));
}

static void test_unexpected_stop_restart_and_autonomous_end(void) {
    fixture_t f;
    setup(&f);
    cap_sample_t s[2] = {ready(100), ready(100)};
    assert(begin(&f, s, 100, 1));
    status(&s[0], 101, true, 10);
    status(&s[1], 102, true, 10);
    capture_observe(&f.cap, s, 102);
    status(&s[0], 110, false, 11);
    capture_observe(&f.cap, s, 111);
    assert(f.cap.phase == CAP_RECORDING && !f.ends);
    assert(f.cap.cameras[0].unexpected_stop && f.cap.cameras[0].stop_confirmed);
    status(&s[0], 120, true, 0);
    capture_observe(&f.cap, s, 121);
    assert(f.cap.cameras[0].restarted && !f.cap.cameras[0].stop_confirmed);
    assert(f.cap.cameras[0].first_record_ms == 101 && f.cap.cameras[0].last_record_ms == 120);
    status(&s[0], 130, false, 1);
    status(&s[1], 131, false, 12);
    capture_observe(&f.cap, s, 140);
    assert(f.cap.phase == CAP_IDLE && f.ends == 1 && !f.end.complete);
    assert(f.end.cameras[0].restarted && f.end.cameras[1].unexpected_stop);
    assert(!f.stops[0] && !f.stops[1]);

    setup(&f);
    s[0] = ready(100);
    s[1] = ready(100);
    s[1].video = false;
    assert(capture_begin(&f.cap, s, 100, 1, "cmd-1", "walk", "point.1", "boot_1", "usb", 1));
    status(&s[0], 101, true, 1);
    status(&s[1], 102, true, 1);
    capture_observe(&f.cap, s, 102);
    assert(f.cap.participants == 1 && !f.cap.cameras[1].participating);
    assert(f.cap.cameras[1].seen_recording && f.cap.cameras[1].restarted);
    status(&s[0], 110, false, 2);
    capture_observe(&f.cap, s, 110);
    assert(f.cap.phase == CAP_RECORDING); /* An independent peer clip is not ignored. */
    status(&s[1], 111, false, 2);
    capture_observe(&f.cap, s, 111);
    assert(f.cap.phase == CAP_IDLE && !f.end.complete);
}

static void test_end_append_retry(void) {
    fixture_t f;
    setup(&f);
    cap_sample_t s[2] = {ready(100), {0}};
    assert(capture_begin(&f.cap, s, 100, 1, "cmd-1", "walk", "point.1", "boot_1", "usb", 1));
    status(&s[0], 101, true, 1);
    capture_observe(&f.cap, s, 101);
    assert(capture_stop(&f.cap, s, 110));
    f.fail_ends = 2;
    status(&s[0], 111, false, 2);
    capture_observe(&f.cap, s, 112);
    assert(f.cap.phase == CAP_CLOSING && f.end_attempts == 1 && !f.ends);
    capture_t pending = f.end;
    assert(!begin(&f, s, 113, 2));
    status(&s[0], 114, true, 0);
    s[1] = ready(114);
    s[1].recording = true;
    s[1].sleeping = true;
    s[1].video = false;
    assert(capture_stop(&f.cap, s, 114));
    assert(f.stops[0] == 2 && f.stops[1] == 1);
    assert(!memcmp(&pending, &f.cap, sizeof(pending)));
    capture_observe(&f.cap, s, 114);
    assert(f.cap.phase == CAP_CLOSING && f.end_attempts == 2);
    assert(!memcmp(&pending, &f.end, sizeof(pending)));
    capture_observe(&f.cap, s, 115);
    assert(f.cap.phase == CAP_IDLE && f.end_attempts == 3 && f.ends == 1);
    assert(!memcmp(&pending, &f.end, sizeof(pending)));
    assert(!begin(&f, s, 115, 2)); /* A late recording still vetoes a new take. */
    status(&s[0], 116, false, 1);
    status(&s[1], 116, false, 1);
    capture_observe(&f.cap, s, 116);
    assert(f.end_attempts == 3 && f.ends == 1);
    assert(capture_begin(&f.cap, s, 116, 2, "cmd-2", "walk", "point.1", "boot_1", "usb", 1));
}

static void test_stop_deadline_and_leds(void) {
    fixture_t f;
    setup(&f);
    cap_sample_t s[2] = {ready(100), {0}};
    assert(capture_led(&f.cap, 0, &s[0], 100) == 1);
    assert(capture_led(&f.cap, 1, &s[1], 100) == 0);
    assert(capture_begin(&f.cap, s, 100, 1, "cmd-1", "walk", "point.1", "boot_1", "usb", 1));
    assert(capture_led(&f.cap, 0, &s[0], 100) == 3);
    status(&s[0], 101, true, 1);
    capture_observe(&f.cap, s, 101);
    assert(capture_led(&f.cap, 0, &s[0], 101) == 2);
    assert(capture_stop(&f.cap, s, 110));
    assert(capture_stop(&f.cap, s, 6109));
    assert(f.cap.stop_requested_ms == 110 && f.stops[0] == 1);
    status(&s[0], 6110, false, 2);
    capture_observe(&f.cap, s, 6110);
    assert(f.cap.phase == CAP_IDLE && !f.end.complete && !strcmp(f.end.reason, "stop_timeout"));
    s[0].sleeping = true;
    assert(capture_led(&f.cap, 0, &s[0], 6110) == 3);
    s[0].sleeping = false;
    s[0].video = false;
    assert(capture_led(&f.cap, 0, &s[0], 6110) == 3);
}

static void test_status_between_stop_request_and_dispatch(void) {
    fixture_t f;setup(&f);
    cap_sample_t s[2]={ready(100),{0}};
    assert(capture_begin(&f.cap,s,100,1,"cmd-1","walk","point.1","boot_1","usb",1));
    assert(capture_stop(&f.cap,s,110));
    /* Application dispatcher stamps actual call time after any queue/fsync delay. */
    f.cap.cameras[0].stop_ms=150;
    status(&s[0],120,false,0);
    capture_observe(&f.cap,s,151);
    assert(f.cap.phase==CAP_STOPPING && !f.cap.cameras[0].stop_confirmed);
    status(&s[0],152,false,0);
    capture_observe(&f.cap,s,152);
    assert(f.cap.phase==CAP_IDLE && f.end.cameras[0].stopped_ms==152);
}

static void test_explicit_stop_covers_late_recording_peer(void) {
    fixture_t f;setup(&f);
    cap_sample_t s[2]={ready(100),ready(100)};
    assert(capture_begin(&f.cap,s,100,1,"cmd-1","walk","point.1","boot_1","usb",1));
    status(&s[0],101,true,1);
    capture_observe(&f.cap,s,101);
    assert(capture_stop(&f.cap,s,110));
    assert(f.stops[0]==1 && f.stops[1]==0);
    status(&s[1],120,true,1);
    assert(capture_stop(&f.cap,s,120));
    assert(f.stops[0]==1 && f.stops[1]==1);
    assert(f.cap.stop_requested_ms==110 && f.cap.participants==1);
    assert(f.cap.cameras[1].seen_recording && !f.cap.cameras[1].participating);
    assert(capture_stop(&f.cap,s,121));
    assert(f.stops[0]==1 && f.stops[1]==1);
    status(&s[0],122,false,0);status(&s[1],122,false,0);
    capture_observe(&f.cap,s,122);
    assert(f.cap.phase==CAP_IDLE && f.end.cameras[1].stop_sent);
}

int main(void) {
    test_durable_begin();
    test_single_ready_and_veto();
    test_cancel_starting();
    test_new_status_confirmation_and_sample_times();
    test_partial_success();
    test_unconfirmed_start_closes_explicitly();
    test_stop_timeout_and_single_camera_continuation();
    test_unknown_fresh_idle_recovery();
    test_external_recording();
    test_unexpected_stop_restart_and_autonomous_end();
    test_end_append_retry();
    test_stop_deadline_and_leds();
    test_status_between_stop_request_and_dispatch();
    test_explicit_stop_covers_late_recording_peer();
    puts("capture: all behavior tests passed");
    return 0;
}
