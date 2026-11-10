#include "capture.h"
#include <stddef.h>
#include <string.h>

static bool id_valid(const char *id, size_t capacity, bool empty) {
    if (!id || (!empty && !id[0])) return false;
    for (size_t i = 0; i < capacity; ++i) {
        unsigned char ch = (unsigned char)id[i];
        if (!ch) return true;
        if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
              (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' || ch == '.')) return false;
    }
    return false;
}

static void set_reason(capture_t *c, const char *reason) {
    strcpy(c->reason, reason);
}

static bool elapsed(uint64_t now, uint64_t since, uint64_t duration) {
    return now >= since && now - since >= duration;
}

bool capture_fresh(const cap_sample_t *s, uint64_t now) {
    return s && s->connected && s->valid && now >= s->status_ms &&
           now - s->status_ms <= CAP_STALE_MS;
}

uint8_t capture_ready_mask(const cap_sample_t samples[2], uint64_t now) {
    uint8_t mask = 0;
    for (int i = 0; i < 2; ++i) {
        /* A cached recording bit is a safety veto, even when status is stale. */
        if (samples[i].connected && samples[i].recording) return 0;
        if (capture_fresh(&samples[i], now) && samples[i].video && !samples[i].sleeping)
            mask |= (uint8_t)(1u << i);
    }
    return mask;
}

void capture_init(capture_t *c, cap_emit_fn emit, cap_dispatch_fn dispatch, void *ctx) {
    *c = (capture_t){.phase = CAP_IDLE, .emit = emit, .dispatch = dispatch, .ctx = ctx};
}

bool capture_active(const capture_t *c) {
    return c && c->phase != CAP_IDLE;
}

static bool involved(const cap_evidence_t *e) {
    return e->participating || e->seen_recording;
}

static void observe_samples(capture_t *c, const cap_sample_t samples[2], uint64_t now) {
    bool active = capture_active(c);
    for (int i = 0; i < 2; ++i) {
        const cap_sample_t *s = &samples[i];
        cap_evidence_t *e = &c->cameras[i];
        bool fresh = capture_fresh(s, now);
        bool newer = s->connected && s->valid && s->status_ms <= now &&
                     s->status_ms > e->last_sample_ms;
        if (active && c->previous[i].connected && !s->connected) {
            e->disconnected = true;
            ++e->disconnect_count;
        }
        if (active && !c->previous[i].connected && s->connected) {
            e->reconnected = true;
            ++e->reconnect_count;
        }
        e->final_connected = s->connected;
        if (s->connected && s->valid && now >= s->status_ms &&
            now - s->status_ms > CAP_STALE_MS) e->stale = true;
        if (!fresh) {
            e->unknown = true;
            e->stop_confirmed = false;
            if (active && involved(e)) c->observation_lost = true;
        }
        if (newer) {
            e->last_sample_ms = s->status_ms;
            /* Idle pushes reset the camera timer; retain the last recording
             * observation as matching evidence in TAKE_END. */
            if (s->recording || !e->seen_recording) e->record_time = s->record_time;
            e->battery = s->battery;
            e->final_recording = s->recording;
            /* Reconnecting with an unchanged cached sample is not observation. */
            if (fresh) e->unknown = false;
            if (active && s->recording) {
                if ((e->seen_recording && e->stopped_ms > e->last_record_ms) ||
                    !e->participating) e->restarted = true;
                if (!e->seen_recording) e->first_record_ms = s->status_ms;
                e->seen_recording = true;
                e->last_record_ms = s->status_ms;
                e->stop_confirmed = false;
            } else if (active && fresh && !s->recording && involved(e)) {
                bool after_stop = c->phase == CAP_STOPPING &&
                                  s->status_ms > c->stop_requested_ms && s->status_ms > e->stop_ms;
                bool after_start = c->phase != CAP_STOPPING &&
                                   s->status_ms > c->begin_ms;
                if (after_stop || after_start) {
                    e->stop_confirmed = true;
                    e->stopped_ms = s->status_ms;
                    if (e->seen_recording && c->phase != CAP_STOPPING) e->unexpected_stop = true;
                }
            }
        }
        if (active && involved(e) && e->unknown) c->observation_lost = true;
        c->previous[i] = *s;
    }
}

bool capture_begin(capture_t *c, const cap_sample_t samples[2], uint64_t now,
                   uint32_t take_id, const char *command_id, const char *action_id,
                   const char *point_id, const char *boot_id, const char *source) {
    if (!c || c->phase != CAP_IDLE || !take_id || !source || !c->emit) return false;
    bool external = strcmp(source, "external") == 0;
    if ((!external && strcmp(source, "boot") && strcmp(source, "usb") && strcmp(source, "ble")) ||
        !id_valid(command_id, CAP_ID_MAX, false) ||
        !id_valid(action_id, CAP_ACTION_MAX, external) ||
        !id_valid(point_id, CAP_ACTION_MAX, true) ||
        !id_valid(boot_id, CAP_ID_MAX, false)) return false;
    uint8_t mask = 0;
    if (external) {
        for (int i = 0; i < 2; ++i)
            if (samples[i].connected && samples[i].valid && samples[i].recording &&
                samples[i].status_ms <= now) mask |= (uint8_t)(1u << i);
    } else {
        mask = capture_ready_mask(samples, now);
    }
    if (!mask) return false;

    capture_t next = {.phase = external ? CAP_RECORDING : CAP_STARTING,
                      .take_id = take_id, .begin_ms = now, .participants = mask,
                      .emit = c->emit, .dispatch = c->dispatch, .ctx = c->ctx};
    strcpy(next.command_id, command_id);
    strcpy(next.action_id, action_id);
    strcpy(next.point_id, point_id);
    strcpy(next.boot_id, boot_id);
    strcpy(next.source, source);
    for (int i = 0; i < 2; ++i) {
        const cap_sample_t *s = &samples[i];
        cap_evidence_t *e = &next.cameras[i];
        e->participating = (mask & (1u << i)) != 0;
        e->final_connected = s->connected;
        e->final_recording = s->recording;
        e->unknown = !capture_fresh(s, now);
        e->stale = s->connected && s->valid && now >= s->status_ms &&
                   now - s->status_ms > CAP_STALE_MS;
        if (s->valid && s->status_ms <= now) {
            e->last_sample_ms = s->status_ms;
            e->record_time = s->record_time;
            e->battery = s->battery;
        }
        if (external && e->participating) {
            e->seen_recording = true;
            e->first_record_ms = e->last_record_ms = s->status_ms;
            if (e->unknown) next.observation_lost = true;
        }
        next.previous[i] = *s;
    }
    /* Leave even the previous completed take untouched on append failure. */
    if (!next.emit(next.ctx, "TAKE_BEGIN", &next)) return false;
    *c = next;
    if (!external) {
        for (int i = 0; i < 2; ++i) {
            cap_evidence_t *e = &c->cameras[i];
            if (!e->participating) continue;
            e->start_ms = now;
            e->start_sent = c->dispatch && c->dispatch(c->ctx, i, true);
            e->start_failed = !e->start_sent;
        }
    }
    return true;
}

static void request_stop(capture_t *c, const cap_sample_t samples[2], uint64_t now) {
    c->phase = CAP_STOPPING;
    c->stop_requested_ms = now;
    for (int i = 0; i < 2; ++i) {
        cap_evidence_t *e = &c->cameras[i];
        /* STOP is a safety command, not gated by normal-video/readiness status. */
        if (samples[i].connected) {
            e->stop_ms = now;
            e->stop_sent = c->dispatch && c->dispatch(c->ctx, i, false);
            e->stop_failed = !e->stop_sent;
        } else if (involved(e)) {
            e->stop_failed = true;
            e->unknown = true;
        }
        if (involved(e)) e->stop_confirmed = false;
    }
}

bool capture_stop(capture_t *c, const cap_sample_t samples[2], uint64_t now) {
    if (!c || c->phase == CAP_IDLE) return false;
    if (c->phase == CAP_CLOSING) {
        /* Storage failure must not prevent a physical safety STOP. Keep the
         * pending END byte-for-byte unchanged for its next append attempt. */
        for (int i = 0; i < 2; ++i)
            if (samples[i].connected && c->dispatch) c->dispatch(c->ctx, i, false);
        return true;
    }
    if (c->phase == CAP_STOPPING) return true;
    observe_samples(c, samples, now);
    if (!c->reason[0]) set_reason(c, c->phase == CAP_STARTING ? "cancelled" : "stopped");
    request_stop(c, samples, now);
    return true;
}

static bool all_stopped(const capture_t *c) {
    for (int i = 0; i < 2; ++i) {
        const cap_evidence_t *e = &c->cameras[i];
        if (involved(e) && (!e->stop_confirmed || e->unknown || e->final_recording)) return false;
    }
    return true;
}
static bool stop_confirmed_in_time(const capture_t *c) {
    for (int i = 0; i < 2; ++i) {
        const cap_evidence_t *e = &c->cameras[i];
        if (involved(e) && (e->stopped_ms <= c->stop_requested_ms ||
            e->stopped_ms - c->stop_requested_ms >= CAP_TIMEOUT_MS)) return false;
    }
    return true;
}


static bool any_recorded(const capture_t *c) {
    return c->cameras[0].seen_recording || c->cameras[1].seen_recording;
}

static bool all_started(const capture_t *c) {
    for (int i = 0; i < 2; ++i) {
        const cap_evidence_t *e = &c->cameras[i];
        if (e->participating && (!e->seen_recording || e->unknown || e->first_record_ms <= e->start_ms ||
            e->first_record_ms < c->begin_ms ||
            e->first_record_ms - c->begin_ms >= CAP_TIMEOUT_MS)) return false;
    }
    return true;
}

static bool take_complete(const capture_t *c) {
    if (c->observation_lost || c->recovered || strcmp(c->reason, "stopped")) return false;
    bool external = strcmp(c->source, "external") == 0;
    for (int i = 0; i < 2; ++i) {
        const cap_evidence_t *e = &c->cameras[i];
        if (!involved(e)) continue;
        if (!e->participating || !e->seen_recording || !e->stop_confirmed || e->unknown ||
            e->start_failed || e->stop_failed || e->disconnected || e->reconnected ||
            e->stale || e->unexpected_stop || e->restarted || (!external && !e->start_sent)) return false;
    }
    return true;
}

static void retry_end(capture_t *c) {
    if (c->emit && c->emit(c->ctx, "TAKE_END", c)) c->phase = CAP_IDLE;
}

static void close_take(capture_t *c, uint64_t now) {
    c->close_ms = now;
    c->complete = take_complete(c);
    c->phase = CAP_CLOSING;
    retry_end(c);
}

void capture_observe(capture_t *c, const cap_sample_t samples[2], uint64_t now) {
    if (!c) return;
    if (c->phase == CAP_CLOSING) {
        /* An END retry is the identical event, including its evidence and time. */
        retry_end(c);
        return;
    }
    observe_samples(c, samples, now);
    if (c->phase == CAP_IDLE) return;
    if (c->phase == CAP_STARTING) {
        if (all_started(c)) {
            c->phase = CAP_RECORDING;
        } else if (elapsed(now, c->begin_ms, CAP_TIMEOUT_MS)) {
            set_reason(c, "start_timeout");
            if (any_recorded(c)) c->phase = CAP_RECORDING;
            else request_stop(c, samples, now);
        }
    }
    if (c->phase == CAP_RECORDING && any_recorded(c) && all_stopped(c)) {
        if (!c->reason[0]) set_reason(c, "unexpected_stop");
        close_take(c, now);
    } else if (c->phase == CAP_STOPPING) {
        if (all_stopped(c) && stop_confirmed_in_time(c)) {
            close_take(c, now);
        } else if (elapsed(now, c->stop_requested_ms, CAP_TIMEOUT_MS)) {
            set_reason(c, "stop_timeout");
            close_take(c, now);
        }
    }
}

int capture_led(const capture_t *c, int slot, const cap_sample_t *s, uint64_t now) {
    if (!s || !s->connected) return 0;
    const cap_evidence_t *e = c && slot >= 0 && slot < 2 ? &c->cameras[slot] : NULL;
    if (!capture_fresh(s, now) || s->sleeping || !s->video || (e && e->unknown)) return 3;
    if (c && c->phase == CAP_CLOSING) return 3;
    if (c && e && capture_active(c) &&
        (((c->phase == CAP_STARTING || c->phase == CAP_STOPPING) && involved(e)) ||
         e->start_failed || e->stop_failed || e->unexpected_stop || e->restarted)) return 3;
    return s->recording ? 2 : 1;
}
