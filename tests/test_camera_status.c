#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ui.h"
#include "command_logic.h"
#include "status_logic.h"
camera_state_t g_camera_states[NUM_CAMERAS];
ui_state_t g_ui_state;
int g_current_wake_camera_index=-1;
uint16_t generate_seq(void) { return 1; }
connect_state_t connect_logic_get_state(void) { return PROTOCOL_CONNECTED; }
CommandResult send_command(int slot,uint8_t a,uint8_t b,uint8_t c,const void *d,uint16_t e,int f) {
    (void)slot;(void)a;(void)b;(void)c;(void)d;(void)e;(void)f;
    return (CommandResult){0};
}
esp_err_t command_logic_send_snapshot_key_for_slot(int slot) { (void)slot;return ESP_OK; }
void wake_queue_notify_camera_woke_up(int slot) { (void)slot; }
static void push(uint8_t status,uint8_t power) {
    camera_status_push_command_frame *frame=calloc(1,sizeof(*frame));
    assert(frame);
    frame->camera_mode=CAMERA_MODE_NORMAL;
    frame->camera_status=status;
    frame->power_mode=power;
    update_camera_state_handler(0,frame); /* Handler owns and frees frame. */
}
int main(void) {
    push(CAMERA_STATUS_PHOTO_OR_RECORDING,0);
    assert(g_camera_states[0].is_recording);
    /* Link loss invalidates derived flags but leaves raw status cached. */
    g_camera_states[0].is_initialized=false;
    g_camera_states[0].is_recording=false;
    push(CAMERA_STATUS_PHOTO_OR_RECORDING,0);
    assert(g_camera_states[0].is_initialized && g_camera_states[0].is_recording);
    push(CAMERA_STATUS_PRE_RECORDING,3);
    assert(g_camera_states[0].is_recording && g_camera_states[0].is_sleeping);
    g_camera_states[0].is_initialized=false;
    g_camera_states[0].is_recording=false;
    g_camera_states[0].is_sleeping=false;
    push(CAMERA_STATUS_PRE_RECORDING,3);
    assert(g_camera_states[0].is_recording && g_camera_states[0].is_sleeping);
    push(CAMERA_STATUS_SCREEN_OFF,0);
    assert(!g_camera_states[0].is_recording && !g_camera_states[0].is_sleeping);
    puts("camera_status: reconnect regression tests passed");
}
