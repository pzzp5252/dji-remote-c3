#ifndef DUAL_CONTROL_H
#define DUAL_CONTROL_H
#include <stdbool.h>
#include <stdint.h>
typedef struct { bool initialized,raw,stable,armed,pressed; uint32_t changed_ms; } dc_button_t;
bool dc_button_update(dc_button_t*,bool,uint32_t);
#endif
