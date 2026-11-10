#include <assert.h>
#include <stdio.h>
#include "dual_control.h"

int main(void) {
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
    puts("BOOT debounce: all tests passed");
}
