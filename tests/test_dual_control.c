#include <assert.h>
#include <stdio.h>
#include "dual_control.h"

static dc_camera_t ready(uint32_t now) {
    return (dc_camera_t){.connected=true,.valid=true,.video=true,.status_ms=now};
}
int main(void) {
    dc_camera_t c[2] = {ready(100), ready(100)};
    dc_control_t ctl = {0};
    assert(dc_begin(&ctl, c, 100, DC_TOGGLE) == DC_SEND_START);
    assert(dc_begin(&ctl, c, 101, DC_TOGGLE) == DC_BUSY);
    assert(dc_poll(&ctl, c, 101) == DC_PENDING);
    c[0].recording=c[1].recording=true;
    assert(dc_poll(&ctl, c, 102) == DC_PENDING); /* old push cannot confirm */
    c[0].status_ms=c[1].status_ms=103;
    assert(dc_poll(&ctl,c,103)==DC_CONFIRMED);
    c[1].connected=false;
    assert(dc_begin(&ctl,c,104,DC_TOGGLE)==DC_SEND_STOP);
    c[0].recording=false; c[0].status_ms=105;
    assert(dc_poll(&ctl,c,105)==DC_PARTIAL);
    c[1]=ready(105);
    c[0]=ready(105);
    assert(dc_begin(&ctl,c,5000,DC_START)==DC_REJECTED); /* stale */
    c[0]=c[1]=ready(5001); c[1].sleeping=true;
    assert(dc_begin(&ctl,c,5001,DC_START)==DC_REJECTED);
    c[1].sleeping=false; c[1].video=false;
    assert(dc_begin(&ctl,c,5001,DC_START)==DC_REJECTED);
    c[1].video=true;
    assert(dc_begin(&ctl,c,5001,DC_START)==DC_SEND_START);
    assert(dc_poll(&ctl,c,11002)==DC_TIMEOUT);
    c[0]=c[1]=ready(11003);
    assert(dc_begin(&ctl,c,11003,DC_START)==DC_SEND_START);
    c[0].recording=c[1].recording=true;
    c[0].status_ms=c[1].status_ms=18000;
    assert(dc_poll(&ctl,c,18000)==DC_TIMEOUT); /* late status cannot rescue expired request */
    c[0]=c[1]=ready(18001);
    assert(dc_begin(&ctl,c,18001,DC_START)==DC_SEND_START);
    c[0].connected=false;
    assert(dc_poll(&ctl,c,18002)==DC_FAILED);
    dc_disconnect(&c[0]);
    assert(!c[0].valid && !c[0].recording && !c[0].connected);
    c[0]=c[1]=ready(UINT32_MAX-10);
    assert(dc_begin(&ctl,c,UINT32_MAX-10,DC_START)==DC_SEND_START);
    c[0].recording=c[1].recording=true; c[0].status_ms=c[1].status_ms=2;
    assert(dc_poll(&ctl,c,3)==DC_CONFIRMED); /* clock wrap */
    dc_button_t b={0};
    assert(!dc_button_update(&b,true,0)); /* boot held must release */
    assert(!dc_button_update(&b,true,100));
    assert(!dc_button_update(&b,false,101));
    assert(!dc_button_update(&b,false,150));
    assert(!dc_button_update(&b,true,151));
    assert(!dc_button_update(&b,false,160)); /* bounce */
    assert(!dc_button_update(&b,true,170));
    assert(!dc_button_update(&b,true,210));
    assert(!dc_button_update(&b,false,220));
    assert(dc_button_update(&b,false,260)); /* one event on release */
    assert(!dc_button_update(&b,false,300));
    puts("dual_control: all tests passed");
}
