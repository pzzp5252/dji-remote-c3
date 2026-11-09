#ifndef DUAL_CONTROL_H
#define DUAL_CONTROL_H
#include <stdbool.h>
#include <stdint.h>
#define DC_CAMERA_COUNT 2
#define DC_STALE_MS 3000u
#define DC_TIMEOUT_MS 6000u
typedef struct { bool connected,valid,video,sleeping,recording; uint32_t status_ms; } dc_camera_t;
typedef enum { DC_TOGGLE, DC_START, DC_STOP } dc_request_t;
typedef enum { DC_REJECTED,DC_BUSY,DC_SEND_START,DC_SEND_STOP,DC_PENDING,DC_CONFIRMED,DC_PARTIAL,DC_TIMEOUT,DC_FAILED } dc_result_t;
typedef struct { bool pending,target; uint32_t started_ms; uint8_t mask; } dc_control_t;
typedef struct { bool initialized,raw,stable,armed,pressed; uint32_t changed_ms; } dc_button_t;
dc_result_t dc_begin(dc_control_t*,const dc_camera_t[2],uint32_t,dc_request_t);
dc_result_t dc_poll(dc_control_t*,const dc_camera_t[2],uint32_t);
void dc_disconnect(dc_camera_t*);
bool dc_button_update(dc_button_t*,bool,uint32_t);
#endif
