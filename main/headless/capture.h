#ifndef HEADLESS_CAPTURE_H
#define HEADLESS_CAPTURE_H
#include <stdbool.h>
#include <stdint.h>
#define CAP_ID_MAX 64
#define CAP_ACTION_MAX 32
#define CAP_STALE_MS 3000u
#define CAP_TIMEOUT_MS 6000u

typedef struct {
    bool connected, valid, recording, video, sleeping;
    uint64_t status_ms;
    uint16_t record_time;
    uint8_t battery;
} cap_sample_t;
typedef struct {
    bool participating, start_sent, start_failed, stop_sent, stop_failed;
    bool seen_recording, stop_confirmed, disconnected, reconnected, stale;
    bool unexpected_stop, restarted, unknown;
    bool final_connected, final_recording;
    uint32_t disconnect_count, reconnect_count;
    uint64_t start_ms, stop_ms, first_record_ms, last_record_ms, stopped_ms;
    uint64_t last_sample_ms;
    uint16_t record_time;
    uint8_t battery;
} cap_evidence_t;
typedef enum { CAP_IDLE, CAP_STARTING, CAP_RECORDING, CAP_STOPPING, CAP_CLOSING } cap_phase_t;
typedef struct capture capture_t;
typedef bool (*cap_emit_fn)(void *ctx, const char *type, const capture_t *take);
typedef bool (*cap_dispatch_fn)(void *ctx, int slot, bool start);
struct capture {
    cap_phase_t phase;
    uint32_t take_id;
    char command_id[CAP_ID_MAX], action_id[CAP_ACTION_MAX], point_id[CAP_ACTION_MAX];
    char boot_id[CAP_ID_MAX], source[16], reason[32];
    uint64_t begin_ms, stop_requested_ms, close_ms;
    uint8_t participants;
    bool complete, recovered, observation_lost;
    cap_evidence_t cameras[2];
    cap_sample_t previous[2];
    cap_emit_fn emit;
    cap_dispatch_fn dispatch;
    void *ctx;
};
void capture_init(capture_t *, cap_emit_fn, cap_dispatch_fn, void *);
bool capture_fresh(const cap_sample_t *, uint64_t now);
/* Idle + no connected camera reporting recording + at least one ready camera. */
uint8_t capture_ready_mask(const cap_sample_t samples[2], uint64_t now);
/* Emits durable BEGIN before dispatch, requiring every selected camera ready.
 * source=external observes actual recording without START and may lack action. */
bool capture_begin(capture_t *, const cap_sample_t[2], uint64_t now,
                   uint32_t take_id, const char *command_id, const char *action_id,
                   const char *point_id, const char *boot_id, const char *source,
                   uint8_t target_cameras);
/* STOP can supersede STARTING. Repeated STOP does not reset its deadline. */
bool capture_stop(capture_t *, const cap_sample_t[2], uint64_t now);
/* Called with status transitions and periodically; never writes in BLE callback.
 * Emits END only once; append failure stays CLOSING and retries without new IDs. */
void capture_observe(capture_t *, const cap_sample_t[2], uint64_t now);
bool capture_active(const capture_t *);
/* 0 off, 1 steady, 2 recording slow flash, 3 attention fast flash. */
int capture_led(const capture_t *, int slot, const cap_sample_t *, uint64_t now);
#endif
