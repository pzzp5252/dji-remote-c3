#ifndef HEADLESS_PHONE_SERVICE_H
#define HEADLESS_PHONE_SERVICE_H
#include "capture.h"
/* Runs on the same main/control task as USB, BOOT, capture and journal. */
void phone_service_poll(const cap_sample_t cameras[2], uint64_t now_ms);
#endif
