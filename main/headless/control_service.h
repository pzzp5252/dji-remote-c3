#ifndef HEADLESS_CONTROL_SERVICE_H
#define HEADLESS_CONTROL_SERVICE_H
#include "capture.h"
#include "cJSON.h"
#include <stddef.h>
typedef enum { CONTROL_USB, CONTROL_BLE } control_transport_t;
typedef struct {
    control_transport_t transport;
    void (*reply)(void *ctx, const char *json, size_t length);
    void *ctx;
} control_request_t;
/* All calls on the headless control task; no Flash work on BLE callbacks. */
void control_service_init(const char *boot_id, cap_dispatch_fn dispatch, void *ctx,
                          uint64_t (*clock_ms)(void));
void control_service_observe(const cap_sample_t samples[2], uint64_t now);
void control_service_observation_lost(void);
void control_service_button(const cap_sample_t samples[2], uint64_t now);
/* Borrowed JSON object; all callers run on the control task. NULL/invalid
 * objects produce an error. RESET/serial exports are USB-only. */
void control_service_command(const cJSON *command, const cap_sample_t samples[2],
                             uint64_t now, const control_request_t *request);
/* Caller owns returned JSON. No Flash writes. */
cJSON *control_service_status(const cap_sample_t samples[2], uint64_t now);
bool control_service_active(void);
int control_service_led(int slot, const cap_sample_t *sample, uint64_t now);
#endif
