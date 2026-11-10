#include "dual_control.h"

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
