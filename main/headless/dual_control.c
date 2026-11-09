#include "dual_control.h"

static bool fresh(const dc_camera_t *c,uint32_t now) {
    return c->connected && c->valid && (uint32_t)(now-c->status_ms)<=DC_STALE_MS;
}
dc_result_t dc_begin(dc_control_t *ctl,const dc_camera_t c[2],uint32_t now,dc_request_t request) {
    if (ctl->pending) return DC_BUSY;
    bool any_recording=false;
    for (int i=0;i<2;i++) if (c[i].valid && c[i].recording) any_recording=true;
    bool start=request==DC_START || (request==DC_TOGGLE && !any_recording);
    uint8_t mask=0;
    for (int i=0;i<2;i++) {
        if (start) {
            if (!fresh(&c[i],now) || c[i].sleeping || !c[i].video || c[i].recording) return DC_REJECTED;
            mask|=(uint8_t)(1u<<i);
        } else if (c[i].connected && !c[i].sleeping) {
            /* Stop even an online camera with stale/unknown state. */
            mask|=(uint8_t)(1u<<i);
        }
    }
    if (!mask) return DC_REJECTED;
    *ctl=(dc_control_t){.pending=true,.target=start,.started_ms=now,.mask=mask};
    return start?DC_SEND_START:DC_SEND_STOP;
}
dc_result_t dc_poll(dc_control_t *ctl,const dc_camera_t c[2],uint32_t now) {
    if (!ctl->pending) return DC_REJECTED;
    bool confirmed=true;
    for (int i=0;i<2;i++) if (ctl->mask&(1u<<i)) {
        if (!c[i].connected) { ctl->pending=false; return DC_FAILED; }
        /* Require a post-command status push, never an optimistic local update. */
        uint32_t status_delay=c[i].status_ms-ctl->started_ms;
        if (!fresh(&c[i],now) || c[i].recording!=ctl->target ||
            (int32_t)status_delay<=0 || status_delay>DC_TIMEOUT_MS) confirmed=false;
    }
    if (confirmed) {
        ctl->pending=false;
        return ctl->mask==3?DC_CONFIRMED:DC_PARTIAL;
    }
    if ((uint32_t)(now-ctl->started_ms)>=DC_TIMEOUT_MS) { ctl->pending=false; return DC_TIMEOUT; }
    return DC_PENDING;
}
void dc_disconnect(dc_camera_t *c) { *c=(dc_camera_t){0}; }
bool dc_button_update(dc_button_t *b,bool pressed,uint32_t now) {
    if (!b->initialized) {
        *b=(dc_button_t){.initialized=true,.raw=pressed,.stable=pressed,.armed=!pressed,.changed_ms=now};
        return false;
    }
    if (pressed!=b->raw) { b->raw=pressed; b->changed_ms=now; }
    if (b->raw==b->stable || (uint32_t)(now-b->changed_ms)<30) return false;
    b->stable=b->raw;
    if (b->stable) { b->pressed=b->armed; return false; }
    bool event=b->pressed;
    b->pressed=false;
    b->armed=true;
    return event;
}
